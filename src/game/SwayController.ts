import Matter from 'matter-js';
import { RAGDOLL } from '../config/constants';
import { GRAVITY_FORCE_PER_MASS } from './PhysicsWorld';
import type { RagdollHandle } from '../types';

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
  update(handle: RagdollHandle, stepMs: number, enemyX: number): void {
    if (handle.dead) return;

    const dt = stepMs / 1000;
    handle.wobblePhase += (dt / RAGDOLL.swayPeriod) * Math.PI * 2;
    handle.armPhase += (dt / RAGDOLL.armSwingPeriod) * Math.PI * 2;

    const torso = handle.torso;

    // The archer actively fights to stay upright: a restoring torque toward
    // vertical plus angular drag. Without this the sway just topples them.
    let lean = torso.angle;
    while (lean > Math.PI) lean -= Math.PI * 2;
    while (lean < -Math.PI) lean += Math.PI * 2;
    torso.torque += -lean * RAGDOLL.uprightTorque * torso.inertia;
    torso.torque += -torso.angularVelocity * RAGDOLL.uprightDamping * torso.inertia;

    // Low-frequency alternating torque. Two detuned sine waves keep the motion
    // from reading as a clean oscillation.
    const primary = Math.sin(handle.wobblePhase);
    const secondary = Math.sin(handle.wobblePhase * 0.41 + handle.wobbleSeed) * 0.45;
    torso.torque += (primary + secondary) * RAGDOLL.swayTorque;

    this.keepStance(handle);
    this.driftBalance(handle);
    this.swingBowArm(handle, enemyX);

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
      let lean = leg.angle;
      while (lean > Math.PI) lean -= Math.PI * 2;
      while (lean < -Math.PI) lean += Math.PI * 2;
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
   * Sweeps the bow arm by walking its aim anchor up and down an arc centred on
   * the shoulder. The anchor lives in torso-local space, so it leans with the
   * body; the arm chases it and drags the welded bow through a real range of
   * firing angles. This sweep is the thing the player is timing.
   */
  private swingBowArm(handle: RagdollHandle, enemyX: number): void {
    const aim = handle.aim;
    if (!aim) return;

    const facing = Math.sign(enemyX - handle.torso.position.x) || handle.facing;
    const swing =
      Math.sin(handle.armPhase) * RAGDOLL.armSwingAmplitude +
      Math.sin(handle.armPhase * RAGDOLL.armSwingWobbleRatio + handle.wobbleSeed) *
        RAGDOLL.armSwingWobble;

    const lift = RAGDOLL.armLift + swing;
    const anchor = (distance: number) => ({
      x: facing * (3 + distance * Math.cos(lift)),
      y: -RAGDOLL.torso.h / 2 + 5 - distance * Math.sin(lift),
    });

    aim.pointA = anchor(RAGDOLL.aimReach);
    if (handle.aimElbow) handle.aimElbow.pointA = anchor(RAGDOLL.upperArm.h);

    // Take the weight of the bow arm and the bow it carries, so the aim link
    // only has to steer the arm rather than hold it up.
    for (const body of [handle.parts.upperArmFront, handle.parts.lowerArmFront, handle.bow]) {
      Matter.Body.applyForce(body, body.position, {
        x: 0,
        y: -body.mass * GRAVITY_FORCE_PER_MASS,
      });
    }
  }

  forget(handle: RagdollHandle): void {
    this.jitterTimers.delete(handle);
  }

  reset(): void {
    this.jitterTimers.clear();
  }
}
