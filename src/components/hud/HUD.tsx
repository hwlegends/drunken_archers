import { MATCH } from '../../config/constants';
import { useGameStore } from '../../state/gameStore';
import type { GameMode } from '../../types';
import { Announcements } from './Announcements';

interface HUDProps {
  mode: GameMode;
  /** Pause, or leave the match when there is nothing to pause. */
  onPause: () => void;
  showHint: boolean;
  /** Online only: who is on the other end, and how far away they are. */
  opponent?: string;
  latency?: number | null;
  /** The opponent's browser has stopped sending; the match is frozen. */
  stalled?: boolean;
}

const HINTS: Record<GameMode, string> = {
  onePlayer: 'Hold ↑ or press and hold the arena · release to fire',
  twoPlayers: 'Blue: hold W · Orange: hold ↑ · or hold your half of the screen',
  deathmatch: 'Hold ↑ or press and hold the arena · release to fire',
  online: 'Hold ↑ or press and hold the arena · release to fire',
};

/** Only shown while the option is on, since the keys do nothing otherwise. */
const STEP_HINTS: Record<GameMode, string> = {
  onePlayer: '← → to step',
  twoPlayers: 'Blue: A D · Orange: ← →',
  deathmatch: '← → to step',
  online: '← → to step',
};

/**
 * Score, run counters and the pause button. Health bars are drawn on the canvas
 * above each archer, which keeps their per-frame positions out of React.
 */
export function HUD({ mode, onPause, showHint, opponent, latency, stalled }: HUDProps) {
  const scores = useGameStore((s) => s.scores);
  const deathmatchScore = useGameStore((s) => s.deathmatchScore);
  const best = useGameStore((s) => s.stats.bestDeathmatchScore);
  const sidestep = useGameStore((s) => s.settings.sidestep);
  const online = mode === 'online';

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
          <div className="hud__meta">
            {online && opponent ? (
              <>
                <div>vs {opponent}</div>
                {latency !== null && latency !== undefined && <div>{latency} ms</div>}
              </>
            ) : (
              'First to ' + MATCH.targetScore
            )}
          </div>
        </>
      )}

      <button
        className="hud__pause"
        onClick={onPause}
        aria-label={online ? 'Leave match' : 'Pause'}
        data-ui-control
      >
        {online ? (
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <path
              d="M4 4l7 7M11 4l-7 7"
              stroke="#eaf1ff"
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        ) : (
          <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
            <rect x="1" y="1" width="4" height="14" rx="1.4" fill="#eaf1ff" />
            <rect x="9" y="1" width="4" height="14" rx="1.4" fill="#eaf1ff" />
          </svg>
        )}
      </button>

      {stalled && (
        <div className="hud__stalled" role="status">
          Waiting for {opponent ?? 'the other computer'}
          <span className="hud__stalled-note">
            Their window has to stay open for the match to run
          </span>
        </div>
      )}

      {showHint && !stalled && (
        <div className="hud__hint">
          {HINTS[mode]}
          {sidestep ? ' · ' + STEP_HINTS[mode] : ''}
        </div>
      )}

      <Announcements />
    </div>
  );
}
