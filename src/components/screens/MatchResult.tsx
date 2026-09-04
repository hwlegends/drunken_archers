import { SKINS } from '../../config/constants';
import type { Side } from '../../types';
import { ArcherMark } from '../ArcherMark';

interface MatchResultProps {
  winner: Side;
  scores: Record<Side, number>;
  twoPlayer: boolean;
  /** Online: which archer this computer was playing. Absent offline. */
  localSide?: Side;
  /** False for an online guest — only the host can seed a new match. */
  canRematch?: boolean;
  onRematch: () => void;
  onHome: () => void;
}

export function MatchResult({
  winner,
  scores,
  twoPlayer,
  localSide,
  canRematch = true,
  onRematch,
  onHome,
}: MatchResultProps) {
  // Online, victory is read against the archer this player was actually given,
  // which is not always the blue one on the left.
  const heading = localSide
    ? winner === localSide
      ? 'Victory'
      : 'Defeated'
    : twoPlayer
      ? (winner === 'left' ? 'Player 1' : 'Player 2') + ' Wins'
      : winner === 'left'
        ? 'Victory'
        : 'Defeated';

  return (
    <div className="overlay layer--blocking" data-ui-control>
      <div className="panel">
        <ArcherMark side={winner} />
        <h2 className={'panel__title panel__title--' + winner}>{heading}</h2>
        <div className="panel__score">
          {scores.left} : {scores.right}
        </div>
        <p className="panel__note">{SKINS[winner].name} takes the match.</p>
        <div className="panel__row">
          {canRematch ? (
            <button className="btn btn--primary" onClick={onRematch} data-ui-control>
              Rematch
            </button>
          ) : (
            <span className="panel__waiting">Waiting on a rematch…</span>
          )}
          <button className="btn btn--ghost" onClick={onHome} data-ui-control>
            {localSide ? 'Leave' : 'Home'}
          </button>
        </div>
      </div>
    </div>
  );
}
