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
 * The drunkenness.
 *
 * Three uncoupled motions run at deliberately unrelated periods so the archer
 * never settles into a rhythm a player can memorise:
 *
 *  - the torso rocks under a slow alternating torque, fighting an upright spring;
 *  - the balance anchor wanders a Lissajous figure, so the body leans *and*
 *    bobs rather than sliding along a single left-right line;
 *  - the bow arm sweeps up and down through its own swing.
 *
 * That last one is the game. The bow angle at the instant of release is the
 * shot direction, so the arm must genuinely move — a servo that pinned it level
 * would leave nothing to time.
 */
export class SwayController {
  private jitterTimers = new Map<RagdollHandle, number>();

  /** @param stepMs fixed simulation step in milliseconds */
  update(handle: RagdollHandle, stepMs: number): void {
    if (handle.dead) return;

    const dt = stepMs / 1000;
    handle.wobblePhase += (dt / RAGDOLL.swayPeriod) * Math.PI * 2;
    handle.armPhase += (dt / RAGDOLL.armSwingPeriod) * Math.PI * 2;

    const torso = handle.torso;

    // The archer actively fights to stay upright: a restoring torque toward
    // vertical plus angular drag. Without this the sway just topples them.
    const lean = wrapAngle(torso.angle);
    torso.torque += -lean * RAGDOLL.uprightTorque * torso.inertia;
    torso.torque += -torso.angularVelocity * RAGDOLL.uprightDamping * torso.inertia;

    // Low-frequency alternating torque. Two detuned sine waves keep the motion
    // from reading as a clean oscillation.
    const primary = Math.sin(handle.wobblePhase);
    const secondary = Math.sin(handle.wobblePhase * 0.41 + handle.wobbleSeed) * 0.45;
    torso.torque += (primary + secondary) * RAGDOLL.swayTorque;

    this.keepStance(handle);
    this.driftBalance(handle);

    // Sparse random impulses.
    const remaining = (this.jitterTimers.get(handle) ?? 0) - stepMs;
    if (remaining <= 0) {
      this.jitterTimers.set(handle, RAGDOLL.jitterIntervalMs * (0.5 + Math.random()));
      const target = Math.random() < 0.6 ? torso : handle.parts.upperArmFront;
      Matter.Body.applyForce(target, target.position, {
        x: (Math.random() - 0.5) * RAGDOLL.jitterImpulse * target.mass * 1000,
        y: (Math.random() - 0.5) * RAGDOLL.jitterImpulse * target.mass * 600,
      });
      torso.torque += (Math.random() - 0.5) * RAGDOLL.swayTorque * 1.4;
    } else {
      this.jitterTimers.set(handle, remaining);
    }
  }

  /**
   * Holds the legs under the hips. The ankles are pinned, so without this the
   * whole body swings about them like an inverted pendulum and the archer looks
   * like it is lunging rather than standing and swaying.
   */
  private keepStance(handle: RagdollHandle): void {
    for (const name of ['upperLegFront', 'upperLegBack', 'lowerLegFront', 'lowerLegBack']) {
      const leg = handle.parts[name];
      if (!leg) continue;
      const lean = wrapAngle(leg.angle);
      leg.torque += -lean * RAGDOLL.legUprightTorque * leg.inertia;
      leg.torque += -leg.angularVelocity * RAGDOLL.legUprightDamping * leg.inertia;
    }
  }

  /**
   * Walks the balance anchor around a Lissajous path. Because the feet stay
   * pinned, moving the anchor makes the whole body lean, bob and shift its
   * weight instead of translating along one axis.
   */
  private driftBalance(handle: RagdollHandle): void {
    const balance = handle.balance;
    if (!balance) return;

    // Reuse the wobble phase for X and a faster, offset phase for Y.
    const t = handle.wobblePhase;
    const ratio = RAGDOLL.swayPeriod / RAGDOLL.balanceDriftPeriod.x;
    const ratioY = RAGDOLL.swayPeriod / RAGDOLL.balanceDriftPeriod.y;

    balance.pointA = {
      x: handle.balanceAnchor.x + Math.sin(t * ratio + handle.wobbleSeed) * RAGDOLL.balanceDrift.x,
      y: handle.balanceAnchor.y + Math.sin(t * ratioY + handle.wobbleSeed * 1.7) * RAGDOLL.balanceDrift.y,
    };
  }

  /**
   * Poses the bow arm. Runs *after* the solver: every body is placed from the
   * torso's own final transform, so all the arm's joints come out satisfied and
   * nothing is left for the next step to fight. Posing before the solver instead
   * left a standing offset and pumped energy into the ragdoll.
   *
   * The upper arm, forearm and bow are placed along a ray
   * from the shoulder whose elevation sweeps up and down, and the arm is eased
   * toward that pose rather than snapped to it, so an arrow strike still shoves
   * it visibly before it recovers.
   *
   * The angle is measured in the torso's frame, so the body's lean adds to the
   * arm's own swing — the whole drunken motion feeds the bow, which is the
   * thing the player is timing. A dead archer is never posed, so the arm simply
   * goes limp on its joints.
   */
  poseBowArm(handle: RagdollHandle, enemyX: number): void {
    if (handle.dead) return;
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
    const shoulder = {
      x: torso.position.x + sx * cos - sy * sin,
      y: torso.position.y + sx * sin + sy * cos,
    };

    // A limb's long axis is local +Y, so this angle points it forward and
    // `lift` radians above horizontal, relative to however the torso is leaning.
    const limbAngle = torso.angle - facing * (Math.PI / 2 + lift);
    const dir = { x: -Math.sin(limbAngle), y: Math.cos(limbAngle) };

    const upper = handle.parts.upperArmFront;
    const fore = handle.parts.lowerArmFront;
    const reachUpper = RAGDOLL.upperArm.h / 2;
    const reachFore = RAGDOLL.upperArm.h + RAGDOLL.lowerArm.h / 2;
    const reachHand = RAGDOLL.upperArm.h + RAGDOLL.lowerArm.h;

    this.poseTo(upper, shoulder, dir, reachUpper, limbAngle, torso);
    this.poseTo(fore, shoulder, dir, reachFore, limbAngle, torso);
    // The bow's local +X is the shot direction, a quarter turn from the limb.
    this.poseTo(handle.bow, shoulder, dir, reachHand, limbAngle + Math.PI / 2, torso);
  }

  /** Eases one body toward a point on the aim ray and a target angle. */
  private poseTo(
    body: Matter.Body,
    shoulder: { x: number; y: number },
    dir: { x: number; y: number },
    distance: number,
    angle: number,
    torso: Matter.Body,
  ): void {
    const rate = RAGDOLL.armTrackRate;
    const targetX = shoulder.x + dir.x * distance;
    const targetY = shoulder.y + dir.y * distance;

    Matter.Body.setPosition(body, {
      x: body.position.x + (targetX - body.position.x) * rate,
      y: body.position.y + (targetY - body.position.y) * rate,
    });

    // Always turn the short way round, so the angle can never wind up.
    const delta = wrapAngle(angle - body.angle);
    Matter.Body.setAngle(body, body.angle + delta * rate);

    // Carry the torso's motion so contacts read sensibly, and never spin.
    Matter.Body.setVelocity(body, { x: torso.velocity.x, y: torso.velocity.y });
    Matter.Body.setAngularVelocity(body, 0);
  }

  forget(handle: RagdollHandle): void {
    this.jitterTimers.delete(handle);
  }

  reset(): void {
    this.jitterTimers.clear();
  }
}
