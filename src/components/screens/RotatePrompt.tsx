export function RotatePrompt() {
  return (
    <div className="rotate">
      <svg className="rotate__icon" width="82" height="82" viewBox="0 0 64 64" aria-hidden="true">
        <rect
          x="20"
          y="6"
          width="24"
          height="52"
          rx="5"
          fill="none"
          stroke="#4d9dff"
          strokeWidth="3"
        />
        <rect x="29" y="50" width="6" height="3" rx="1.5" fill="#4d9dff" />
      </svg>
      <p style={{ fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', margin: 0 }}>
        Rotate your device
      </p>
      <p style={{ color: '#9db0d0', margin: 0, fontSize: 14 }}>
        Drunken Archers is played in landscape.
      </p>
    </div>
  );
}
