import Matter from 'matter-js';
import { RAGDOLL, STEP } from '../config/constants';
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
      // The swing speed drifts, and now and then dips negative for a moment so
      // the archer checks and reverses mid-sweep. Eased rather than stepped, so
      // it reads as unsteadiness rather than a glitch.
      handle.swingRateTimer -= stepMs;
      if (handle.swingRateTimer <= 0) {
        handle.swingRateTimer = RAGDOLL.swingRateChangeMs * (0.6 + Math.random() * 0.8);
        handle.swingRateTarget =
          Math.random() < RAGDOLL.swingReverseChance
            ? -Math.random() * 0.3
            : 1 + (Math.random() * 2 - 1) * RAGDOLL.swingRateJitter;
      }
      handle.swingRate += (handle.swingRateTarget - handle.swingRate) * Math.min(1, dt * 2.5);

      handle.wobblePhase += (dt / RAGDOLL.swingPeriod) * Math.PI * 2 * handle.swingRate;
      handle.armPhase += (dt / RAGDOLL.armSwingPeriod) * Math.PI * 2;
    }

    // Balance recovers between hits, so only a quick pair of solid strikes
    // actually knocks an archer off its feet.
    if (handle.balanceLoss > 0) {
      handle.balanceLoss = Math.max(0, handle.balanceLoss - RAGDOLL.toppleRecoveryPerSecond * dt);
    }

    this.advanceStep(handle, stepMs);
  }

  /**
   * Carries a sidestep along, if one is running.
   *
   * The pivot is what every standing part is placed relative to, so moving it is
   * the whole of the move: the body travels as one piece and the legs are re-laid
   * along the way by the pose, exactly as they are when the archer leans. Nothing
   * is pushed, so nothing can be knocked out of balance by stepping.
   */
  private advanceStep(handle: RagdollHandle, stepMs: number): void {
    if (handle.stepCooldown > 0) {
      handle.stepCooldown = Math.max(0, handle.stepCooldown - stepMs);
    }
    if (handle.stepElapsed < 0) return;

    handle.stepElapsed += stepMs;
    const progress = Math.min(1, handle.stepElapsed / STEP.durationMs);
    // Eased out: the foot leaves quickly and settles, which reads as a step
    // rather than the archer being slid along on ice.
    const eased = 1 - (1 - progress) * (1 - progress);
    handle.pivot.x = handle.stepFromX + (handle.stepToX - handle.stepFromX) * eased;

    if (progress >= 1) handle.stepElapsed = -1;
  }

  /**
   * Starts a sidestep. Returns false if the archer cannot take one — already
   * mid-step, still on cooldown, off its feet, or out of platform.
   */
  static step(handle: RagdollHandle, direction: -1 | 1): boolean {
    if (!handle.standing || handle.dead) return false;
    if (handle.stepElapsed >= 0 || handle.stepCooldown > 0) return false;

    const from = handle.pivot.x;
    const to = Math.max(
      handle.stepBounds.minX,
      Math.min(handle.stepBounds.maxX, from + direction * STEP.distance),
    );
    // Already against the edge: refuse rather than burn the cooldown on nothing.
    if (Math.abs(to - from) < 0.5) return false;

    handle.stepFromX = from;
    handle.stepToX = to;
    handle.stepElapsed = 0;
    handle.stepCooldown = STEP.cooldownMs;
    return true;
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
    const legTheta = theta * RAGDOLL.legShare;
    const { x: px, y: py } = handle.pivot;

    // Legs lean about the feet, the upper body about the hips. The upper body
    // leans further, so the archer folds slightly at the waist rather than
    // tipping as one rigid plank.
    const lc = Math.cos(legTheta);
    const ls = Math.sin(legTheta);
    const hip = handle.hipOffset;
    const hipX = px + hip.x * lc - hip.y * ls;
    const hipY = py + hip.x * ls + hip.y * lc;

    const bc = Math.cos(theta);
    const bs = Math.sin(theta);

    for (const { body, offset, angle, isLeg } of handle.restPose) {
      if (isLeg) {
        this.place(
          body,
          px + offset.x * lc - offset.y * ls,
          py + offset.x * ls + offset.y * lc,
          angle + legTheta,
          RAGDOLL.poseTrackRate,
        );
      } else {
        const ox = offset.x - hip.x;
        const oy = offset.y - hip.y;
        this.place(
          body,
          hipX + ox * bc - oy * bs,
          hipY + ox * bs + oy * bc,
          angle + theta,
          RAGDOLL.poseTrackRate,
        );
      }
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
    // A step in progress is pose-space motion, and there is no pose any more.
    handle.stepElapsed = -1;
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
