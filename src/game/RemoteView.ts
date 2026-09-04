import Matter from 'matter-js';
import { BOW_PHASES, type Snapshot } from '../net/protocol';
import type { BowState, RagdollHandle, RenderableProjectile, Side } from '../types';

const SIDES: Side[] = ['left', 'right'];

/** Frames older than this many are discarded outright rather than played late. */
const MAX_BUFFERED = 12;

/** Bounds on the interpolation delay, in ms. */
const MIN_DELAY = 45;
const MAX_DELAY = 200;

/** Wraps an angle into (-PI, PI] so a lerp always takes the short way round. */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number): number => a + wrap(b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Frame {
  snap: Snapshot;
  /** Local arrival time. Host and guest clocks are never compared. */
  at: number;
}

/**
 * The guest's copy of the host's world.
 *
 * The guest runs no physics at all. It builds the same arena and the same two
 * archers from the same seed, then this class writes the host's transforms into
 * those bodies every frame and the ordinary renderer draws them — which is why
 * an online match looks identical to a local one.
 *
 * Frames are played back on a short delay rather than the instant they land.
 * A network delivers them unevenly, and rendering the newest one immediately
 * turns that jitter into visible stutter; holding roughly two frames of slack
 * means there is almost always a later frame to interpolate towards.
 */
export class RemoteView {
  private frames: Frame[] = [];
  private averageInterval = 33;
  private lastArrival = 0;

  /** Arrows in flight, rebuilt each frame from the interpolated snapshot. */
  readonly arrows: RenderableProjectile[] = [];
  /** Synthesised bow states, enough for the draw pose and the charge meter. */
  readonly bows: Record<Side, BowState> = {
    left: emptyBow('left'),
    right: emptyBow('right'),
  };

  /**
   * Draws and shots, recovered from the bow phase changing between frames.
   *
   * The guest could play its own draw the instant a key goes down, which would
   * be a few tens of milliseconds earlier — but then the sound would lead the
   * picture, because the picture is the delayed playback below. Deriving both
   * from the same frames keeps them together.
   */
  onBowEvent: ((event: 'draw' | 'fire') => void) | null = null;

  /** Drops everything buffered. Called whenever the host rebuilds the arena. */
  reset(): void {
    this.frames.length = 0;
    this.arrows.length = 0;
    this.lastArrival = 0;
    for (const side of SIDES) Object.assign(this.bows[side], emptyBow(side));
  }

  /** True once at least one frame has arrived for the current encounter. */
  get ready(): boolean {
    return this.frames.length > 0;
  }

  /**
   * How long the host has been silent. Frames arrive 30 times a second while
   * anything at all is happening, so a long gap is the host having stopped —
   * a hidden window gets no animation frames — rather than a quiet moment.
   */
  silenceMs(now: number): number {
    return this.lastArrival > 0 ? now - this.lastArrival : 0;
  }

  push(snap: Snapshot, now: number): void {
    const last = this.frames[this.frames.length - 1];
    // The relay preserves order, but a reconnect can replay one; either way a
    // frame that is not strictly newer has nothing to add.
    if (last && snap.n <= last.snap.n) return;

    if (this.lastArrival > 0) {
      const gap = now - this.lastArrival;
      // A gap that long is a stall, not a rate — folding it in would push the
      // playback delay up and leave it there.
      if (gap > 0 && gap < 400) {
        this.averageInterval += (gap - this.averageInterval) * 0.15;
      }
    }
    this.lastArrival = now;

    this.frames.push({ snap, at: now });
    if (this.frames.length > MAX_BUFFERED) this.frames.shift();
  }

  /**
   * Writes the interpolated pose into the ragdoll bodies and refreshes the
   * arrow and bow lists. Safe to call before any frame has arrived.
   */
  apply(now: number, ragdolls: Partial<Record<Side, RagdollHandle>>): void {
    if (!this.frames.length) return;

    const delay = clamp(this.averageInterval * 1.8, MIN_DELAY, MAX_DELAY);
    const target = now - delay;

    // Keep exactly one frame older than the playback point.
    while (this.frames.length > 2 && this.frames[1].at <= target) this.frames.shift();

    const from = this.frames[0];
    const to = this.frames[1] ?? from;
    const span = Math.max(1, to.at - from.at);
    // Clamped, so a starved buffer holds on the newest frame rather than
    // extrapolating the archers off into open space.
    const t = clamp((target - from.at) / span, 0, 1);

    this.applyBodies(from.snap, to.snap, t, ragdolls);
    this.applyArrows(from.snap, to.snap, t);
    this.applyBows(from.snap, to.snap, t, ragdolls);
  }

  private applyBodies(
    from: Snapshot,
    to: Snapshot,
    t: number,
    ragdolls: Partial<Record<Side, RagdollHandle>>,
  ): void {
    // A frame from a different encounter has a different body count; playing it
    // into these ragdolls would scatter limbs, so it is used whole or not at all.
    const usable = from.b.length === to.b.length;
    const a = usable ? from.b : to.b;
    const b = to.b;
    const blend = usable ? t : 1;

    let i = 0;
    for (const side of SIDES) {
      const ragdoll = ragdolls[side];
      if (!ragdoll) continue;
      // `bodies` includes the bow, so a whole archer is one contiguous run.
      for (const body of ragdoll.bodies) {
        if (i + 2 >= b.length) return;
        Matter.Body.setPosition(body, {
          x: lerp(a[i], b[i], blend),
          y: lerp(a[i + 1], b[i + 1], blend),
        });
        Matter.Body.setAngle(body, lerpAngle(a[i + 2], b[i + 2], blend));
        i += 3;
      }
      ragdoll.dead = (side === 'left' ? to.d[0] : to.d[1]) === 1;
    }
  }

  private applyArrows(from: Snapshot, to: Snapshot, t: number): void {
    this.arrows.length = 0;

    // Arrows come and go between frames, so they are matched by id rather than
    // by position in the array.
    for (let i = 0; i + 4 < to.a.length; i += 5) {
      const id = to.a[i];
      const owner: Side = to.a[i + 1] === 1 ? 'left' : 'right';
      let x = to.a[i + 2];
      let y = to.a[i + 3];
      let angle = to.a[i + 4];

      for (let j = 0; j + 4 < from.a.length; j += 5) {
        if (from.a[j] !== id) continue;
        x = lerp(from.a[j + 2], x, t);
        y = lerp(from.a[j + 3], y, t);
        angle = lerpAngle(from.a[j + 4], angle, t);
        break;
      }

      this.arrows.push({ owner, body: { position: { x, y }, angle } });
    }
  }

  private applyBows(
    from: Snapshot,
    to: Snapshot,
    t: number,
    ragdolls: Partial<Record<Side, RagdollHandle>>,
  ): void {
    for (let index = 0; index < SIDES.length; index++) {
      const side = SIDES[index];
      const bow = this.bows[side];
      const previous = bow.phase;
      bow.phase = BOW_PHASES[to.bw[index * 2]] ?? 'ready';
      bow.charge = lerp(from.bw[index * 2 + 1], to.bw[index * 2 + 1], t);

      if (previous !== bow.phase) {
        if (bow.phase === 'drawing') this.onBowEvent?.('draw');
        // Drawing straight into a reload is the string being let go; drawing
        // back to ready is a draw that was cancelled, and makes no sound.
        else if (previous === 'drawing' && bow.phase === 'reloading') {
          this.onBowEvent?.('fire');
        }
      }

      const body = ragdolls[side]?.bow;
      if (body) {
        bow.angle = body.angle;
        bow.launchPoint = { x: body.position.x, y: body.position.y };
      }
    }
  }
}

function emptyBow(side: Side): BowState {
  return {
    side,
    phase: 'ready',
    charge: 0,
    reloadRemaining: 0,
    inputHeld: false,
    angle: 0,
    launchPoint: { x: 0, y: 0 },
  };
}
