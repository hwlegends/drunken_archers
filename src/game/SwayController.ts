import Matter from 'matter-js';
import { RAGDOLL } from '../config/constants';
import type { RagdollHandle } from '../types';

/**
 * Wraps an angle into (-PI, PI]. Done arithmetically rather than with a
 * subtract-until loop, which never terminates if the simulation ever hands it a
 * non-finite angle — that would hard-freeze the tab rather than just look wrong.
 */
const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * The drunkenness, in two layers.
 *
 * The body swings as one rigid piece about a pivot between the feet, like a
 * metronome tipping from one foot to the other. That is deliberately readable:
 * a player can watch the swing and anticipate where the archer will be, which
 * loose independently-wobbling limbs never allowed.
 *
 * On top of that the bow arm sweeps up and down on its own, unrelated period.
 * The bow angle at the instant of release is the shot direction, so that sweep
 * is what the player is really timing — the body swing says *where* the target
 * is, the arm sweep decides *when* you can hit it.
 *
 * Both layers are posed directly rather than solved for, and only while the
 * archer is standing. Once it topples or dies nothing poses it, its joints are
 * handed back to the solver, and it becomes an ordinary ragdoll.
 */
export class SwayController {
  /** Advances each archer's phases. Runs before the solver step. */
  update(handle: RagdollHandle, stepMs: number): void {
    const dt = stepMs / 1000;

    if (handle.standing && !handle.dead) {
      handle.wobblePhase += (dt / RAGDOLL.swingPeriod) * Math.PI * 2;
      handle.armPhase += (dt / RAGDOLL.armSwingPeriod) * Math.PI * 2;
    }

    // Balance recovers between hits, so only a quick pair of solid strikes
    // actually knocks an archer off its feet.
    if (handle.balanceLoss > 0) {
      handle.balanceLoss = Math.max(0, handle.balanceLoss - RAGDOLL.toppleRecoveryPerSecond * dt);
    }
  }

  /**
   * Poses the whole archer. Runs *after* the solver, so each body owns its final
   * transform for the step and nothing is left for the next step to fight.
   */
  pose(handle: RagdollHandle, enemyX: number): void {
    if (!handle.standing || handle.dead) return;
    this.poseBody(handle);
    this.poseBowArm(handle, enemyX);
  }

  /** The angle this archer is currently leaning at, in radians. */
  swingAngle(handle: RagdollHandle): number {
    // Shaped rather than a plain sine: a sine dwells near its peaks, which at a
    // wide amplitude leaves the archer lying over at full lean most of the time
    // instead of staggering through it.
    const raw = Math.sin(handle.wobblePhase);
    const shaped = Math.sign(raw) * Math.abs(raw) ** RAGDOLL.swingShape;

    return (
      shaped * RAGDOLL.swingAmplitude +
      Math.sin(handle.wobblePhase * RAGDOLL.swingDetuneRatio + handle.wobbleSeed) *
        RAGDOLL.swingDetune
    );
  }

  /**
   * Rotates every part rigidly about the foot pivot. Because the whole body
   * turns together, the archer tips from one foot to the other as a single
   * piece instead of the legs folding underneath it.
   */
  private poseBody(handle: RagdollHandle): void {
    const theta = this.swingAngle(handle);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const { x: px, y: py } = handle.pivot;

    for (const { body, offset, angle } of handle.restPose) {
      this.place(
        body,
        px + offset.x * cos - offset.y * sin,
        py + offset.x * sin + offset.y * cos,
        angle + theta,
        RAGDOLL.poseTrackRate,
      );
    }
  }

  /**
   * Sweeps the bow arm on top of the body swing. The upper arm, forearm and bow
   * are placed along a ray from the shoulder whose elevation rises and falls,
   * measured in the torso's frame so the body's lean feeds into the aim.
   */
  private poseBowArm(handle: RagdollHandle, enemyX: number): void {
    const torso = handle.torso;
    const facing = Math.sign(enemyX - torso.position.x) || handle.facing;

    const swing =
      Math.sin(handle.armPhase) * RAGDOLL.armSwingAmplitude +
      Math.sin(handle.armPhase * RAGDOLL.armSwingWobbleRatio + handle.wobbleSeed) *
        RAGDOLL.armSwingWobble;
    const lift = RAGDOLL.armLift + swing;

    // Shoulder, in world space.
    const cos = Math.cos(torso.angle);
    const sin = Math.sin(torso.angle);
    const sx = facing * 3;
    const sy = -RAGDOLL.torso.h / 2 + 5;
    const shoulderX = torso.position.x + sx * cos - sy * sin;
    const shoulderY = torso.position.y + sx * sin + sy * cos;

    // A limb's long axis is local +Y, so this angle points it forward and
    // `lift` radians above horizontal, relative to however the torso is leaning.
    const limbAngle = torso.angle - facing * (Math.PI / 2 + lift);
    const dirX = -Math.sin(limbAngle);
    const dirY = Math.cos(limbAngle);

    const rate = RAGDOLL.armTrackRate;
    const along = (distance: number, angle: number, body: Matter.Body) =>
      this.place(body, shoulderX + dirX * distance, shoulderY + dirY * distance, angle, rate);

    along(RAGDOLL.upperArm.h / 2, limbAngle, handle.parts.upperArmFront);
    along(RAGDOLL.upperArm.h + RAGDOLL.lowerArm.h / 2, limbAngle, handle.parts.lowerArmFront);
    // The bow's local +X is the shot direction, a quarter turn from the limb.
    along(RAGDOLL.upperArm.h + RAGDOLL.lowerArm.h, limbAngle + Math.PI / 2, handle.bow);
  }

  /**
   * Eases one body toward a target transform. Blending rather than snapping is
   * what keeps a struck archer visibly springy: an arrow's impulse shoves the
   * body for a few frames before the pose draws it back.
   */
  private place(body: Matter.Body, x: number, y: number, angle: number, rate: number): void {
    const fromX = body.position.x;
    const fromY = body.position.y;
    const toX = fromX + (x - fromX) * rate;
    const toY = fromY + (y - fromY) * rate;

    Matter.Body.setPosition(body, { x: toX, y: toY });
    // Always turn the short way round, so the angle can never wind up.
    Matter.Body.setAngle(body, body.angle + wrapAngle(angle - body.angle) * rate);

    // Report the motion actually travelled, so contacts read sensibly.
    Matter.Body.setVelocity(body, { x: toX - fromX, y: toY - fromY });
    Matter.Body.setAngularVelocity(body, 0);
  }

  /**
   * Hands an archer back to the solver: its joints go live and nothing poses it
   * again. Used both when a hit knocks it off its feet and when it is defeated.
   */
  static releaseRagdoll(handle: RagdollHandle): void {
    if (!handle.standing) return;
    handle.standing = false;
    for (const { constraint, stiffness, damping } of handle.joints) {
      constraint.stiffness = stiffness;
      constraint.damping = damping;
    }
  }

  /**
   * Adds destabilisation from a hit. Returns true if this was the blow that
   * took the archer off its feet.
   */
  static addBalanceLoss(handle: RagdollHandle, amount: number): boolean {
    if (!handle.standing) return false;
    handle.balanceLoss += amount;
    if (handle.balanceLoss < RAGDOLL.toppleThreshold) return false;
    SwayController.releaseRagdoll(handle);
    return true;
  }

  reset(): void {
    /* no cached per-archer state */
  }
}
