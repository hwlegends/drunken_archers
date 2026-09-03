import { useEffect, useRef } from 'react';
import { GameEngine, type EngineEvents } from '../game/GameEngine';
import { audioManager } from '../game/AudioManager';
import { useGameStore } from '../state/gameStore';
import type { GameMode } from '../types';

interface GameCanvasProps {
  mode: GameMode;
  /** Bumping this remounts the match without recreating the canvas element. */
  matchKey: number;
}

/**
 * Owns the imperative game. The engine is created once per match and talks back
 * to React only through low-frequency store writes — no body transform ever
 * becomes component state.
 */
export function GameCanvas({ mode, matchKey }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const store = useGameStore.getState();

    const events: EngineEvents = {
      onHealth: (left, right) => useGameStore.getState().setBothHealth(left, right),
      onScores: (scores) => useGameStore.getState().setScores(scores),
      onRoundIntro: () => useGameStore.getState().setPhase('roundIntro'),
      onPlay: () => useGameStore.getState().setPhase('playing'),
      onAnnounce: (kind, text, duration, side) =>
        useGameStore.getState().announce(kind, text, duration, side),
      onRoundOver: (winner, loser, byHeadshot, byFall, scores) => {
        const s = useGameStore.getState();
        s.recordRound({ winner, loser, byHeadshot, byFall, scores });
        s.setPhase('roundResult');
      },
      onMatchOver: (winner) => {
        const s = useGameStore.getState();
        s.setMatchWinner(winner);
        s.setPhase('matchResult');
      },
      onDeathmatchScore: (score, encounter) => {
        const s = useGameStore.getState();
        s.setDeathmatchScore(score);
        s.setEncounter(encounter);
      },
      onDeathmatchOver: (score) => {
        const s = useGameStore.getState();
        s.setDeathmatchScore(score);
        s.setPhase('deathmatchResult');
      },
      onPauseRequest: () => {
        const s = useGameStore.getState();
        if (s.phase === 'playing') s.setPhase('paused');
        else if (s.phase === 'paused') s.setPhase('playing');
      },
    };

    const engine = new GameEngine(canvas, events);
    engineRef.current = engine;
    engine.resize();
    engine.startMatch(mode, store.settings);

    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    observer?.observe(canvas);

    // Leaving the tab must pause rather than let the world run on unseen.
    const onVisibility = () => {
      if (!document.hidden) return;
      const s = useGameStore.getState();
      if (s.phase === 'playing') s.setPhase('paused');
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      engine.endMatch();
      engine.destroy();
      engineRef.current = null;
    };
    // matchKey forces a completely fresh match on rematch/retry.
  }, [mode, matchKey]);

  // Pause and resume follow the phase, so physics, AI, input and timers all
  // freeze together and resume without a time jump.
  const phase = useGameStore((s) => s.phase);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (phase === 'paused') engine.pause();
    else if (phase === 'playing') engine.resume();
  }, [phase]);

  // Settings are read by the engine when drawing effects, and drive the buses.
  const settings = useGameStore((s) => s.settings);
  useEffect(() => {
    engineRef.current?.applySettings(settings);
    audioManager.setMusicEnabled(settings.music);
    audioManager.setSfxEnabled(settings.sfx);
  }, [settings]);

  return <canvas ref={canvasRef} aria-label="Game arena" />;
}
