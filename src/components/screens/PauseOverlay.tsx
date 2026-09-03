interface PauseOverlayProps {
  onResume: () => void;
  onRestart: () => void;
  onHome: () => void;
}

export function PauseOverlay({ onResume, onRestart, onHome }: PauseOverlayProps) {
  return (
    <div className="overlay layer--blocking" data-ui-control>
      <div className="panel">
        <h2 className="panel__title">Paused</h2>
        <p className="panel__note">Everything is frozen — physics, arrows and the opponent.</p>
        <div className="panel__row">
          <button className="btn btn--primary" onClick={onResume} data-ui-control>
            Resume
          </button>
          <button className="btn" onClick={onRestart} data-ui-control>
            Restart
          </button>
          <button className="btn btn--ghost" onClick={onHome} data-ui-control>
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
