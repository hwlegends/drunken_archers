import Matter from 'matter-js';
import { AI, COMBAT, DEATHMATCH_SKINS, MATCH, SKINS, TIME, VIEW, type Skin } from '../config/constants';
import type {
  ArenaConfig,
  GameMode,
  GameSettings,
  HitEvent,
  PlayerState,
  RagdollHandle,
  Side,
  Vec2,
} from '../types';
import { AIController } from './AIController';
import { ArenaManager } from './ArenaManager';
import { audioManager } from './AudioManager';
import { BowController } from './BowController';
import { CameraController } from './CameraController';
import { CombatSystem } from './CombatSystem';
import { InputManager } from './InputManager';
import { ParticleSystem } from './ParticleSystem';
import { PhysicsWorld } from './PhysicsWorld';
import { ProjectileSystem } from './ProjectileSystem';
import { RagdollFactory } from './RagdollFactory';
import { Renderer } from './Renderer';
import { SwayController } from './SwayController';

/**
 * Low-frequency events the engine pushes up to React. Nothing per-frame ever
 * crosses this boundary — body transforms stay inside the canvas layer.
 */
export interface EngineEvents {
  onHealth: (left: number, right: number) => void;
  onScores: (scores: Record<Side, number>) => void;
  onRoundOver: (winner: Side, loser: Side, byHeadshot: boolean, byFall: boolean, scores: Record<Side, number>) => void;
  onMatchOver: (winner: Side) => void;
  onDeathmatchScore: (score: number, encounter: number) => void;
  onDeathmatchOver: (score: number) => void;
  onAnnounce: (kind: 'fight' | 'headshot' | 'point' | 'ko', text: string, duration: number, side?: Side) => void;
  onRoundIntro: () => void;
  onPlay: () => void;
  onPauseRequest: () => void;
}

const OTHER: Record<Side, Side> = { left: 'right', right: 'left' };
const SIDES: Side[] = ['left', 'right'];

export class GameEngine {
  private readonly physics = new PhysicsWorld();
  private readonly arenas = new ArenaManager();
  private readonly camera = new CameraController();
  private readonly particles = new ParticleSystem();
  private readonly renderer = new Renderer(this.camera);
  private readonly sway = new SwayController();
  private readonly ragdollFactory = new RagdollFactory(this.physics);
  private readonly projectiles = new ProjectileSystem(this.physics);
  private readonly combat: CombatSystem;
  private readonly input: InputManager;

  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private elapsed = 0;

  private mode: GameMode = 'onePlayer';
  private arena: ArenaConfig | null = null;
  private ragdolls: Partial<Record<Side, RagdollHandle>> = {};
  private bows: Partial<Record<Side, BowController>> = {};
  private ai: Partial<Record<Side, AIController>> = {};
  private players: Record<Side, PlayerState> = {
    left: { side: 'left', controller: 'human1', health: COMBAT.maxHealth, maxHealth: COMBAT.maxHealth, score: 0, alive: true },
    right: { side: 'right', controller: 'cpu', health: COMBAT.maxHealth, maxHealth: COMBAT.maxHealth, score: 0, alive: true },
  };

  /** Simulation runs in every phase except paused; input/AI only while playing. */
  private simulating = false;
  private interactive = false;
  private destroyed = false;

  /** Pending phase timers, all cleared on teardown or restart. */
  private timers = new Set<number>();

  private roundOver = false;
  private deathmatchScore = 0;
  private encounter = 0;
  private cpuDifficulty = 0.35;
  private settings: GameSettings = { music: true, sfx: true, reducedBlood: false };

  private disposeCollision: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: EngineEvents,
  ) {
    this.combat = new CombatSystem(this.projectiles, {
      onHit: (hit) => this.handleHit(hit),
      onDefeat: (loser, byHeadshot, byFall) => this.handleDefeat(loser, byHeadshot, byFall),
      onTerrainHit: (point) => {
        this.particles.terrainPuff(point, this.arena?.groundColor ?? '#c8823f');
      },
    });

    this.input = new InputManager({
      onPress: (side) => this.pressSide(side),
      onRelease: (side) => this.releaseSide(side),
      onPauseToggle: () => this.events.onPauseRequest(),
    });

    this.ctx = canvas.getContext('2d', { alpha: false });
    this.disposeCollision = this.physics.onCollisionStart((event) => {
      for (const pair of event.pairs) {
        this.combat.handleCollision(pair.bodyA, pair.bodyB, this.players, this.ragdolls as Record<Side, RagdollHandle>);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Match lifecycle
   * ---------------------------------------------------------------- */

  startMatch(mode: GameMode, settings: GameSettings): void {
    this.clearTimers();
    this.mode = mode;
    this.settings = settings;
    this.roundOver = false;
    this.deathmatchScore = 0;
    this.encounter = 0;
    // Measured against a CPU of the same skill these settle a round in roughly
    // 15-20 seconds, which leaves a human room to trade shots. Deathmatch opens
    // gently and ramps from there.
    this.cpuDifficulty = mode === 'deathmatch' ? 0.25 : 0.45;

    const controllers: Record<Side, PlayerState['controller']> =
      mode === 'twoPlayers'
        ? { left: 'human1', right: 'human2' }
        : { left: 'human1', right: 'cpu' };

    for (const side of SIDES) {
      this.players[side] = {
        side,
        controller: controllers[side],
        health: COMBAT.maxHealth,
        maxHealth: COMBAT.maxHealth,
        score: 0,
        alive: true,
      };
    }

    this.arenas.reset();
    this.input.attach(this.canvas, mode);
    this.events.onScores({ left: 0, right: 0 });

    if (mode === 'deathmatch') {
      this.buildEncounter(true);
      this.beginPlay();
      this.events.onDeathmatchScore(0, 0);
    } else {
      this.beginRound(true);
    }
    this.start();
  }

  /** Builds a fresh arena and two fresh ragdolls, then runs the FIGHT intro. */
  private beginRound(newTheme: boolean): void {
    this.buildEncounter(newTheme);
    this.roundOver = false;
    this.simulating = true;
    this.interactive = false;
    this.input.setEnabled(false);
    this.events.onRoundIntro();
    this.events.onAnnounce('fight', 'FIGHT!', MATCH.roundIntroMs);

    this.after(MATCH.roundIntroMs, () => this.beginPlay());
  }

  private beginPlay(): void {
    this.simulating = true;
    this.interactive = true;
    this.input.setEnabled(true);
    this.physics.resetClock();
    this.events.onPlay();
  }

  /** Tears down the previous encounter and constructs the next one. */
  private buildEncounter(newTheme: boolean): void {
    this.teardownFighters();

    const arena = this.arenas.next({ newTheme });
    this.arena = arena;
    this.physics.buildTerrain(arena);
    this.projectiles.setArena(arena);
    this.camera.setArena(arena);
    this.particles.setAmbient(arena.ambient);
    this.particles.clearTransient();
    this.combat.reset();
    this.sway.reset();

    for (const side of SIDES) {
      const skin = this.skinFor(side);
      const ragdoll = this.ragdollFactory.create(side, arena.spawns[side], this.arenas.facingFor(side), skin);
      this.ragdolls[side] = ragdoll;

      const bow = new BowController(side, ragdoll, this.projectiles);
      this.bows[side] = bow;

      if (this.players[side].controller === 'cpu') {
        this.ai[side] = new AIController(side, ragdoll, bow, () => this.physics.getTerrain(), this.cpuDifficulty);
      }

      this.players[side].health = COMBAT.maxHealth;
      this.players[side].alive = true;
    }

    this.events.onHealth(COMBAT.maxHealth, COMBAT.maxHealth);
  }

  /** Deathmatch rotates opponent palettes; standard modes stay blue vs orange. */
  private skinFor(side: Side): Skin {
    if (this.mode !== 'deathmatch' || side === 'left') return SKINS[side];
    return DEATHMATCH_SKINS[this.encounter % DEATHMATCH_SKINS.length];
  }

  private teardownFighters(): void {
    this.projectiles.clear();
    for (const side of SIDES) {
      const ragdoll = this.ragdolls[side];
      if (ragdoll) this.ragdollFactory.destroy(ragdoll);
      this.ragdolls[side] = undefined;
      this.bows[side] = undefined;
      this.ai[side] = undefined;
    }
    audioManager.stopDraw();
  }

  /* ---------------------------------------------------------------- *
   * Combat outcomes
   * ---------------------------------------------------------------- */

  private handleHit(hit: HitEvent): void {
    const direction = Math.atan2(
      hit.point.y - (this.ragdolls[hit.target]?.torso.position.y ?? hit.point.y),
      hit.point.x - (this.ragdolls[hit.target]?.torso.position.x ?? hit.point.x),
    );
    this.particles.impact(hit.point, direction, this.settings.reducedBlood);
    this.camera.addShake(hit.headshot ? 13 : 6);

    audioManager.play('impact');
    if (!hit.fatal) audioManager.play('reaction');

    if (hit.headshot) {
      audioManager.play('headshot');
      this.events.onAnnounce('headshot', 'HEADSHOT!', 1300, hit.shooter);
    }

    this.events.onHealth(this.players.left.health, this.players.right.health);
  }

  private handleDefeat(loser: Side, byHeadshot: boolean, byFall: boolean): void {
    if (this.roundOver && this.mode !== 'deathmatch') return;

    const winner = OTHER[loser];
    this.players[loser].alive = false;
    this.interactive = false;
    this.input.setEnabled(false);
    audioManager.stopDraw();
    for (const side of SIDES) this.bows[side]?.cancel();
    this.camera.addShake(9);

    if (this.mode === 'deathmatch') {
      this.handleDeathmatchDefeat(loser);
      return;
    }

    // Award exactly one point, then either continue or end the match.
    this.roundOver = true;
    this.players[winner].score += 1;
    const scores = { left: this.players.left.score, right: this.players.right.score };

    audioManager.play('point');
    this.events.onAnnounce('point', SKINS[winner].name.toUpperCase() + ' SCORES', MATCH.roundResultDelayMs, winner);
    this.events.onRoundOver(winner, loser, byHeadshot, byFall, scores);
    this.events.onScores(scores);

    this.after(MATCH.roundResultDelayMs, () => {
      if (this.players[winner].score >= MATCH.targetScore) {
        audioManager.play('victory');
        this.events.onMatchOver(winner);
        this.simulating = true;
      } else {
        this.beginRound(false);
      }
    });
  }

  private handleDeathmatchDefeat(loser: Side): void {
    if (loser === 'left') {
      // The run is over.
      audioManager.play('defeat');
      this.events.onDeathmatchOver(this.deathmatchScore);
      return;
    }

    // An opponent fell: score, ramp difficulty, and queue the next encounter.
    this.deathmatchScore += 1;
    this.encounter += 1;
    this.cpuDifficulty = Math.min(AI.maxDifficulty, this.cpuDifficulty + AI.difficultyStep);

    audioManager.play('point');
    this.events.onAnnounce('ko', 'OPPONENT DOWN', MATCH.encounterDelayMs, 'left');
    this.events.onDeathmatchScore(this.deathmatchScore, this.encounter);

    this.after(MATCH.encounterDelayMs, () => {
      if (this.destroyed) return;
      // Health is restored for every new encounter.
      this.buildEncounter(true);
      this.events.onAnnounce('fight', 'FIGHT!', MATCH.roundIntroMs * 0.8);
      this.after(MATCH.roundIntroMs * 0.8, () => this.beginPlay());
    });
  }

  /* ---------------------------------------------------------------- *
   * Input plumbing
   * ---------------------------------------------------------------- */

  private pressSide(side: Side): void {
    if (!this.interactive) return;
    if (this.players[side].controller === 'cpu') return;
    const bow = this.bows[side];
    if (!bow) return;
    if (bow.press()) {
      audioManager.play('bowDraw');
    }
  }

  private releaseSide(side: Side): void {
    const bow = this.bows[side];
    if (!bow) return;
    if (this.players[side].controller === 'cpu') return;
    const shot = bow.release();
    audioManager.stopDraw();
    if (shot) {
      audioManager.play('bowRelease');
      audioManager.play('arrowFlight');
    }
  }

  /* ---------------------------------------------------------------- *
   * Loop
   * ---------------------------------------------------------------- */

  start(): void {
    if (this.rafId !== null || this.destroyed) return;
    this.lastFrameTime = performance.now();
    this.physics.resetClock();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.frame);

    const rawDelta = now - this.lastFrameTime;
    this.lastFrameTime = now;
    // A hidden tab, a breakpoint or a stalled main thread must not fast-forward
    // the simulation when the page comes back.
    const delta = Math.min(rawDelta, TIME.maxFrameDelta);

    if (this.simulating) {
      this.elapsed += delta;
      this.physics.update(
        delta,
        (stepMs) => this.simulate(stepMs),
        () => this.poseFighters(),
      );
      // Orientation is synced after the solver so arrows never render a step behind.
      this.projectiles.syncOrientation();
      this.particles.update(delta / 1000);
      this.camera.update(delta / 1000);
    }

    this.render();
  };

  private simulate(stepMs: number): void {
    const left = this.ragdolls.left;
    const right = this.ragdolls.right;
    if (!left || !right || !this.arena) return;

    // Advance both archers' swing phases and let their balance recover.
    this.sway.update(left, stepMs);
    this.sway.update(right, stepMs);

    for (const side of SIDES) {
      this.bows[side]?.update(stepMs);
    }

    if (this.interactive) {
      this.ai.left?.update(stepMs, right);
      this.ai.right?.update(stepMs, left);
    }

    this.projectiles.update(stepMs);
    this.combat.checkFallBoundary(
      this.ragdolls as Record<Side, RagdollHandle>,
      this.players,
      this.arena.fallBoundary,
    );

    this.camera.follow(this.headPoint(left), this.headPoint(right), this.arena);

    // Feed the live draw into the bow-creak synth for the local human only.
    const humanBow = this.bows.left;
    if (humanBow && this.players.left.controller !== 'cpu' && humanBow.state.phase === 'drawing') {
      audioManager.setDrawCharge(humanBow.state.charge);
    }
  }

  /**
   * Poses both archers after the solver has run, so each body owns its final
   * transform for the step and the bow angle on screen is exactly the one a
   * shot would use. A toppled or defeated archer is skipped and left to ragdoll.
   */
  private poseFighters(): void {
    const left = this.ragdolls.left;
    const right = this.ragdolls.right;
    if (!left || !right) return;
    this.sway.pose(left, right.torso.position.x);
    this.sway.pose(right, left.torso.position.x);
  }

  private headPoint(r: RagdollHandle): Vec2 {
    return { x: r.torso.position.x, y: r.torso.position.y };
  }

  /* ---------------------------------------------------------------- *
   * Rendering + sizing
   * ---------------------------------------------------------------- */

  private render(): void {
    const ctx = this.ctx;
    if (!ctx || !this.arena) return;

    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Map the logical 1280x720 viewport onto the backing store.
    const scale = width / VIEW.width;
    ctx.scale(scale, scale);

    const bowStates = {
      left: this.bows.left?.state,
      right: this.bows.right?.state,
    };

    this.renderer.render(
      ctx,
      this.arena,
      this.ragdolls,
      bowStates,
      this.players,
      this.projectiles.list(),
      this.particles,
      this.elapsed,
    );
  }

  /**
   * Sizes the backing store for the current CSS box, capped at 2x DPR. The
   * element itself is laid out 16:9 by CSS, so this never stretches.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = Math.min(VIEW.maxDpr, window.devicePixelRatio || 1);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(width / VIEW.aspect);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.render();
  }

  /* ---------------------------------------------------------------- *
   * Pause + settings
   * ---------------------------------------------------------------- */

  pause(): void {
    this.simulating = false;
    this.interactive = false;
    this.input.setEnabled(false);
    audioManager.stopDraw();
    for (const side of SIDES) this.bows[side]?.cancel();
    this.ai.left?.setEnabled(false);
    this.ai.right?.setEnabled(false);
    audioManager.pauseMusic();
  }

  resume(): void {
    if (this.destroyed) return;
    this.simulating = true;
    this.interactive = !this.roundOver;
    this.input.setEnabled(this.interactive);
    this.ai.left?.setEnabled(true);
    this.ai.right?.setEnabled(true);
    // Dropping the accumulator is what stops a time jump on resume.
    this.physics.resetClock();
    this.lastFrameTime = performance.now();
    if (this.settings.music) audioManager.resumeMusic();
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  /** Leaves the match but keeps the engine reusable for a rematch. */
  endMatch(): void {
    this.clearTimers();
    this.simulating = false;
    this.interactive = false;
    this.input.setEnabled(false);
    this.input.detach();
    this.teardownFighters();
    this.particles.clear();
    this.combat.reset();
    this.sway.reset();
    this.physics.clear();
    this.arena = null;
    audioManager.stopDraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.clearTimers();
    this.input.detach();
    this.teardownFighters();
    this.disposeCollision?.();
    this.disposeCollision = null;
    this.particles.clear();
    this.physics.destroy();
    this.ctx = null;
    audioManager.stopDraw();
    Matter.Composite.clear(this.physics.world, false, true);
  }
}
