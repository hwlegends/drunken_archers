import Matter from 'matter-js';
import { BOW } from '../config/constants';
import type { BowState, RagdollHandle, Side, Vec2 } from '../types';
import type { ProjectileSystem } from './ProjectileSystem';

/**
 * One per fighter. Turns a held/released button into a charged shot: charge
 * ramps while held, the shot leaves along whatever direction the wobbling bow
 * happens to point at the instant of release, and the bow reloads after a
 * delay. There is deliberately no aiming input beyond timing.
 */
export class BowController {
  readonly state: BowState;

  constructor(
    side: Side,
    private readonly ragdoll: RagdollHandle,
    private readonly projectiles: ProjectileSystem,
  ) {
    this.state = {
      side,
      phase: 'ready',
      charge: 0,
      reloadRemaining: 0,
      inputHeld: false,
      angle: ragdoll.bow.angle,
      launchPoint: { x: 0, y: 0 },
    };
    this.refreshAim();
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  /** Begins a draw. Ignored unless a fresh arrow is nocked and ready. */
  press(): boolean {
    if (this.ragdoll.dead) return false;
    // Guard against auto-repeat and double-charging.
    if (this.state.inputHeld) return false;
    this.state.inputHeld = true;
    if (this.state.phase !== 'ready') return false;
    this.state.phase = 'drawing';
    this.state.charge = 0;
    return true;
  }

  /**
   * Releases the string. Returns the shot's launch data, or null if no shot.
   *
   * `aim` substitutes an earlier bow pose for the current one. It exists for a
   * shot fired on another computer: that player let go against the bow they
   * could see, which is the bow as it stood a round trip ago. Firing along the
   * pose it has drifted to since would quietly punish them for their
   * connection, and this game is entirely about the instant of release.
   */
  release(aim?: { angle: number; position: Vec2 }): {
    angle: number;
    speed: number;
    charge: number;
    origin: Vec2;
  } | null {
    const wasHeld = this.state.inputHeld;
    this.state.inputHeld = false;
    if (!wasHeld || this.state.phase !== 'drawing') return null;
    if (this.ragdoll.dead) {
      this.state.phase = 'ready';
      this.state.charge = 0;
      return null;
    }
    return this.fire(aim);
  }

  /** Drops the draw without shooting — used on focus loss and pause. */
  cancel(): void {
    this.state.inputHeld = false;
    if (this.state.phase === 'drawing') {
      this.state.phase = 'ready';
      this.state.charge = 0;
    }
  }

  /* ---------------------------------------------------------------- *
   * Simulation
   * ---------------------------------------------------------------- */

  update(stepMs: number): void {
    this.refreshAim();

    if (this.ragdoll.dead) {
      this.state.phase = 'reloading';
      this.state.charge = 0;
      return;
    }

    switch (this.state.phase) {
      case 'reloading':
        this.state.reloadRemaining -= stepMs;
        if (this.state.reloadRemaining <= 0) {
          this.state.reloadRemaining = 0;
          this.state.phase = 'ready';
          // A button already held when the arrow arrives does not auto-fire;
          // the player must release and press again.
        }
        break;

      case 'drawing': {
        const perStep = stepMs / 1000 / BOW.timeToMaxCharge;
        // Charge stops at maximum rather than wrapping or overcharging.
        this.state.charge = Math.min(1, this.state.charge + perStep);
        break;
      }

      default:
        break;
    }
  }

  /** Recomputes the bow angle and nock point from the current arm pose. */
  private refreshAim(): void {
    const bow = this.ragdoll.bow;
    this.state.angle = bow.angle;
    const pull = this.state.phase === 'drawing' ? this.state.charge * BOW.maxStringPull : 0;
    const forward = BOW.nockOffset - pull * 0.35;
    this.state.launchPoint = {
      x: bow.position.x + Math.cos(bow.angle) * forward,
      y: bow.position.y + Math.sin(bow.angle) * forward,
    };
  }

  private fire(aim?: { angle: number; position: Vec2 }): {
    angle: number;
    speed: number;
    charge: number;
    origin: Vec2;
  } {
    const charge = this.state.charge;
    // Eased so a light tap is meaningfully weak and a full draw is decisive.
    const eased = Math.pow(charge, BOW.chargeEase);
    const speed = BOW.minLaunchSpeed + (BOW.maxLaunchSpeed - BOW.minLaunchSpeed) * eased;
    const angle = aim ? aim.angle : this.ragdoll.bow.angle;
    const from = aim ? aim.position : this.ragdoll.bow.position;

    const origin = {
      x: from.x + Math.cos(angle) * BOW.nockOffset,
      y: from.y + Math.sin(angle) * BOW.nockOffset,
    };

    this.projectiles.launch(this.state.side, origin, angle, speed);
    this.applyRecoil(angle, speed);

    this.state.phase = 'reloading';
    this.state.reloadRemaining = BOW.reloadDelayMs;
    this.state.charge = 0;

    return { angle, speed, charge, origin };
  }

  /** Kicks the hands and torso backwards so a heavy shot visibly unsteadies. */
  private applyRecoil(angle: number, speed: number): void {
    const magnitude = (speed / BOW.maxLaunchSpeed) * BOW.recoilScale;
    const back = { x: -Math.cos(angle), y: -Math.sin(angle) };

    for (const [body, scale] of [
      [this.ragdoll.bowHand, 1],
      [this.ragdoll.drawHand, 0.6],
      [this.ragdoll.torso, 0.45],
    ] as const) {
      Matter.Body.applyForce(body, body.position, {
        x: back.x * magnitude * body.mass * scale,
        y: back.y * magnitude * body.mass * scale,
      });
    }
    this.ragdoll.torso.torque += back.x * magnitude * 260;
  }

  /** True when the bow is loaded and not already drawing. */
  get canFire(): boolean {
    return this.state.phase === 'ready' && !this.ragdoll.dead;
  }

  /** Immediately nocks a fresh arrow — used when a round starts. */
  reset(): void {
    this.state.phase = 'ready';
    this.state.charge = 0;
    this.state.reloadRemaining = 0;
    this.state.inputHeld = false;
    this.refreshAim();
  }
}
