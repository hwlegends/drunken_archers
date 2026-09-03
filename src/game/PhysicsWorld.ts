import Matter from 'matter-js';
import { CATEGORY, PHYSICS, TIME, VIEW } from '../config/constants';
import type { ArenaConfig } from '../types';

/**
 * Matter.js works in pixels-per-step, not pixels-per-second, and applies gravity
 * as `mass * gravity.y * gravity.scale`. The spec states everything in px/s and
 * px/s², so all conversion is funnelled through the helpers below — no other
 * module should touch Matter's raw units.
 *
 * Derivation for gravity: with a fixed step of `dt` ms, the velocity gained per
 * step is `g * scale * dt²` px/step, which is `g * scale * dt² * 3600` px/s².
 * At dt = 16.667 that reduces to `g * scale * 1e6`.
 */
const GRAVITY_SCALE = 0.001;
const STEPS_PER_SECOND = 1000 / TIME.step;

/** px/s -> Matter px/step */
export const toStepVelocity = (pxPerSecond: number): number => pxPerSecond / STEPS_PER_SECOND;

/** Matter px/step -> px/s */
export const toSecondVelocity = (pxPerStep: number): number => pxPerStep * STEPS_PER_SECOND;

/**
 * The force Matter adds to a body each step as gravity, per unit of mass.
 * Applying its negative exactly cancels gravity for that body.
 */
export const GRAVITY_FORCE_PER_MASS = (PHYSICS.gravity / (GRAVITY_SCALE * 1e6)) * GRAVITY_SCALE;

/** Speed of a body in px/s. */
export function bodySpeed(body: Matter.Body): number {
  return toSecondVelocity(Math.hypot(body.velocity.x, body.velocity.y));
}

export class PhysicsWorld {
  readonly engine: Matter.Engine;
  readonly world: Matter.World;

  private accumulator = 0;
  private terrain: Matter.Body[] = [];

  constructor() {
    this.engine = Matter.Engine.create({
      positionIterations: PHYSICS.positionIterations,
      velocityIterations: PHYSICS.velocityIterations,
      constraintIterations: PHYSICS.constraintIterations,
      enableSleeping: false,
    });
    this.world = this.engine.world;
    this.engine.gravity.scale = GRAVITY_SCALE;
    this.engine.gravity.y = PHYSICS.gravity / (GRAVITY_SCALE * 1e6);
    this.engine.gravity.x = 0;
  }

  /* ---------------------------------------------------------------- *
   * Terrain
   * ---------------------------------------------------------------- */

  /** Rebuilds the static collision bodies for an arena. */
  buildTerrain(arena: ArenaConfig): void {
    this.clearTerrain();

    const make = (x: number, y: number, w: number, h: number, label: string) =>
      Matter.Bodies.rectangle(x, y, w, h, {
        isStatic: true,
        label,
        friction: 0.35,
        restitution: 0,
        collisionFilter: {
          category: CATEGORY.terrain,
          mask: 0xffffffff,
        },
      });

    for (const key of ['left', 'right'] as const) {
      const p = arena.platforms[key];
      // The standing surface.
      this.terrain.push(make(p.x, p.topY + 18, p.width, 36, `terrain:${key}:top`));
      // The column below it, so an arrow that misses still buries into rock.
      const columnHeight = VIEW.height + 200 - p.topY;
      this.terrain.push(
        make(p.x, p.topY + 36 + columnHeight / 2, p.width * 0.62, columnHeight, `terrain:${key}:column`),
      );
    }

    Matter.Composite.add(this.world, this.terrain);
  }

  private clearTerrain(): void {
    if (this.terrain.length) {
      Matter.Composite.remove(this.world, this.terrain);
      this.terrain = [];
    }
  }

  getTerrain(): Matter.Body[] {
    return this.terrain;
  }

  /* ---------------------------------------------------------------- *
   * Stepping
   * ---------------------------------------------------------------- */

  /**
   * Advances the simulation with a fixed timestep. `onStep` runs once per
   * simulation step so systems tick at a stable rate regardless of frame rate;
   * `afterStep` runs once per step after the solver, for anything that must own
   * the final transform rather than have the solver perturb it.
   * Returns the render interpolation alpha for the leftover time.
   */
  update(
    frameDeltaMs: number,
    onStep: (stepMs: number) => void,
    afterStep?: (stepMs: number) => void,
  ): number {
    // A tab that was hidden, or a long stall, must not unleash a burst of steps.
    const delta = Math.min(frameDeltaMs, TIME.maxFrameDelta);
    this.accumulator += delta;

    let steps = 0;
    while (this.accumulator >= TIME.step && steps < TIME.maxCatchUpSteps) {
      onStep(TIME.step);
      Matter.Engine.update(this.engine, TIME.step);
      afterStep?.(TIME.step);
      this.accumulator -= TIME.step;
      steps++;
    }

    // Drop any remaining backlog rather than spiralling on a slow device.
    if (this.accumulator > TIME.step * TIME.maxCatchUpSteps) {
      this.accumulator = 0;
    }

    return this.accumulator / TIME.step;
  }

  /** Discards accumulated time so resuming from pause does not jump forward. */
  resetClock(): void {
    this.accumulator = 0;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  add(item: Matter.Body | Matter.Constraint | Matter.Composite): void {
    Matter.Composite.add(this.world, item as Matter.Body);
  }

  remove(item: Matter.Body | Matter.Constraint | Matter.Composite): void {
    Matter.Composite.remove(this.world, item as Matter.Body, true);
  }

  onCollisionStart(handler: (event: Matter.IEventCollision<Matter.Engine>) => void): () => void {
    Matter.Events.on(this.engine, 'collisionStart', handler);
    return () => Matter.Events.off(this.engine, 'collisionStart', handler);
  }

  /** Removes every body and constraint, leaving a reusable empty world. */
  clear(): void {
    Matter.Composite.clear(this.world, false, true);
    this.terrain = [];
    this.accumulator = 0;
  }

  destroy(): void {
    Matter.Events.off(this.engine, undefined as never, undefined as never);
    Matter.Composite.clear(this.world, false, true);
    Matter.Engine.clear(this.engine);
    this.terrain = [];
  }
}
