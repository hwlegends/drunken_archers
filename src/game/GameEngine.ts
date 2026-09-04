import Matter from 'matter-js';
import { AI, BOW, COMBAT, DEATHMATCH_SKINS, MATCH, SKINS, TIME, VIEW, type Skin } from '../config/constants';
import { BOW_PHASES, type MatchMessage, type MatchRole, type Snapshot } from '../net/protocol';
import type {
  ArenaConfig,
  ArenaThemeId,
  GameMode,
  GameSettings,
  HitEvent,
  PlayerState,
  RagdollHandle,
  RenderableProjectile,
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
import { RemoteView } from './RemoteView';
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
  /** Measured round trip to the opponent. Online only. */
  onLatency?: (ms: number) => void;
  /** The host has gone quiet, or has started sending again. Guest only. */
  onStalled?: (stalled: boolean) => void;
}

/**
 * The engine's half of an online match. It knows nothing about lobbies or
 * WebSockets: something upstream hands it a pipe and which archer is ours.
 */
export interface NetLink {
  role: MatchRole;
  /** The archer this computer's input drives. */
  side: Side;
  send: (message: MatchMessage) => void;
  /** The hot path, kept separate because it is packed rather than serialised. */
  sendSnapshot: (snapshot: Snapshot) => void;
  subscribe: (listener: (message: MatchMessage) => void) => () => void;
}

const OTHER: Record<Side, Side> = { left: 'right', right: 'left' };
const SIDES: Side[] = ['left', 'right'];

/**
 * How often the host ships a frame of its world.
 *
 * 30 Hz against a 60 Hz simulation: the guest interpolates between frames, so
 * the missing halves are drawn rather than missed. Raising this is the one lever
 * that trades the host's upload for a shorter buffer on the guest — the buffer
 * cannot go below one interval — and is worth pulling only on a link that is
 * known to have the headroom.
 */
const SNAPSHOT_INTERVAL_MS = 1000 / 30;

/** How often each side probes the round trip. */
const PING_INTERVAL_MS = 1000;

/** How often a guest with no arena yet asks the host where the match is. */
const READY_RETRY_MS = 700;

/**
 * Silence from the host that counts as the match having stopped. Frames come
 * 30 times a second, so this is 45 of them; short enough to explain a freeze
 * quickly, long enough that a hiccup does not flash a warning.
 */
const STALL_AFTER_MS = 1500;

/** How far back the host remembers a bow pose, for a remote player's release. */
const AIM_HISTORY_MS = 500;

/**
 * Ceiling on how far a remote release is rewound. Past this the connection is
 * bad enough that honouring the full delay would let a player shoot at an
 * opponent who has visibly moved on, which is worse than the unfairness it fixes.
 */
const MAX_REWIND_MS = 250;

/** One remembered bow pose: where the bow was and where it pointed. */
interface AimSample {
  at: number;
  angle: number;
  x: number;
  y: number;
}

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

  /* ---- online ----------------------------------------------------- */

  private net: NetLink | null = null;
  private disposeNet: (() => void) | null = null;
  /** The guest's replica of the host's world. Unused when hosting. */
  private readonly remote = new RemoteView();
  private snapshotSeq = 0;
  private lastSnapshotAt = 0;
  private lastPingAt = 0;
  private lastReadyAt = 0;
  private rttMs = 0;
  private stalled = false;
  /** Guest only: when the local button went down, or 0 if it is not held. */
  private predictedDrawStart = 0;
  /** Recent bow poses for the remote archer, so its release can be rewound. */
  private aimHistory: AimSample[] = [];

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
      // There is nothing to pause online: freezing one browser would not stop
      // the other, and the host's world is the match.
      onPauseToggle: () => {
        if (this.mode !== 'online') this.events.onPauseRequest();
      },
    });

    this.remote.onBowEvent = (side, event) => this.playBowSound(side, event);

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

  startMatch(mode: GameMode, settings: GameSettings, net: NetLink | null = null): void {
    this.clearTimers();
    this.mode = mode;
    this.settings = settings;
    this.roundOver = false;
    this.deathmatchScore = 0;
    this.encounter = 0;

    this.attachNet(net);
    // Measured against a CPU of the same skill these settle a round in roughly
    // 15-20 seconds, which leaves a human room to trade shots. Deathmatch opens
    // gently and ramps from there.
    this.cpuDifficulty = mode === 'deathmatch' ? 0.25 : 0.45;

    // Online, one archer is driven from this keyboard and the other by someone
    // else's. The guest marks both remote: it simulates neither, it only
    // replays what the host sends and forwards its own button.
    const controllers: Record<Side, PlayerState['controller']> =
      mode === 'twoPlayers'
        ? { left: 'human1', right: 'human2' }
        : mode === 'online' && net
          ? net.role === 'host'
            ? { left: net.side === 'left' ? 'human1' : 'remote', right: net.side === 'right' ? 'human1' : 'remote' }
            : { left: 'remote', right: 'remote' }
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
    if (net) this.input.setLocalSide(net.side);
    this.emit('onScores', { left: 0, right: 0 });

    if (mode === 'deathmatch') {
      this.buildEncounter(true);
      this.beginPlay();
      this.events.onDeathmatchScore(0, 0);
    } else if (net?.role === 'guest') {
      // Nothing exists until the host says which arena it built.
      this.simulating = true;
      this.interactive = true;
      this.input.setEnabled(true);
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
    this.emit('onRoundIntro');
    this.emit('onAnnounce', 'fight', 'FIGHT!', MATCH.roundIntroMs);

    this.after(MATCH.roundIntroMs, () => this.beginPlay());
  }

  private beginPlay(): void {
    this.simulating = true;
    this.interactive = true;
    this.input.setEnabled(true);
    this.physics.resetClock();
    this.emit('onPlay');
  }

  /**
   * Tears down the previous encounter and constructs the next one.
   *
   * `recipe` reproduces an exact arena instead of rolling a fresh one, which is
   * how an online guest ends up standing in the same place as the host.
   */
  private buildEncounter(newTheme: boolean, recipe?: { theme: ArenaThemeId; seed: number }): void {
    this.teardownFighters();

    const arena = this.arenas.next(recipe ? { newTheme: false, ...recipe } : { newTheme });
    this.arena = arena;
    this.aimHistory.length = 0;
    this.remote.reset();
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

    // The guest must be standing in this arena before the first frame of it
    // arrives, so the recipe goes out ahead of any snapshot.
    if (this.net?.role === 'host') this.sendBegin();

    this.emit('onHealth', COMBAT.maxHealth, COMBAT.maxHealth);
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
      this.emit('onAnnounce', 'headshot', 'HEADSHOT!', 1300, hit.shooter);
    }

    // Blood, shake and the impact crack are local effects the guest cannot
    // derive from transforms alone, so the one that landed them is relayed.
    this.net?.send({
      k: 'hit',
      x: hit.point.x,
      y: hit.point.y,
      dir: direction,
      headshot: hit.headshot,
      fatal: hit.fatal,
    });

    this.emit('onHealth', this.players.left.health, this.players.right.health);
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
    this.emit('onAnnounce', 'point', SKINS[winner].name.toUpperCase() + ' SCORES', MATCH.roundResultDelayMs, winner);
    this.emit('onRoundOver', winner, loser, byHeadshot, byFall, scores);
    this.emit('onScores', scores);

    this.after(MATCH.roundResultDelayMs, () => {
      if (this.players[winner].score >= MATCH.targetScore) {
        audioManager.play('victory');
        this.emit('onMatchOver', winner);
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
    // Online, this computer only ever has one archer to press for, and a guest
    // has no bow of its own to draw: it sends the button and waits to see it.
    if (this.net) {
      if (side !== this.net.side) return;
      if (this.net.role === 'guest') {
        this.net.send({ k: 'in', down: true, lag: Math.round(this.remote.viewLagMs) });
        this.beginPredictedDraw(side);
        return;
      }
    }
    this.applyPress(side, true);
  }

  private releaseSide(side: Side): void {
    if (this.net) {
      if (side !== this.net.side) return;
      if (this.net.role === 'guest') {
        this.net.send({ k: 'in', down: false, lag: Math.round(this.remote.viewLagMs) });
        this.endPredictedDraw();
        return;
      }
    }
    this.applyRelease(side, true);
  }

  /* ---- the guest's own draw, shown before the host confirms it ---- */

  /**
   * A guest's button would otherwise take a full round trip to produce any
   * feedback at all, which reads as the game being slow even when the match is
   * running perfectly. The draw is therefore shown immediately.
   *
   * Predicting it is safe because a charge is only elapsed time. The press and
   * the release are delayed by the same amount, so the duration the host
   * measures is the duration held here — the prediction is not an estimate of
   * the host's charge, it is the same number arrived at sooner.
   */
  private beginPredictedDraw(side: Side): void {
    // Only when the bow is loaded, so a button mashed during a reload does not
    // draw a charge that is not really building.
    if (this.remote.bows[side].phase !== 'ready') return;
    this.predictedDrawStart = performance.now();
    audioManager.play('bowDraw');
  }

  private endPredictedDraw(): void {
    if (!this.predictedDrawStart) return;
    this.predictedDrawStart = 0;
    audioManager.stopDraw();
    audioManager.play('bowRelease');
    audioManager.play('arrowFlight');
  }

  /** Runs each frame while a predicted draw is open. */
  private updatePredictedDraw(now: number): void {
    const net = this.net;
    if (!net || !this.predictedDrawStart) return;
    const bow = this.remote.bows[net.side];
    // The host has already resolved the shot, or the archer is gone.
    if (bow.phase === 'reloading') {
      this.predictedDrawStart = 0;
      return;
    }
    const charge = Math.min(1, (now - this.predictedDrawStart) / 1000 / BOW.timeToMaxCharge);
    bow.phase = 'drawing';
    bow.charge = charge;
    audioManager.setDrawCharge(charge);
  }

  /**
   * Starts a draw, whoever asked for it. `local` distinguishes this computer's
   * player from the one on the other end: the bow-creak synth follows a single
   * charge value, so only the local draw may drive it.
   */
  private applyPress(side: Side, local: boolean): void {
    if (!this.interactive) return;
    if (this.players[side].controller === 'cpu') return;
    const bow = this.bows[side];
    if (!bow) return;
    if (bow.press() && local) {
      audioManager.play('bowDraw');
    }
  }

  private applyRelease(side: Side, local: boolean, viewLagMs = 0): void {
    const bow = this.bows[side];
    if (!bow) return;
    if (this.players[side].controller === 'cpu') return;

    const shot = bow.release(local ? undefined : this.rewoundAim(viewLagMs));
    if (local) audioManager.stopDraw();
    if (shot) {
      audioManager.play('bowRelease');
      audioManager.play('arrowFlight');
    }
  }

  /**
   * The remote archer's bow as that player actually saw it when they let go.
   *
   * Two delays stand between the two screens, and both have to come off. The
   * message spent a full round trip in the air — half of it carrying the frame
   * they were looking at, half of it carrying their release back. On top of
   * that their screen is deliberately running a little behind the frames it has,
   * to smooth out jitter, and that buffer is theirs to report.
   *
   * Rewinding by half a trip, as this first did, left roughly a tenth of a
   * second uncorrected: enough for the bow to sweep several degrees, which over
   * the width of an arena is most of an archer. It read as the game ignoring
   * where you aimed.
   */
  private rewoundAim(viewLagMs: number): { angle: number; position: Vec2 } | undefined {
    const rewind = Math.min(MAX_REWIND_MS, this.rttMs + viewLagMs);
    if (rewind < TIME.step || !this.aimHistory.length) return undefined;

    const at = performance.now() - rewind;
    // Samples are appended in order, so the last one at or before `at` is the
    // newest pose that player could possibly have seen.
    let chosen = this.aimHistory[0];
    for (const sample of this.aimHistory) {
      if (sample.at > at) break;
      chosen = sample;
    }
    return { angle: chosen.angle, position: { x: chosen.x, y: chosen.y } };
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

    if (this.net?.role === 'guest') {
      this.guestFrame(now, delta);
    } else if (this.simulating) {
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

    if (this.net) this.netFrame(now);

    this.render();
  };

  /**
   * The guest's frame. No solver runs and no rule is evaluated here — the
   * host's transforms are written into the local bodies and everything else
   * (camera, particles, the renderer) behaves exactly as it does offline.
   */
  private guestFrame(now: number, delta: number): void {
    this.elapsed += delta;
    this.remote.apply(now, this.ragdolls);
    // After the snapshot, so it overrides the host's older view of our own bow.
    this.updatePredictedDraw(now);

    const left = this.ragdolls.left;
    const right = this.ragdolls.right;
    if (left && right && this.arena) {
      this.camera.follow(this.headPoint(left), this.headPoint(right), this.arena);
    }
    this.particles.update(delta / 1000);
    this.camera.update(delta / 1000);
  }

  /** Snapshots and the latency probe, on whichever end owns them. */
  private netFrame(now: number): void {
    const net = this.net;
    if (!net) return;

    if (now - this.lastPingAt >= PING_INTERVAL_MS) {
      this.lastPingAt = now;
      net.send({ k: 'ping', t: now });
    }

    if (net.role === 'host') {
      if (this.arena && now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAt = now;
        net.sendSnapshot(this.buildSnapshot());
      }
      return;
    }

    // Both engines are built at the same instant, so the host's opening message
    // can land before this one is listening. Asking again until an arena exists
    // costs one message a second and removes the race entirely.
    if (!this.arena && now - this.lastReadyAt >= READY_RETRY_MS) {
      this.lastReadyAt = now;
      net.send({ k: 'ready' });
    }

    // Reported only when it changes, so a stalled match is one store write
    // rather than one per frame.
    const stalled = !!this.arena && this.remote.silenceMs(now) > STALL_AFTER_MS;
    if (stalled !== this.stalled) {
      this.stalled = stalled;
      this.events.onStalled?.(stalled);
    }
  }

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
    // Online that is whichever archer this computer was given, not always blue.
    const localSide: Side = this.net ? this.net.side : 'left';
    const humanBow = this.bows[localSide];
    const controller = this.players[localSide].controller;
    if (
      humanBow &&
      controller !== 'cpu' &&
      controller !== 'remote' &&
      humanBow.state.phase === 'drawing'
    ) {
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

    // Recorded after posing, because posing is what sets the bow angle a shot
    // would use, and that is exactly the value a remote release rewinds to.
    if (this.net?.role === 'host') this.recordAim(OTHER[this.net.side]);
  }

  private recordAim(side: Side): void {
    const bow = this.ragdolls[side]?.bow;
    if (!bow) return;
    const at = performance.now();
    this.aimHistory.push({ at, angle: bow.angle, x: bow.position.x, y: bow.position.y });
    while (this.aimHistory.length && at - this.aimHistory[0].at > AIM_HISTORY_MS) {
      this.aimHistory.shift();
    }
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

    // A guest has no bows and no arrows of its own; both come off the wire.
    const guest = this.net?.role === 'guest';
    const bowStates = guest
      ? this.remote.bows
      : { left: this.bows.left?.state, right: this.bows.right?.state };
    const arrows: readonly RenderableProjectile[] = guest
      ? this.remote.arrows
      : this.projectiles.list();

    this.renderer.render(
      ctx,
      this.arena,
      this.ragdolls,
      bowStates,
      this.players,
      arrows,
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
   * Online
   * ---------------------------------------------------------------- */

  private attachNet(net: NetLink | null): void {
    this.disposeNet?.();
    this.disposeNet = null;
    this.net = net;
    this.remote.reset();
    this.aimHistory.length = 0;
    this.snapshotSeq = 0;
    this.lastSnapshotAt = 0;
    this.lastPingAt = 0;
    this.lastReadyAt = 0;
    this.rttMs = 0;
    this.stalled = false;
    this.predictedDrawStart = 0;
    if (net) this.disposeNet = net.subscribe((message) => this.handleNetMessage(message));
  }

  /**
   * Sends an engine event to React and, when hosting, to the other computer as
   * well. Both screens end up driving their store through the same handler with
   * the same arguments, so a scoreboard or a banner cannot drift between them.
   */
  private emit<K extends keyof EngineEvents>(
    name: K,
    ...args: Parameters<NonNullable<EngineEvents[K]>>
  ): void {
    (this.events[name] as ((...a: unknown[]) => void) | undefined)?.(...args);
    if (this.net?.role === 'host') this.net.send({ k: 'ev', n: name, a: args });
  }

  /**
   * One frame of the host's world, flattened.
   *
   * Both computers build their archers from the same factory in the same order,
   * so a body's index is enough to address it and no identifier has to travel.
   * Values go out full precision: `encodeSnapshot` is the one place that decides
   * how coarsely they are actually worth sending.
   */
  private buildSnapshot(): Snapshot {
    const bodies: number[] = [];
    for (const side of SIDES) {
      const ragdoll = this.ragdolls[side];
      if (!ragdoll) continue;
      for (const body of ragdoll.bodies) {
        bodies.push(body.position.x, body.position.y, body.angle);
      }
    }

    const arrows: number[] = [];
    for (const projectile of this.projectiles.list()) {
      arrows.push(
        projectile.id,
        projectile.owner === 'left' ? 1 : 0,
        projectile.body.position.x,
        projectile.body.position.y,
        projectile.body.angle,
      );
    }

    const bow = (side: Side): [number, number] => {
      const state = this.bows[side]?.state;
      if (!state) return [BOW_PHASES.indexOf('ready'), 0];
      return [BOW_PHASES.indexOf(state.phase), state.charge];
    };
    const [leftPhase, leftCharge] = bow('left');
    const [rightPhase, rightCharge] = bow('right');

    return {
      n: ++this.snapshotSeq,
      b: bodies,
      a: arrows,
      bw: [leftPhase, leftCharge, rightPhase, rightCharge],
      d: [this.ragdolls.left?.dead ? 1 : 0, this.ragdolls.right?.dead ? 1 : 0],
    };
  }

  private sendBegin(): void {
    const { theme, seed } = this.arenas.recipe;
    this.net?.send({
      k: 'begin',
      theme,
      seed,
      scores: { left: this.players.left.score, right: this.players.right.score },
    });
  }

  private handleNetMessage(message: MatchMessage): void {
    if (this.destroyed || !this.net) return;

    switch (message.k) {
      case 'ping':
        // Echoed with the sender's own clock reading, so neither side ever has
        // to know what time it is on the other.
        this.net.send({ k: 'pong', t: message.t });
        break;

      case 'pong': {
        const sample = performance.now() - message.t;
        // Smoothed: a single delayed reply should not swing the rewind window.
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs + (sample - this.rttMs) * 0.25;
        this.events.onLatency?.(Math.round(this.rttMs));
        break;
      }

      case 'in':
        // Only the host acts on a button, and only ever for the other archer.
        if (this.net.role !== 'host') break;
        if (message.down) this.applyPress(OTHER[this.net.side], false);
        else this.applyRelease(OTHER[this.net.side], false, message.lag);
        break;

      case 'ready': {
        // Catches a guest that came up after the round had already started, or
        // came back after a reload. Everything it needs is re-stated, in the
        // order it would have arrived the first time.
        if (this.net.role !== 'host' || !this.arena) break;
        this.sendBegin();
        const scores = { left: this.players.left.score, right: this.players.right.score };
        this.net.send({ k: 'ev', n: 'onScores', a: [scores] });
        this.net.send({
          k: 'ev',
          n: 'onHealth',
          a: [this.players.left.health, this.players.right.health],
        });
        this.net.send({ k: 'ev', n: this.interactive ? 'onPlay' : 'onRoundIntro', a: [] });
        break;
      }

      case 'begin':
        if (this.net.role !== 'guest') break;
        this.players.left.score = message.scores.left;
        this.players.right.score = message.scores.right;
        this.buildEncounter(false, { theme: message.theme, seed: message.seed });
        break;

      case 'snap':
        if (this.net.role !== 'guest') break;
        this.remote.push(message.s, performance.now());
        break;

      case 'hit':
        if (this.net.role !== 'guest') break;
        this.particles.impact({ x: message.x, y: message.y }, message.dir, this.settings.reducedBlood);
        this.camera.addShake(message.headshot ? 13 : 6);
        audioManager.play('impact');
        if (!message.fatal) audioManager.play('reaction');
        if (message.headshot) audioManager.play('headshot');
        break;

      case 'ev':
        if (this.net.role !== 'guest') break;
        this.applyRemoteEvent(message.n, message.a);
        break;
    }
  }

  /**
   * Replays one of the host's engine events. The store update is the same call
   * the host made; the extra work here is the state the *renderer* reads
   * directly off the engine rather than out of the store.
   */
  private applyRemoteEvent(name: string, args: unknown[]): void {
    if (name === 'onHealth') {
      // Health bars are drawn on the canvas from these, not from the store.
      this.players.left.health = args[0] as number;
      this.players.right.health = args[1] as number;
    } else if (name === 'onScores') {
      const scores = args[0] as Record<Side, number>;
      this.players.left.score = scores.left;
      this.players.right.score = scores.right;
    } else if (name === 'onPlay') {
      this.interactive = true;
      this.input.setEnabled(true);
    } else if (name === 'onRoundIntro') {
      this.interactive = false;
      this.input.setEnabled(false);
    } else if (name === 'onRoundOver' || name === 'onMatchOver') {
      this.interactive = false;
      this.input.setEnabled(false);
      audioManager.stopDraw();
    }

    const handler = this.events[name as keyof EngineEvents] as
      | ((...a: unknown[]) => void)
      | undefined;
    handler?.(...args);
  }

  /**
   * The opponent's draw and release, heard when they are seen. Our own bow is
   * predicted in `updatePredictedDraw`, so it is deliberately skipped here —
   * otherwise every shot would sound twice.
   */
  private playBowSound(side: Side, event: 'draw' | 'fire'): void {
    if (this.net?.role !== 'guest' || side === this.net.side) return;
    if (event === 'draw') {
      audioManager.play('bowDraw');
      return;
    }
    audioManager.stopDraw();
    audioManager.play('bowRelease');
    audioManager.play('arrowFlight');
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
    this.disposeNet?.();
    this.disposeNet = null;
    this.net = null;
    this.remote.reset();
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
    this.disposeNet?.();
    this.disposeNet = null;
    this.net = null;
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
