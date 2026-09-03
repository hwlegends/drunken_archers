import { useEffect } from 'react';
import { useGameStore } from '../../state/gameStore';

/**
 * Short FIGHT / HEADSHOT / point banners. Each removes itself after its own
 * duration, so nothing accumulates across rounds.
 */
export function Announcements() {
  const announcements = useGameStore((s) => s.announcements);
  const dismiss = useGameStore((s) => s.dismissAnnouncement);

  useEffect(() => {
    if (!announcements.length) return;
    const timers = announcements.map((a) => window.setTimeout(() => dismiss(a.id), a.duration));
    return () => timers.forEach(clearTimeout);
  }, [announcements, dismiss]);

  if (!announcements.length) return null;

  return (
    <div className="announcements" aria-live="polite">
      {announcements.map((a) => (
        <div key={a.id} className={'shout shout--' + a.kind}>
          {a.text}
        </div>
      ))}
    </div>
  );
}
