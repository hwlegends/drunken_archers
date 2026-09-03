export function Instructions({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay layer--blocking" data-ui-control>
      <div className="panel">
        <h2 className="panel__title">How to Play</h2>

        <div className="howto">
          <div className="howto__item">
            <span className="kbd">Hold</span>
            <span>
              <b>Charge the shot.</b> The longer you hold, the faster the arrow flies.
            </span>
          </div>
          <div className="howto__item">
            <span className="kbd">Let go</span>
            <span>
              <b>Fire.</b> The arrow leaves along whatever direction the bow points at that exact
              moment — you cannot aim, only time it.
            </span>
          </div>
          <div className="howto__item">
            <span className="kbd">↑</span>
            <span>
              <b>One Player &amp; Deathmatch.</b> On touch, hold anywhere on the arena.
            </span>
          </div>
          <div className="howto__item">
            <span className="kbd">W</span>
            <span>
              <b>Two Players.</b> W for blue, ↑ for orange. On touch, the left and right halves of
              the screen, both at once.
            </span>
          </div>
          <div className="howto__item">
            <span className="kbd">Esc</span>
            <span>
              <b>Pause.</b>
            </span>
          </div>
          <div className="howto__item">
            <span className="kbd">!</span>
            <span>
              A <b>headshot</b> ends it instantly. Body and limb hits chip away at 100 health, and
              falling off the platform is just as fatal. First to five points wins.
            </span>
          </div>
        </div>

        <div className="panel__row">
          <button className="btn btn--primary" onClick={onClose} data-ui-control>
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
