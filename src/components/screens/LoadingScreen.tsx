export function LoadingScreen({ progress }: { progress: number }) {
  return (
    <div className="loading">
      <h1 className="title" style={{ textAlign: 'center' }}>
        Drunken
        <br />
        Archers
      </h1>
      <div className="loading__bar">
        <div className="loading__fill" style={{ width: Math.round(progress * 100) + '%' }} />
      </div>
      <p className="loading__note">Steadying the aim…</p>
    </div>
  );
}
