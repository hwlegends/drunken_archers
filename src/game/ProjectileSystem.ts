import Matter from 'matter-js';
import { CATEGORY, PROJECTILE } from '../config/constants';
import type { ArenaConfig, ProjectileState, Side, Vec2 } from '../types';
import { bodySpeed, toStepVelocity, type PhysicsWorld } from './PhysicsWorld';

let nextProjectileId = 1;

/**
 * Owns every arrow in flight: launch, in-flight orientation, embedding on
 * impact, and cleanup. Arrows are the only bodies that damage a fighter, and an
 * arrow can only ever do that once.
 */
export class ProjectileSystem {
  private projectiles: ProjectileState[] = [];
  private arena: ArenaConfig | null = null;

  constructor(private readonly physics: PhysicsWorld) {}

  setArena(arena: ArenaConfig): void {
    this.arena = arena;
  }

  list(): readonly ProjectileState[] {
    return this.projectiles;
  }

  byBodyId(id: number): ProjectileState | undefined {
    return this.projectiles.find((p) => p.body.id === id);
  }

  /**
   * Fires an arrow. `speed` is px/s and `angle` is the bow direction in radians.
   * During the grace period the arrow's collision mask omits the shooter, so it
   * genuinely passes through rather than being filtered after the fact.
   */
  launch(owner: Side, origin: Vec2, angle: number, speed: number): ProjectileState {
    this.enforceBudget(owner);

    const isLeft = owner === 'left';
    const category = isLeft ? CATEGORY.arrowLeft : CATEGORY.arrowRight;
    const enemyCategory = isLeft ? CATEGORY.ragdollRight : CATEGORY.ragdollLeft;

    const body = Matter.Bodies.rectangle(origin.x, origin.y, PROJECTILE.length, PROJECTILE.thickness, {
      label: 'arrow:' + owner,
      angle,
      density: PROJECTILE.density,
      frictionAir: PROJECTILE.frictionAir,
      friction: 0.4,
      restitution: 0,
      collisionFilter: {
        group: 0,
        category,
        // Shooter's own category is intentionally absent until grace expires.
        mask: CATEGORY.terrain | enemyCategory,
      },
    });

    Matter.Body.setVelocity(body, {
      x: toStepVelocity(Math.cos(angle) * speed),
      y: toStepVelocity(Math.sin(angle) * speed),
    });
    Matter.Body.setAngularVelocity(body, 0);

    const projectile: ProjectileState = {
      id: nextProjectileId++,
      body,
      owner,
      active: true,
      age: 0,
      lifetime: PROJECTILE.cleanupLifetimeMs,
      embedded: false,
      embedConstraint: null,
    };

    body.plugin = { projectileId: projectile.id, owner };
    this.projectiles.push(projectile);
    this.physics.add(body);
    return projectile;
  }

  /**
   * Recycles the oldest arrow when a side has too many alive at once.
   *
   * This must go through `remove`, not `destroy`: `destroy` only takes the body
   * out of the world and leaves the record in `projectiles`. Trimming that way
   * never shrinks the list, so once a side had fired `maxPerSide` arrows every
   * later shot deleted live arrows in flight and that side stopped landing hits.
   */
  private enforceBudget(owner: Side): void {
    const mine = this.projectiles.filter((p) => p.owner === owner);
    while (mine.length >= PROJECTILE.maxPerSide) {
      const oldest = mine.shift();
      if (oldest) this.remove(oldest);
    }
  }

  update(stepMs: number): void {
    const bounds = this.arena?.projectileBounds;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += stepMs;

      // Once the grace window closes the arrow becomes dangerous to everyone.
      if (p.age >= PROJECTILE.shooterGraceMs && !p.embedded) {
        const ownCategory = p.owner === 'left' ? CATEGORY.ragdollLeft : CATEGORY.ragdollRight;
        if ((p.body.collisionFilter.mask! & ownCategory) === 0) {
          p.body.collisionFilter.mask = p.body.collisionFilter.mask! | ownCategory;
        }
      }

      if (p.embedded) {
        p.lifetime -= stepMs;
        if (p.lifetime <= 0) {
          this.destroy(p);
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      if (bounds) {
        const { x, y } = p.body.position;
        if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
          this.destroy(p);
          this.projectiles.splice(i, 1);
          continue;
        }
      }

      // A stray arrow that never resolves still expires eventually.
      p.lifetime -= stepMs;
      if (p.lifetime <= 0) {
        this.destroy(p);
        this.projectiles.splice(i, 1);
      }
    }
  }

  /**
   * Turns every arrow in flight to face its velocity. Called after the solver
   * has run for the frame, so the drawn angle matches the arrow's actual
   * heading rather than lagging it by one step.
   */
  syncOrientation(): void {
    for (const p of this.projectiles) {
      if (p.embedded) continue;
      if (bodySpeed(p.body) < 12) continue;
      Matter.Body.setAngle(p.body, Math.atan2(p.body.velocity.y, p.body.velocity.x));
      Matter.Body.setAngularVelocity(p.body, 0);
    }
  }

  /**
   * Pins an arrow to whatever it struck with a temporary constraint, so it
   * sticks out of the target and is dragged along by it.
   */
  embed(p: ProjectileState, target: Matter.Body, contact: Vec2): void {
    if (p.embedded) return;
    p.embedded = true;
    p.active = false;
    p.lifetime = PROJECTILE.cleanupLifetimeMs;

    // Stop dead at the contact point, then weld.
    Matter.Body.setVelocity(p.body, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(p.body, 0);
    p.body.collisionFilter.mask = 0;

    if (target.isStatic) {
      // Terrain: a world-anchored pin is cheaper and perfectly stable.
      p.embedConstraint = Matter.Constraint.create({
        pointA: { x: p.body.position.x, y: p.body.position.y },
        bodyB: p.body,
        pointB: { x: 0, y: 0 },
        length: 0,
        stiffness: 1,
        render: { visible: false },
      });
    } else {
      const local = {
        x: contact.x - target.position.x,
        y: contact.y - target.position.y,
      };
      const cos = Math.cos(-target.angle);
      const sin = Math.sin(-target.angle);
      p.embedConstraint = Matter.Constraint.create({
        bodyA: target,
        pointA: { x: local.x * cos - local.y * sin, y: local.x * sin + local.y * cos },
        bodyB: p.body,
        pointB: { x: -PROJECTILE.length * 0.3, y: 0 },
        length: 0,
        stiffness: 0.9,
        damping: 0.2,
        render: { visible: false },
      });
    }
    this.physics.add(p.embedConstraint);
  }

  private destroy(p: ProjectileState): void {
    if (p.embedConstraint) {
      this.physics.remove(p.embedConstraint);
      p.embedConstraint = null;
    }
    this.physics.remove(p.body);
    p.active = false;
  }

  /** Removes an arrow immediately, including from the live list. */
  remove(p: ProjectileState): void {
    const index = this.projectiles.indexOf(p);
    if (index >= 0) this.projectiles.splice(index, 1);
    this.destroy(p);
  }

  clear(): void {
    for (const p of this.projectiles) this.destroy(p);
    this.projectiles = [];
  }
}
