import Matter from 'matter-js';
import { COMBAT } from '../config/constants';
import type { BodyRegion, HitEvent, PlayerState, RagdollHandle, Side, Vec2 } from '../types';
import { bodySpeed } from './PhysicsWorld';
import type { ProjectileSystem } from './ProjectileSystem';

export interface CombatCallbacks {
  onHit: (hit: HitEvent) => void;
  onDefeat: (loser: Side, byHeadshot: boolean, byFall: boolean) => void;
  onTerrainHit: (point: Vec2) => void;
}

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

/**
 * Resolves arrow-versus-fighter collisions into damage, knockback and defeat,
 * following the ten-step pipeline in the specification. It is the only place
 * that may change health or award a point.
 */
export class CombatSystem {
  private defeated = new Set<Side>();

  constructor(
    private readonly projectiles: ProjectileSystem,
    private readonly callbacks: CombatCallbacks,
  ) {}

  reset(): void {
    this.defeated.clear();
  }

  /** Handles one Matter collision pair. Returns true if it was an arrow hit. */
  handleCollision(
    bodyA: Matter.Body,
    bodyB: Matter.Body,
    players: Record<Side, PlayerState>,
    ragdolls: Record<Side, RagdollHandle>,
  ): void {
    const arrowBody = this.asArrow(bodyA) ?? this.asArrow(bodyB);
    if (!arrowBody) return;
    const target = arrowBody === bodyA ? bodyB : bodyA;

    // 1. Confirm that the arrow is active.
    const projectile = this.projectiles.byBodyId(arrowBody.id);
    if (!projectile || !projectile.active || projectile.embedded) return;

    const contact: Vec2 = { x: arrowBody.position.x, y: arrowBody.position.y };
    const speed = bodySpeed(arrowBody);

    // Terrain: embed, no damage.
    if (target.isStatic) {
      this.projectiles.embed(projectile, target, contact);
      this.callbacks.onTerrainHit(contact);
      return;
    }

    const targetSide = this.sideOf(target, ragdolls);
    if (!targetSide) {
      this.projectiles.embed(projectile, target, contact);
      return;
    }

    // 2. Confirm that the target is not the still-protected shooter.
    if (targetSide === projectile.owner) return;

    // A fighter already down takes no further damage.
    if (this.defeated.has(targetSide) || ragdolls[targetSide].dead) {
      this.projectiles.embed(projectile, target, contact);
      return;
    }

    // 3. Confirm minimum impact velocity.
    if (speed < COMBAT.minDamagingSpeed) {
      this.projectiles.embed(projectile, target, contact);
      return;
    }

    // 4. Resolve the body region.
    const region = ragdolls[targetSide].regionOf.get(target.id) ?? 'torso';
    const damage = COMBAT.damage[region];
    const headshot = region === 'head';

    // 5. Apply damage and impact force.
    const player = players[targetSide];
    player.health = Math.max(0, player.health - damage);
    this.applyKnockback(target, ragdolls[targetSide], arrowBody, speed);

    const fatal = player.health <= 0;

    // 8. Mark the arrow as spent so it can never damage again.
    projectile.active = false;
    this.projectiles.embed(projectile, target, contact);

    // 6 + 7. Emit the impact effect and any HEADSHOT banner.
    this.callbacks.onHit({
      projectileId: projectile.id,
      shooter: projectile.owner,
      target: targetSide,
      region,
      damage,
      fatal,
      headshot: headshot && fatal,
      point: contact,
      speed,
    });

    // 9 + 10. Check defeat, awarding at most one point.
    if (fatal) this.defeat(targetSide, ragdolls, headshot, false);
  }

  /** Pushes the struck limb, plus a softer shove through the torso. */
  private applyKnockback(
    part: Matter.Body,
    ragdoll: RagdollHandle,
    arrow: Matter.Body,
    speed: number,
  ): void {
    const dir = Math.hypot(arrow.velocity.x, arrow.velocity.y) || 1;
    const nx = arrow.velocity.x / dir;
    const ny = arrow.velocity.y / dir;
    const power = speed * COMBAT.knockbackScale;

    Matter.Body.applyForce(part, part.position, {
      x: nx * power * part.mass,
      y: ny * power * part.mass,
    });

    const torsoPower = speed * COMBAT.torsoKnockbackScale;
    Matter.Body.applyForce(ragdoll.torso, ragdoll.torso.position, {
      x: nx * torsoPower * ragdoll.torso.mass,
      y: ny * torsoPower * ragdoll.torso.mass * 0.4,
    });
    ragdoll.torso.torque += nx * torsoPower * 220;
  }

  /** Checks the arena's fall boundary once per step. */
  checkFallBoundary(
    ragdolls: Record<Side, RagdollHandle>,
    players: Record<Side, PlayerState>,
    boundary: number,
  ): void {
    for (const side of ['left', 'right'] as Side[]) {
      const r = ragdolls[side];
      if (!r || r.dead || this.defeated.has(side)) continue;
      if (r.torso.position.y > boundary || r.head.position.y > boundary) {
        players[side].health = 0;
        this.defeat(side, ragdolls, false, true);
      }
    }
  }

  /** Marks a fighter defeated exactly once and releases their footing. */
  private defeat(side: Side, ragdolls: Record<Side, RagdollHandle>, headshot: boolean, byFall: boolean): void {
    if (this.defeated.has(side)) return;
    this.defeated.add(side);

    const ragdoll = ragdolls[side];
    ragdoll.dead = true;

    // Let the body go completely limp: drop the balance spring and the feet.
    // Matter applies a constraint's damping independently of its stiffness, so
    // both have to be zeroed or the body stays tethered to its anchors.
    for (const c of ragdoll.constraints) {
      if (!c.bodyA || !c.bodyB) {
        c.stiffness = 0;
        c.damping = 0;
      }
    }
    ragdoll.balance = null;

    // Hand the bow arm back to the solver so it drops with the rest of the body
    // and keeps hold of its bow. Nothing poses it once the archer is dead.
    for (const { constraint, stiffness, damping } of ragdoll.armJoints) {
      constraint.stiffness = stiffness;
      constraint.damping = damping;
    }

    this.callbacks.onDefeat(side, headshot, byFall);
  }

  isDefeated(side: Side): boolean {
    return this.defeated.has(side);
  }

  winnerOf(loser: Side): Side {
    return other(loser);
  }

  /** Region lookup used by the HUD and AI for target selection. */
  static regionDamage(region: BodyRegion): number {
    return COMBAT.damage[region];
  }

  private asArrow(body: Matter.Body): Matter.Body | null {
    return body.label.startsWith('arrow:') ? body : null;
  }

  private sideOf(body: Matter.Body, ragdolls: Record<Side, RagdollHandle>): Side | null {
    if (ragdolls.left?.regionOf.has(body.id)) return 'left';
    if (ragdolls.right?.regionOf.has(body.id)) return 'right';
    return null;
  }
}
