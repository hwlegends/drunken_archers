import Matter from 'matter-js';
import { RAGDOLL } from '../config/constants';
import type { RagdollHandle } from '../types';

/**
 * The drunkenness. A slow alternating torque rocks the torso while sparse
 * random impulses break the periodicity, so the bow angle never settles into a
 * rhythm a player can memorise — timing the sway is the core skill.
 */
export class SwayController {
  private jitterTimers = new Map<RagdollHandle, number>();

  /** @param stepMs fixed simulation step in milliseconds */
  update(handle: RagdollHandle, stepMs: number, enemyX: number): void {
    if (handle.dead) return;

    const dt = stepMs / 1000;
    handle.wobblePhase += (dt / RAGDOLL.swayPeriod) * Math.PI * 2;

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

    // Keep the bow arm raised toward the enemy so shots stay roughly on plane.
    this.applyAimAssist(handle, enemyX);

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
   * A weak torque on the shooting arm, pulling the bow toward the horizontal
   * plane of the enemy. Deliberately far too weak to actually aim — it only
   * stops the arm from hanging limp at the archer's side.
   */
  private applyAimAssist(handle: RagdollHandle, enemyX: number): void {
    const arm = handle.parts.upperArmFront;
    const forearm = handle.parts.lowerArmFront;
    const wantFacing = Math.sign(enemyX - handle.torso.position.x) || handle.facing;

    // Desired limb angle: pointing horizontally toward the enemy.
    const desired = -wantFacing * Math.PI * 0.5;
    for (const [body, scale] of [
      [arm, 1],
      [forearm, 0.7],
    ] as const) {
      let delta = desired - body.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      body.torque += delta * RAGDOLL.aimTorque * body.mass * scale;
    }
  }

  forget(handle: RagdollHandle): void {
    this.jitterTimers.delete(handle);
  }

  reset(): void {
    this.jitterTimers.clear();
  }
}
