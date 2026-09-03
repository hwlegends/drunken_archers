import type Matter from 'matter-js';
import type { Skin } from '../config/constants';

/* ------------------------------------------------------------------ *
 * Core enums
 * ------------------------------------------------------------------ */

export type GameMode = 'onePlayer' | 'twoPlayers' | 'deathmatch';

export type GamePhase =
  | 'loading'
  | 'menu'
  | 'instructions'
  | 'roundIntro'
  | 'playing'
  | 'paused'
  | 'roundResult'
  | 'matchResult'
  | 'deathmatchResult';

/** Which side of the arena a fighter occupies. Also selects the skin palette. */
export type Side = 'left' | 'right';

/** Who supplies the charge/release input for a fighter. */
export type Controller = 'human1' | 'human2' | 'cpu';

export type BodyRegion = 'head' | 'torso' | 'upperArm' | 'lowerArm' | 'upperLeg' | 'lowerLeg';

/* ------------------------------------------------------------------ *
 * Match configuration
 * ------------------------------------------------------------------ */

export interface MatchConfig {
  mode: GameMode;
  /** Points needed to take the match. Ignored by deathmatch. */
  targetScore: number;
  /** Controller assignment per side. */
  controllers: Record<Side, Controller>;
  /** 0..1 CPU skill. Deathmatch ramps this between encounters. */
  cpuDifficulty: number;
}

/* ------------------------------------------------------------------ *
 * Arena
 * ------------------------------------------------------------------ */

export type ArenaThemeId = 'desert' | 'city' | 'jungle';

export interface Vec2 {
  x: number;
  y: number;
}

/** A single static platform: the surface a fighter stands on plus its column. */
export interface PlatformSpec {
  /** Centre of the standing surface. */
  x: number;
  /** Y of the top (standing) surface. */
  topY: number;
  /** Width of the standing surface. */
  width: number;
  /** Visual/collision seed so a re-generated arena draws consistently. */
  seed: number;
}

export interface ParallaxLayer {
  /** 0 = pinned to camera, 1 = moves with the world. */
  depth: number;
  kind: 'dunes' | 'skyline' | 'canopy' | 'clouds' | 'haze';
  /** Vertical placement in logical units. */
  y: number;
  color: string;
}

export interface AmbientParticleSpec {
  kind: 'sand' | 'ember' | 'leaf' | 'none';
  count: number;
  color: string;
  /** Base drift in logical px/s. */
  drift: Vec2;
}

export interface ArenaConfig {
  id: ArenaThemeId;
  name: string;
  /** Vertical gradient stops for the sky. */
  sky: [string, string];
  /** Sun / moon disc, or null. */
  sun: { x: number; y: number; radius: number; color: string } | null;
  layers: ParallaxLayer[];
  platforms: { left: PlatformSpec; right: PlatformSpec };
  /** Where the ragdolls' hips start. */
  spawns: { left: Vec2; right: Vec2 };
  camera: { center: Vec2; zoom: number };
  /** Projectiles outside this rect are destroyed immediately. */
  projectileBounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** A ragdoll whose torso passes below this is defeated. */
  fallBoundary: number;
  groundColor: string;
  platformColors: [string, string];
  ambient: AmbientParticleSpec;
}

/* ------------------------------------------------------------------ *
 * Fighters
 * ------------------------------------------------------------------ */

export interface PlayerState {
  side: Side;
  controller: Controller;
  health: number;
  maxHealth: number;
  score: number;
  alive: boolean;
}

/** Imperative handle to a ragdoll living inside the physics world. */
export interface RagdollHandle {
  side: Side;
  /** Palette used to draw this fighter; deathmatch varies the opponent's. */
  skin: Skin;
  /** Direction the archer faces: +1 shoots right, -1 shoots left. */
  facing: 1 | -1;
  parts: Record<string, Matter.Body>;
  head: Matter.Body;
  torso: Matter.Body;
  /** The hand that holds the bow. */
  bowHand: Matter.Body;
  /** The hand that draws the string. */
  drawHand: Matter.Body;
  bow: Matter.Body;
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  /**
   * Every joint in the body, held inert while the archer is standing because
   * the whole body is posed directly. `CombatSystem` restores them the moment
   * the archer topples or dies, and the ragdoll takes over from there.
   */
  joints: Array<{ constraint: Matter.Constraint; stiffness: number; damping: number }>;
  /** The point between the feet that the standing body swings about. */
  pivot: Vec2;
  /** Each part's rest placement relative to `pivot`, used to pose the swing. */
  restPose: Array<{ body: Matter.Body; offset: Vec2; angle: number }>;
  /** True while the archer is on its feet and being posed. */
  standing: boolean;
  /** Accumulated destabilisation from hits; at 1 the archer loses its footing. */
  balanceLoss: number;
  collisionGroup: number;
  /** Per-part damage region lookup, keyed by Matter body id. */
  regionOf: Map<number, BodyRegion>;
  /** Wobble phase so each archer sways on its own rhythm. */
  wobblePhase: number;
  /** Independent phase for the bow arm's up-and-down sweep. */
  armPhase: number;
  wobbleSeed: number;
  dead: boolean;
}

export type BowPhase = 'reloading' | 'ready' | 'drawing' | 'released';

export interface BowState {
  side: Side;
  phase: BowPhase;
  /** Normalised draw, 0..1. */
  charge: number;
  /** ms remaining before a fresh arrow is nocked. */
  reloadRemaining: number;
  /** True while the owning input is held. */
  inputHeld: boolean;
  /** Bow angle in radians at the last simulation step. */
  angle: number;
  /** World position the arrow leaves from. */
  launchPoint: Vec2;
}

/* ------------------------------------------------------------------ *
 * Projectiles
 * ------------------------------------------------------------------ */

export interface ProjectileState {
  id: number;
  body: Matter.Body;
  owner: Side;
  /** Set false once it has dealt damage or embedded — cannot damage again. */
  active: boolean;
  /** ms since launch; used for the shooter grace period. */
  age: number;
  /** ms remaining before cleanup once embedded. */
  lifetime: number;
  embedded: boolean;
  embedConstraint: Matter.Constraint | null;
}

/* ------------------------------------------------------------------ *
 * Combat events
 * ------------------------------------------------------------------ */

export interface HitEvent {
  projectileId: number;
  shooter: Side;
  target: Side;
  region: BodyRegion;
  damage: number;
  fatal: boolean;
  headshot: boolean;
  point: Vec2;
  speed: number;
}

export interface RoundResult {
  winner: Side;
  loser: Side;
  byHeadshot: boolean;
  byFall: boolean;
  scores: Record<Side, number>;
}

/* ------------------------------------------------------------------ *
 * Settings + persistence
 * ------------------------------------------------------------------ */

export interface GameSettings {
  music: boolean;
  sfx: boolean;
  /** Substitutes a neutral dust burst for the blood effect. */
  reducedBlood: boolean;
}

export interface PersistentStats {
  bestDeathmatchScore: number;
  matchesPlayed: number;
}

/* ------------------------------------------------------------------ *
 * Transient HUD messages pushed from the engine to React
 * ------------------------------------------------------------------ */

export type AnnouncementKind = 'fight' | 'headshot' | 'point' | 'ko';

export interface Announcement {
  id: number;
  kind: AnnouncementKind;
  text: string;
  side?: Side;
  /** ms the overlay should remain on screen. */
  duration: number;
}

/** Screen-space health bar anchor, refreshed at a low rate for the HUD. */
export interface HudAnchor {
  side: Side;
  /** Normalised 0..1 position within the letterboxed viewport. */
  x: number;
  y: number;
  visible: boolean;
}
