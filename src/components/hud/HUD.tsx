import { MATCH } from '../../config/constants';
import { useGameStore } from '../../state/gameStore';
import type { GameMode } from '../../types';
import { Announcements } from './Announcements';

interface HUDProps {
  mode: GameMode;
  onPause: () => void;
  showHint: boolean;
}

const HINTS: Record<GameMode, string> = {
  onePlayer: 'Hold ↑ or press and hold the arena · release to fire',
  twoPlayers: 'Blue: hold W · Orange: hold ↑ · or hold your half of the screen',
  deathmatch: 'Hold ↑ or press and hold the arena · release to fire',
};

/**
 * Score, run counters and the pause button. Health bars are drawn on the canvas
 * above each archer, which keeps their per-frame positions out of React.
 */
export function HUD({ mode, onPause, showHint }: HUDProps) {
  const scores = useGameStore((s) => s.scores);
  const deathmatchScore = useGameStore((s) => s.deathmatchScore);
  const best = useGameStore((s) => s.stats.bestDeathmatchScore);

  return (
    <div className="hud">
      {mode === 'deathmatch' ? (
        <div className="hud__meta">
          <div>
            Defeated <b>{deathmatchScore}</b>
          </div>
          <div>
            Best <b>{Math.max(best, deathmatchScore)}</b>
          </div>
        </div>
      ) : (
        <>
          <div className="hud__score" aria-label={'Score ' + scores.left + ' to ' + scores.right}>
            <span className="hud__pip hud__pip--left">{scores.left}</span>
            <span className="hud__colon">:</span>
            <span className="hud__pip hud__pip--right">{scores.right}</span>
          </div>
          <div className="hud__meta">First to {MATCH.targetScore}</div>
        </>
      )}

      <button className="hud__pause" onClick={onPause} aria-label="Pause" data-ui-control>
        <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
          <rect x="1" y="1" width="4" height="14" rx="1.4" fill="#eaf1ff" />
          <rect x="9" y="1" width="4" height="14" rx="1.4" fill="#eaf1ff" />
        </svg>
      </button>

      {showHint && <div className="hud__hint">{HINTS[mode]}</div>}

      <Announcements />
    </div>
  );
}
