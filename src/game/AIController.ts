import Matter from 'matter-js';
import { AI, BOW, PHYSICS } from '../config/constants';
import type { RagdollHandle, Side } from '../types';
import type { BowController } from './BowController';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Wraps an angle into (-PI, PI]. */
function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * A CPU archer. It drives the exact same BowController a human does — press,
 * hold, release — and never touches a projectile directly. All it decides is
 * *when* to let go of a string it cannot steer.
 */
export class AIController {
  /** 0 = clumsy, 1 = sharp. Clamped to the fair band from the constants. */
  private difficulty: number;
  private reactionRemaining = 0;
  private aimingFor = 0;
  private sloppy = false;
  private angleBias = 0;
  private powerBias = 0;
  private enabled = true;

  constructor(
    private readonly side: Side,
    private readonly ragdoll: RagdollHandle,
    private readonly bow: BowController,
    private readonly terrain: () => Matter.Body[],
    difficulty: number,
  ) {
    this.difficulty = this.clampDifficulty(difficulty);
    this.beginReaction();
  }

  setDifficulty(value: number): void {
    this.difficulty = this.clampDifficulty(value);
  }

  getDifficulty(): number {
    return this.difficulty;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.bow.cancel();
  }

  private clampDifficulty(value: number): number {
    return Math.max(AI.minDifficulty, Math.min(AI.maxDifficulty, value));
  }

  /** Interpolates a tuning pair from easy to hard by current difficulty. */
  private tuned(pair: { easy: number; hard: number }): number {
    return lerp(pair.easy, pair.hard, this.difficulty);
  }

  private beginReaction(): void {
    this.reactionRemaining = this.tuned(AI.reactionMs) * (0.7 + Math.random() * 0.6);
    this.aimingFor = 0;
    // Occasionally commit to a deliberately imperfect attempt.
    this.sloppy = Math.random() < this.tuned(AI.sloppyShotChance);
    const scale = this.sloppy ? AI.sloppyErrorScale : 1;
    this.angleBias = (Math.random() * 2 - 1) * this.tuned(AI.angleErrorRad) * scale;
    this.powerBias = (Math.random() * 2 - 1) * this.tuned(AI.powerError) * scale;
  }

  update(stepMs: number, target: RagdollHandle): void {
    if (!this.enabled || this.ragdoll.dead || target.dead) {
      this.bow.cancel();
      return;
    }

    if (this.reactionRemaining > 0) {
      this.reactionRemaining -= stepMs;
      return;
    }

    // Start the draw. From here the CPU is holding a real, charging bow.
    if (this.bow.canFire && !this.bow.state.inputHeld) {
      this.bow.press();
      this.aimingFor = 0;
      return;
    }
    if (this.bow.state.phase !== 'drawing') return;

    this.aimingFor += stepMs;

    const state = this.bow.state;
    const origin = state.launchPoint;
    const aim = target.torso.position;

    // Lead the shot slightly toward where the swaying torso is heading.
    const dx = aim.x - origin.x;
    const dy = aim.y - origin.y;

    // Effective speed for the charge currently held, plus this shot's power error.
    const eased = Math.pow(Math.min(1, state.charge), BOW.chargeEase);
    const rawSpeed = BOW.minLaunchSpeed + (BOW.maxLaunchSpeed - BOW.minLaunchSpeed) * eased;
    const speed = rawSpeed * (1 + this.powerBias);

    const solution = this.solveLaunchAngle(dx, dy, speed);

    // Not enough power yet: keep drawing. If the bow is already at full draw and
    // still cannot reach, take the shot rather than freezing forever.
    if (solution === null) {
      if (state.charge >= 0.999 || this.aimingFor > AI.maxAimWaitMs) this.releaseShot();
      return;
    }

    const desired = solution + this.angleBias;
    const error = Math.abs(wrap(desired - state.angle));
    const tolerance = this.tuned(AI.angleToleranceRad) * (this.sloppy ? 2.4 : 1);

    // Do not shoot into the rock the archer is standing behind.
    if (this.isObstructed(origin, state.angle)) {
      if (this.aimingFor > AI.maxAimWaitMs * 1.5) this.abandonShot();
      return;
    }

    if (error <= tolerance) {
      this.releaseShot();
      return;
    }

    // Waiting for a perfect angle forever is not an option — the wobble may
    // never line up. Loosen up and eventually fire regardless.
    if (this.aimingFor > AI.maxAimWaitMs) this.releaseShot();
  }

  /**
   * Standard ballistic solution for a fixed launch speed over a height
   * difference. Screen Y grows downward, so it is negated into maths space.
   * Returns the flatter of the two roots as a screen-space angle, or null when
   * the target is out of range at this speed.
   */
  private solveLaunchAngle(dx: number, dyScreen: number, speed: number): number | null {
    const g = PHYSICS.gravity;
    // The textbook formula assumes the target lies at +range, so it is solved in
    // "forward" space and mirrored afterwards.
    const range = Math.abs(dx);
    if (range < 1e-3) return null;

    const dyUp = -dyScreen;
    const v2 = speed * speed;
    const disc = v2 * v2 - g * (g * range * range + 2 * dyUp * v2);
    if (disc < 0) return null;

    const root = Math.sqrt(disc);
    const denom = g * range;

    // Two solutions exist: a flat direct shot and a lobbed one. Prefer flatter.
    const low = Math.atan((v2 - root) / denom);
    const high = Math.atan((v2 + root) / denom);
    const elevation = Math.abs(low) <= Math.abs(high) ? low : high;

    // Back to screen space, where Y grows downward, mirrored when shooting left.
    return dx >= 0 ? -elevation : Math.PI + elevation;
  }

  /** Probes forward from the nock point for terrain blocking the shot. */
  private isObstructed(origin: { x: number; y: number }, angle: number): boolean {
    const end = {
      x: origin.x + Math.cos(angle) * AI.obstructionProbe,
      y: origin.y + Math.sin(angle) * AI.obstructionProbe,
    };
    const bodies = this.terrain();
    if (!bodies.length) return false;
    return Matter.Query.ray(bodies, origin, end, 3).length > 0;
  }

  private releaseShot(): void {
    this.bow.release();
    this.beginReaction();
  }

  /** Lets the string down without shooting, then re-plans. */
  private abandonShot(): void {
    this.bow.cancel();
    this.beginReaction();
  }

  reset(): void {
    this.bow.cancel();
    this.beginReaction();
  }

  get side_(): Side {
    return this.side;
  }
}
