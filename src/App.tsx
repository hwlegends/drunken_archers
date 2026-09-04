import { useCallback, useEffect, useRef, useState } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { LobbyPanel } from './components/LobbyPanel';
import { HUD } from './components/hud/HUD';
import { DeathmatchResult } from './components/screens/DeathmatchResult';
import { Instructions } from './components/screens/Instructions';
import { LoadingScreen } from './components/screens/LoadingScreen';
import { MainMenu } from './components/screens/MainMenu';
import { MatchResult } from './components/screens/MatchResult';
import { PauseOverlay } from './components/screens/PauseOverlay';
import { RotatePrompt } from './components/screens/RotatePrompt';
import { audioManager } from './game/AudioManager';
import { useNetStore } from './net/netStore';
import { showsArena } from './state/GameStateMachine';
import { useGameStore } from './state/gameStore';
import type { GameMode } from './types';

/** Below this height in portrait we ask a phone to turn sideways. */
const PORTRAIT_MIN_HEIGHT = 520;

/** Under this width the panel would cost the arena more than it is worth. */
const PANEL_MIN_WIDTH = 900;

function useIsPortraitPhone(): boolean {
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const check = () => {
      const isPortrait = window.innerHeight > window.innerWidth;
      const isSmall = Math.min(window.innerWidth, window.innerHeight) < PORTRAIT_MIN_HEIGHT;
      setPortrait(isPortrait && isSmall);
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);
  return portrait;
}

function useFullscreen(): [boolean, () => void] {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  return [active, toggle];
}

export default function App() {
  const phase = useGameStore((s) => s.phase);
  const mode = useGameStore((s) => s.mode);
  const settings = useGameStore((s) => s.settings);
  const loadProgress = useGameStore((s) => s.loadProgress);
  const matchWinner = useGameStore((s) => s.matchWinner);
  const scores = useGameStore((s) => s.scores);
  const deathmatchScore = useGameStore((s) => s.deathmatchScore);
  const bestScore = useGameStore((s) => s.stats.bestDeathmatchScore);

  const netMatch = useNetStore((s) => s.match);

  const [matchKey, setMatchKey] = useState(0);
  const [panelHidden, setPanelHidden] = useState(() => window.innerWidth < PANEL_MIN_WIDTH);
  const [latency, setLatency] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const portrait = useIsPortraitPhone();
  const [isFullscreen, toggleFullscreen] = useFullscreen();
  const previousMode = useRef<GameMode>('onePlayer');

  /* ---- boot ------------------------------------------------------ */

  useEffect(() => {
    // Nothing is downloaded — art is drawn and audio is synthesised — so the
    // loading screen only covers first paint and the physics engine warming up.
    const store = useGameStore.getState();
    let progress = 0;
    const timer = window.setInterval(() => {
      progress = Math.min(1, progress + 0.18 + Math.random() * 0.16);
      store.setLoadProgress(progress);
      if (progress >= 1) {
        clearInterval(timer);
        store.setPhase('menu');
      }
    }, 110);
    return () => clearInterval(timer);
  }, []);

  // The lobby connects on load and stays connected, so this browser is listed
  // for others the whole time it has the game open — not only while looking at
  // the panel.
  useEffect(() => {
    useNetStore.getState().connect();
  }, []);

  /* ---- audio ----------------------------------------------------- */

  // Browsers require a gesture before any sound. The first interaction of any
  // kind unlocks the context and starts the music if it is enabled.
  useEffect(() => {
    const unlock = async () => {
      const ok = await audioManager.unlock();
      if (!ok) return;
      useGameStore.getState().markAudioUnlocked();
      audioManager.setMusicEnabled(useGameStore.getState().settings.music);
      audioManager.setSfxEnabled(useGameStore.getState().settings.sfx);
      if (useGameStore.getState().settings.music) audioManager.startMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    audioManager.setMusicEnabled(settings.music);
    audioManager.setSfxEnabled(settings.sfx);
  }, [settings.music, settings.sfx]);

  useEffect(() => () => audioManager.destroy(), []);

  /* ---- navigation ------------------------------------------------ */

  const click = useCallback(() => audioManager.play('uiClick'), []);

  const startMatch = useCallback(
    (next: GameMode) => {
      click();
      const store = useGameStore.getState();
      store.startMatch(next);
      previousMode.current = next;
      setMatchKey((k) => k + 1);
      // Deathmatch drops straight into play; the others open with a round intro.
      store.forcePhase(next === 'deathmatch' ? 'playing' : 'roundIntro');
    },
    [click],
  );

  const goHome = useCallback(() => {
    click();
    const store = useGameStore.getState();
    store.clearAnnouncements();
    store.setPhase('menu');
    store.resetMatchState();
    // Walking away from an online match releases the other player too.
    useNetStore.getState().leaveMatch();
    setLatency(null);
    setStalled(false);
  }, [click]);

  const rematch = useCallback(() => {
    const net = useNetStore.getState();
    // Online, the other browser has to tear down and rebuild alongside this
    // one; only the host may call it, because only the host can seed the arena.
    if (net.match?.role === 'host') net.relay({ k: 'restart' });
    startMatch(previousMode.current);
  }, [startMatch]);

  const togglePause = useCallback(() => {
    const store = useGameStore.getState();
    // Online has nothing to pause: the other computer keeps simulating.
    if (store.mode === 'online') return;
    if (store.phase === 'playing') {
      audioManager.play('uiClick');
      store.setPhase('paused');
    } else if (store.phase === 'paused') {
      audioManager.play('uiClick');
      store.setPhase('playing');
    }
  }, []);

  /* ---- online match lifecycle ------------------------------------ */

  // A pairing arriving from the lobby is what starts an online match; there is
  // no menu button for it, because there is nothing to choose.
  useEffect(() => {
    if (!netMatch) return;
    const store = useGameStore.getState();
    store.clearAnnouncements();
    store.startMatch('online');
    previousMode.current = 'online';
    setLatency(null);
    setStalled(false);
    setMatchKey((k) => k + 1);
    store.forcePhase('roundIntro');
  }, [netMatch]);

  // The other player leaving, or dropping, ends it from here as well.
  useEffect(() => {
    if (netMatch) return;
    const store = useGameStore.getState();
    if (store.mode !== 'online' || store.phase === 'menu' || store.phase === 'loading') return;
    store.clearAnnouncements();
    store.forcePhase('menu');
    store.resetMatchState();
    setLatency(null);
    setStalled(false);
  }, [netMatch]);

  // A rematch is the host rebuilding its match; this side has to rebuild too.
  useEffect(
    () =>
      useNetStore.getState().subscribePeer((message) => {
        if (message.k !== 'restart') return;
        const store = useGameStore.getState();
        if (useNetStore.getState().match?.role !== 'guest') return;
        store.clearAnnouncements();
        store.startMatch('online');
        setStalled(false);
        setMatchKey((k) => k + 1);
        store.forcePhase('roundIntro');
      }),
    [],
  );

  if (portrait) return <RotatePrompt />;

  const arenaVisible = showsArena(phase);
  const twoPlayer = mode === 'twoPlayers';
  const online = mode === 'online';

  return (
    <div className="shell">
      <div className="stage">
        {arenaVisible && (
          <GameCanvas
            mode={mode}
            matchKey={matchKey}
            onLatency={online ? setLatency : undefined}
            onStalled={online ? setStalled : undefined}
          />
        )}

        {phase === 'loading' && <LoadingScreen progress={loadProgress} />}

        {(phase === 'menu' || phase === 'instructions') && (
          <MainMenu
            onStart={startMatch}
            onHowToPlay={() => {
              click();
              useGameStore.getState().setPhase('instructions');
            }}
            onFullscreen={() => {
              click();
              toggleFullscreen();
            }}
            isFullscreen={isFullscreen}
          />
        )}

        {phase === 'instructions' && (
          <Instructions
            onClose={() => {
              click();
              useGameStore.getState().setPhase('menu');
            }}
          />
        )}

        {arenaVisible && (
          <HUD
            mode={mode}
            onPause={online ? goHome : togglePause}
            opponent={netMatch?.opponent.name}
            latency={latency}
            stalled={online && stalled}
            showHint={phase === 'roundIntro' || (phase === 'playing' && scores.left + scores.right === 0)}
          />
        )}

        {phase === 'paused' && (
          <PauseOverlay onResume={togglePause} onRestart={rematch} onHome={goHome} />
        )}

        {phase === 'matchResult' && matchWinner && (
          <MatchResult
            winner={matchWinner}
            scores={scores}
            twoPlayer={twoPlayer}
            localSide={netMatch?.side}
            // Only the host can start another: it is the one that seeds the arena.
            canRematch={!online || netMatch?.role === 'host'}
            onRematch={rematch}
            onHome={goHome}
          />
        )}

        {phase === 'deathmatchResult' && (
          <DeathmatchResult
            score={deathmatchScore}
            best={bestScore}
            onRetry={() => startMatch('deathmatch')}
            onHome={goHome}
          />
        )}
      </div>

      <LobbyPanel
        collapsed={panelHidden}
        onToggle={() => {
          click();
          setPanelHidden((v) => !v);
        }}
        latency={latency}
        onLeaveMatch={goHome}
      />
    </div>
  );
}
