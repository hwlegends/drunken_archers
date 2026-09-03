interface DeathmatchResultProps {
  score: number;
  best: number;
  onRetry: () => void;
  onHome: () => void;
}

export function DeathmatchResult({ score, best, onRetry, onHome }: DeathmatchResultProps) {
  const isRecord = score > 0 && score >= best;
  return (
    <div className="overlay layer--blocking" data-ui-control>
      <div className="panel">
        <h2 className="panel__title panel__title--right">Run Over</h2>
        <div className="panel__score">{score}</div>
        <p className="panel__note">
          {score === 1 ? '1 opponent defeated' : score + ' opponents defeated'}
          {isRecord ? ' — a new best.' : '.'}
        </p>
        <div className="panel__stat">
          <span>Best run</span>
          <span>{Math.max(best, score)}</span>
        </div>
        <div className="panel__row">
          <button className="btn btn--accent" onClick={onRetry} data-ui-control>
            Try Again
          </button>
          <button className="btn btn--ghost" onClick={onHome} data-ui-control>
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
