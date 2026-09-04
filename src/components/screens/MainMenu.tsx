import { ArcherMark } from '../ArcherMark';
import { useGameStore } from '../../state/gameStore';
import type { GameMode, GameSettings } from '../../types';

interface MainMenuProps {
  onStart: (mode: GameMode) => void;
  onHowToPlay: () => void;
  onFullscreen: () => void;
  isFullscreen: boolean;
}

const TOGGLES: Array<{ key: keyof GameSettings; label: string; on: string; off: string }> = [
  { key: 'music', label: 'Music', on: '♪', off: '✕' },
  { key: 'sfx', label: 'Sound', on: '♫', off: '✕' },
  { key: 'reducedBlood', label: 'Reduced blood', on: '✓', off: '✕' },
];

export function MainMenu({ onStart, onHowToPlay, onFullscreen, isFullscreen }: MainMenuProps) {
  const settings = useGameStore((s) => s.settings);
  const toggleSetting = useGameStore((s) => s.toggleSetting);
  const best = useGameStore((s) => s.stats.bestDeathmatchScore);

  return (
    <div className="menu">
      <div className="menu__logo">
        <ArcherMark side="left" />
        <h1 className="title">
          Drunken
          <br />
          Archers
          <span className="title__sub">Ragdoll Duel</span>
        </h1>
        <ArcherMark side="right" flip />
      </div>

      <div className="menu__buttons">
        <button className="btn btn--primary" onClick={() => onStart('onePlayer')}>
          One Player
        </button>
        <button className="btn" onClick={() => onStart('twoPlayers')}>
          Two Players
        </button>
        <button className="btn btn--accent" onClick={() => onStart('deathmatch')}>
          Deathmatch{best > 0 ? ' · Best ' + best : ''}
        </button>
        <button className="btn btn--ghost" onClick={onHowToPlay}>
          How to Play
        </button>
      </div>

      <p className="menu__online">
        Playing someone on another computer? Challenge them from the players
        panel — no menu button, the match starts when they accept.
      </p>

      <div className="toggles">
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            className="toggle"
            data-on={settings[t.key]}
            aria-pressed={settings[t.key]}
            onClick={() => toggleSetting(t.key)}
          >
            <span aria-hidden="true">{settings[t.key] ? t.on : t.off}</span>
            {t.label}
          </button>
        ))}
        <button className="toggle" data-on={isFullscreen} onClick={onFullscreen}>
          <span aria-hidden="true">⛶</span>
          Fullscreen
        </button>
      </div>
    </div>
  );
}
