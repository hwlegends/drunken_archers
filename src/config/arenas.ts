import type { ArenaConfig, ArenaThemeId, PlatformSpec } from '../types';
import { BOW, PHYSICS, RAGDOLL, VIEW } from './constants';

/** Small deterministic PRNG so an arrangement can be reproduced from a seed. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const rangeOf = (rng: () => number, min: number, max: number) => min + rng() * (max - min);

/* ------------------------------------------------------------------ *
 * Arrangement generation + validation
 * ------------------------------------------------------------------ */

const ARRANGEMENT = {
  /** Platform surface centres are drawn from these bands. */
  leftX: { min: 165, max: 330 },
  rightX: { min: 950, max: 1115 },
  topY: { min: 300, max: 500 },
  width: { min: 130, max: 205 },
  /** Horizontal gap between the two standing surfaces. */
  minSeparation: 560,
  maxSeparation: 900,
  /** Cap the height difference so neither archer is off-screen or unreachable. */
  maxHeightDelta: 165,
  /** Keep both fighters clear of the top and bottom of the frame. */
  minTopY: 260,
  maxTopY: 545,
};

export interface Arrangement {
  left: PlatformSpec;
  right: PlatformSpec;
}

/**
 * A trajectory is viable when the flat-ground ballistic range at the ideal 45°
 * launch, using the fastest available shot, comfortably covers the gap.
 */
function trajectoryIsViable(a: Arrangement): boolean {
  const dx = Math.abs(a.right.x - a.left.x);
  const dy = a.right.topY - a.left.topY;
  const v = BOW.maxLaunchSpeed;
  const g = PHYSICS.gravity;
  // Max range over a height difference dy (positive = target lower than shooter).
  const maxRange = (v / g) * Math.sqrt(v * v + 2 * g * Math.max(0, dy));
  const uphillRange = (v / g) * Math.sqrt(Math.max(1, v * v - 2 * g * Math.max(0, -dy)));
  // Require 25% headroom in the harder (uphill) direction.
  return dx < maxRange * 0.95 && dx < uphillRange * 0.95;
}

export function validateArrangement(a: Arrangement): boolean {
  const sep = a.right.x - a.left.x;
  if (sep < ARRANGEMENT.minSeparation || sep > ARRANGEMENT.maxSeparation) return false;
  if (Math.abs(a.right.topY - a.left.topY) > ARRANGEMENT.maxHeightDelta) return false;

  for (const p of [a.left, a.right]) {
    // Fighters must stay inside the frame with room for the ragdoll above them.
    if (p.topY < ARRANGEMENT.minTopY || p.topY > ARRANGEMENT.maxTopY) return false;
    if (p.x - p.width / 2 < 40) return false;
    if (p.x + p.width / 2 > VIEW.width - 40) return false;
  }
  // Surfaces must not overlap horizontally.
  if (a.left.x + a.left.width / 2 >= a.right.x - a.right.width / 2 - 120) return false;

  return trajectoryIsViable(a);
}

/** Generates a validated arrangement, falling back to a known-good default. */
export function generateArrangement(rng: () => number): Arrangement {
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate: Arrangement = {
      left: {
        x: rangeOf(rng, ARRANGEMENT.leftX.min, ARRANGEMENT.leftX.max),
        topY: rangeOf(rng, ARRANGEMENT.topY.min, ARRANGEMENT.topY.max),
        width: rangeOf(rng, ARRANGEMENT.width.min, ARRANGEMENT.width.max),
        seed: Math.floor(rng() * 1e9),
      },
      right: {
        x: rangeOf(rng, ARRANGEMENT.rightX.min, ARRANGEMENT.rightX.max),
        topY: rangeOf(rng, ARRANGEMENT.topY.min, ARRANGEMENT.topY.max),
        width: rangeOf(rng, ARRANGEMENT.width.min, ARRANGEMENT.width.max),
        seed: Math.floor(rng() * 1e9),
      },
    };
    if (validateArrangement(candidate)) return candidate;
  }
  return {
    left: { x: 250, topY: 400, width: 170, seed: 1 },
    right: { x: 1030, topY: 400, width: 170, seed: 2 },
  };
}

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

type ThemeBase = Omit<ArenaConfig, 'platforms' | 'spawns' | 'camera' | 'projectileBounds' | 'fallBoundary'>;

const THEMES: Record<ArenaThemeId, ThemeBase> = {
  desert: {
    id: 'desert',
    name: 'Sunbaked Spires',
    sky: ['#4fb8f5', '#bfe9ff'],
    sun: { x: 790, y: 168, radius: 46, color: '#fffbe6' },
    layers: [
      { depth: 0.12, kind: 'haze', y: 470, color: 'rgba(255,222,164,0.55)' },
      { depth: 0.26, kind: 'dunes', y: 508, color: '#e7b476' },
      { depth: 0.48, kind: 'dunes', y: 556, color: '#d99b57' },
    ],
    groundColor: '#c8823f',
    platformColors: ['#e0a95f', '#b87434'],
    ambient: { kind: 'sand', count: 46, color: 'rgba(255,232,190,0.5)', drift: { x: 26, y: 9 } },
  },
  city: {
    id: 'city',
    name: 'Rooftop Standoff',
    sky: ['#20244d', '#7d5a86'],
    sun: { x: 480, y: 200, radius: 34, color: '#ffe9b8' },
    layers: [
      { depth: 0.14, kind: 'skyline', y: 520, color: '#2c2f5c' },
      { depth: 0.3, kind: 'skyline', y: 560, color: '#22254a' },
      { depth: 0.5, kind: 'skyline', y: 600, color: '#191b38' },
    ],
    groundColor: '#141530',
    platformColors: ['#4a4f7d', '#2b2e52'],
    ambient: { kind: 'ember', count: 34, color: 'rgba(255,196,120,0.6)', drift: { x: -14, y: -26 } },
  },
  jungle: {
    id: 'jungle',
    name: 'Canopy Duel',
    sky: ['#12b6c4', '#8ef0d0'],
    sun: null,
    layers: [
      { depth: 0.14, kind: 'canopy', y: 470, color: 'rgba(30,150,130,0.45)' },
      { depth: 0.3, kind: 'canopy', y: 540, color: 'rgba(22,124,108,0.6)' },
      { depth: 0.52, kind: 'haze', y: 620, color: 'rgba(16,100,90,0.7)' },
    ],
    groundColor: '#0f6f62',
    platformColors: ['#2fa15f', '#1c7040'],
    ambient: { kind: 'leaf', count: 26, color: 'rgba(120,235,170,0.6)', drift: { x: -20, y: 18 } },
  },
};

export const ARENA_IDS: ArenaThemeId[] = ['desert', 'city', 'jungle'];

/** Builds a complete, validated arena from a theme and a seed. */
export function createArena(theme: ArenaThemeId, seed: number): ArenaConfig {
  const rng = makeRng(seed);
  const platforms = generateArrangement(rng);
  const base = THEMES[theme];

  // The hips sit exactly one leg-length above the surface, so the ankle anchors
  // land on the platform rather than leaving the archer hovering above it.
  const spawnLift = RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h;

  return {
    ...base,
    platforms,
    spawns: {
      left: { x: platforms.left.x, y: platforms.left.topY - spawnLift },
      right: { x: platforms.right.x, y: platforms.right.topY - spawnLift },
    },
    camera: { center: { x: VIEW.width / 2, y: VIEW.height / 2 }, zoom: 1 },
    projectileBounds: { minX: -320, maxX: VIEW.width + 320, minY: -900, maxY: VIEW.height + 320 },
    fallBoundary: VIEW.height + 140,
  };
}

/** Picks a theme that is not the one currently in play, when possible. */
export function pickArenaTheme(exclude?: ArenaThemeId): ArenaThemeId {
  const pool = exclude ? ARENA_IDS.filter((id) => id !== exclude) : ARENA_IDS;
  return pool[Math.floor(Math.random() * pool.length)];
}
