import { SKINS } from '../../config/constants';
import type { Side } from '../../types';
import { ArcherMark } from '../ArcherMark';

interface MatchResultProps {
  winner: Side;
  scores: Record<Side, number>;
  twoPlayer: boolean;
  onRematch: () => void;
  onHome: () => void;
}

export function MatchResult({ winner, scores, twoPlayer, onRematch, onHome }: MatchResultProps) {
  const heading = twoPlayer
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
          <button className="btn btn--primary" onClick={onRematch} data-ui-control>
            Rematch
          </button>
          <button className="btn btn--ghost" onClick={onHome} data-ui-control>
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
