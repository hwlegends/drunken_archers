import { SKINS } from '../config/constants';
import type { Side } from '../types';

/**
 * The menu emblem: a small original archer silhouette drawn as inline SVG so
 * the interface carries the same characters as the arena, with no image files.
 */
export function ArcherMark({ side, flip = false }: { side: Side; flip?: boolean }) {
  const s = SKINS[side];
  return (
    <svg
      className="mark"
      viewBox="0 0 64 96"
      role="img"
      aria-label={s.name + ' archer'}
      style={flip ? { transform: 'scaleX(-1)' } : undefined}
    >
      {/* bow */}
      <path
        d="M44 22 Q60 48 44 74"
        fill="none"
        stroke={s.bow}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path d="M44 22 L38 48 L44 74" fill="none" stroke="#ffffff" strokeWidth="1.6" opacity="0.85" />
      <path d="M38 48 H62" stroke="#c9a06a" strokeWidth="2.4" />
      <path d="M62 48 l-6 -3.4 v6.8 z" fill="#dfe6ee" />

      {/* legs */}
      <path d="M26 62 L20 88" stroke={s.clothShade} strokeWidth="9" strokeLinecap="round" />
      <path d="M30 62 L38 88" stroke={s.cloth} strokeWidth="9" strokeLinecap="round" />

      {/* torso */}
      <rect x="22" y="34" width="16" height="30" rx="8" fill={s.cloth} />
      <rect x="22" y="46" width="16" height="5" rx="2.5" fill={s.accent} />

      {/* arms */}
      <path d="M30 40 L44 46" stroke={s.skinShade} strokeWidth="7" strokeLinecap="round" />
      <path d="M30 40 L42 48" stroke={s.skin} strokeWidth="7" strokeLinecap="round" />

      {/* head */}
      <circle cx="29" cy="24" r="11" fill={s.skin} />
      <path
        d="M18 22 l3 -12 4 8 3 -12 4 11 4 -9 3 12 z"
        fill={s.hair}
      />
      <circle cx="33" cy="24" r="2.1" fill="#12203a" />
    </svg>
  );
}
