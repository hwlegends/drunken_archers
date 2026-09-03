/**
 * Every tunable number in the game lives here — physics, combat, AI, camera and
 * timing. Nothing in a component or system should hard-code a magic value.
 */

export const VIEW = {
  /** Logical gameplay viewport. Everything simulates in these units. */
  width: 1280,
  height: 720,
  aspect: 1280 / 720,
  /** Cap device pixel ratio so high-DPI phones do not shade 4x the pixels. */
  maxDpr: 2,
} as const;

export const TIME = {
  /** Fixed physics step in ms (60 Hz). */
  step: 1000 / 60,
  /** Never run more than this many catch-up steps in one frame. */
  maxCatchUpSteps: 5,
  /** A frame delta larger than this is treated as a stall and discarded. */
  maxFrameDelta: 250,
} as const;

export const PHYSICS = {
  /** px/s². Matter works in px/step², converted in PhysicsWorld. */
  gravity: 1200,
  /** Matter position/velocity solver iterations. */
  positionIterations: 8,
  velocityIterations: 8,
  constraintIterations: 4,
} as const;

export const COMBAT = {
  maxHealth: 100,
  damage: {
    head: 100,
    torso: 34,
    upperArm: 20,
    lowerArm: 20,
    upperLeg: 20,
    lowerLeg: 20,
  },
  /** Below this impact speed (px/s) an arrow bounces off harmlessly. */
  minDamagingSpeed: 250,
  /** Knockback impulse scale applied to the struck part. */
  knockbackScale: 0.0016,
  /** Extra impulse toward the torso so hits visibly stagger the ragdoll. */
  torsoKnockbackScale: 0.0009,
} as const;

export const BOW = {
  /** Seconds of holding to reach full charge. */
  timeToMaxCharge: 1.0,
  minLaunchSpeed: 600,
  maxLaunchSpeed: 1300,
  /** Charge is eased before mapping to speed: speed = min + (max-min) * t^exp. */
  chargeEase: 1.35,
  reloadDelayMs: 350,
  /** Impulse pushed back into the hands/torso on release. */
  recoilScale: 0.005,
  /** How far ahead of the bow hand the arrow is nocked, in logical px. */
  nockOffset: 21,
  /** Visual: how far the string is pulled back at full charge. */
  maxStringPull: 24,
  /** Bow limb half-length. */
  limbLength: 30,
} as const;

export const PROJECTILE = {
  length: 42,
  thickness: 3,
  /** ms after launch during which the shooter cannot be hit by its own arrow. */
  shooterGraceMs: 100,
  /** ms an embedded arrow stays before cleanup. */
  cleanupLifetimeMs: 5000,
  /** Matter density — light enough not to knock the ragdoll over on a graze. */
  density: 0.0022,
  frictionAir: 0.0012,
  /** Max arrows in flight per side before the oldest is recycled. */
  maxPerSide: 12,
} as const;

export const RAGDOLL = {
  /** Torso half-extents in logical px. */
  torso: { w: 18, h: 41 },
  head: { r: 13.5 },
  upperArm: { w: 8.5, h: 21 },
  lowerArm: { w: 7.5, h: 20 },
  upperLeg: { w: 10.5, h: 24 },
  lowerLeg: { w: 9.5, h: 23 },
  density: 0.0016,
  frictionAir: 0.02,
  friction: 0.6,
  restitution: 0.02,
  /** Joint softness, used once the ragdoll is released on a topple or death. */
  jointStiffness: 0.92,
  jointDamping: 0.14,

  /**
   * The standing archer swings as one rigid body about a pivot between its
   * feet, like a metronome, rather than each limb wobbling on its own. That is
   * what makes an archer's position readable: a player can watch the swing and
   * anticipate where the target will be, instead of guessing at loose limbs.
   */
  swingAmplitude: 0.38,
  swingPeriod: 2.4,
  /** A small detuned second swing, so it reads as alive but stays predictable. */
  swingDetune: 0.07,
  swingDetuneRatio: 0.41,

  /**
   * How much of a hit's damage turns into lost balance, and how fast that
   * recovers. Cross `toppleThreshold` and the archer loses its footing and
   * becomes a free ragdoll — it can then be knocked off the arena entirely.
   */
  toppleGain: 1.6,
  toppleThreshold: 1,
  toppleRecoveryPerSecond: 0.5,

  /**
   * The bow arm rides this far above horizontal at rest, which lifts the bow up
   * in front of the archer's face instead of leaving it down at the waist.
   */
  armLift: 0.36,
  /**
   * The arm sweeps this far either side of its rest lift. This is the swing the
   * player is timing — the bow angle at release is the shot direction, so a
   * still arm would mean a game with no skill in it.
   */
  armSwingAmplitude: 0.30,
  /** Arm swing period, seconds. Deliberately not a ratio of `swingPeriod`. */
  armSwingPeriod: 1.55,
  /** A second, detuned swing so the sweep never repeats exactly. */
  armSwingWobble: 0.12,
  armSwingWobbleRatio: 0.57,
  /**
   * How fast a posed body converges on its target each step, 0..1.
   *
   * The archer is posed directly rather than solved for. Solver-driven attempts
   * failed repeatedly: a torque servo on a wrapped angle error has an unstable
   * equilibrium at 180 degrees and winds a limb into a permanent spin, and
   * constraining two points of a two-degree-of-freedom chain over-constrains it
   * until the solver pumps in energy. Posing cannot wind up or blow up, and
   * blending rather than snapping leaves the archer visibly springy when struck.
   */
  poseTrackRate: 0.45,
  armTrackRate: 0.55,

} as const;

export const MATCH = {
  targetScore: 5,
  /** ms the round-result overlay holds before the next round. */
  roundResultDelayMs: 1500,
  /** ms the FIGHT! banner shows during roundIntro. */
  roundIntroMs: 1100,
  /** ms a deathmatch encounter transition takes. */
  encounterDelayMs: 900,
} as const;

export const AI = {
  /** Reaction delay range in ms, lerped by difficulty (easy -> hard). */
  reactionMs: { easy: 1250, hard: 380 },
  /** Launch-angle error in radians, lerped by difficulty. */
  angleErrorRad: { easy: 0.2, hard: 0.035 },
  /** Fractional launch-speed error, lerped by difficulty. */
  powerError: { easy: 0.22, hard: 0.045 },
  /** Chance per shot of a deliberately sloppy attempt. */
  sloppyShotChance: { easy: 0.3, hard: 0.07 },
  /** Extra error multiplier applied to a sloppy shot. */
  sloppyErrorScale: 3.2,
  /** How close (radians) the wobbling bow must be to the solution to fire. */
  angleToleranceRad: { easy: 0.16, hard: 0.055 },
  /** Give up waiting for a good angle after this long and fire anyway. */
  maxAimWaitMs: 2600,
  /** Difficulty floor/ceiling so deathmatch stays fair. */
  minDifficulty: 0.12,
  maxDifficulty: 0.92,
  /** Difficulty added per deathmatch kill. */
  difficultyStep: 0.075,
  /** Do not fire if the launch ray is blocked within this distance. */
  obstructionProbe: 90,
} as const;

export const CAMERA = {
  /** Fraction of the gap between current and target closed per second. */
  followLerp: 6.5,
  shakeDecay: 5.5,
  maxShake: 16,
  zoomLerp: 3.2,
} as const;

export const FX = {
  particlePoolSize: 320,
  bloodParticles: 16,
  dustParticles: 12,
  /** ms */
  particleLife: 900,
  gravity: 900,
} as const;

export const STORAGE_KEYS = {
  settings: 'drunkenArchers.settings.v1',
  stats: 'drunkenArchers.stats.v1',
} as const;

/** Collision categories. Matter uses 32-bit masks. */
export const CATEGORY = {
  terrain: 0x0001,
  ragdollLeft: 0x0002,
  ragdollRight: 0x0004,
  arrowLeft: 0x0008,
  arrowRight: 0x0010,
} as const;

/** A character palette. All artwork is drawn from these, never from a sprite. */
export interface Skin {
  name: string;
  skin: string;
  skinShade: string;
  cloth: string;
  clothShade: string;
  accent: string;
  hair: string;
  bow: string;
  hud: string;
}

/**
 * The two duelling palettes. Blue versus orange keeps the sides readable at a
 * glance, which the HUD score and health bars mirror.
 */
export const SKINS: Record<'left' | 'right', Skin> = {
  left: {
    name: 'Cobalt',
    skin: '#5aa9ff',
    skinShade: '#2e78d4',
    cloth: '#1f3f9e',
    clothShade: '#152c73',
    accent: '#ffd94a',
    hair: '#16214a',
    bow: '#8f5a2c',
    hud: '#4d9dff',
  },
  right: {
    name: 'Ember',
    skin: '#ffb46b',
    skinShade: '#e0813a',
    cloth: '#e2452a',
    clothShade: '#a52d18',
    accent: '#ffe27a',
    hair: '#ffd53d',
    bow: '#6f4326',
    hud: '#ff7a45',
  },
};

/** Alternate opponents cycled through during a deathmatch run. */
export const DEATHMATCH_SKINS: Skin[] = [
  SKINS.right,
  {
    name: 'Verdant',
    skin: '#b6e88a',
    skinShade: '#7cb84f',
    cloth: '#2f7d3d',
    clothShade: '#1d5528',
    accent: '#f2ff9c',
    hair: '#123a1c',
    bow: '#6f4326',
    hud: '#7ddc6a',
  },
  {
    name: 'Amethyst',
    skin: '#d9a8ff',
    skinShade: '#a06cd0',
    cloth: '#6a2fa0',
    clothShade: '#441a6d',
    accent: '#ffd7f5',
    hair: '#2a1040',
    bow: '#5c3a5e',
    hud: '#c07dff',
  },
  {
    name: 'Bone',
    skin: '#f2e5d0',
    skinShade: '#c9b394',
    cloth: '#7d7266',
    clothShade: '#524a41',
    accent: '#ffbf5e',
    hair: '#3a332c',
    bow: '#5a4632',
    hud: '#e8d5b4',
  },
];
