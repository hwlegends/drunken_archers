import Matter from 'matter-js';
import { BOW_PHASES, type Snapshot } from '../net/protocol';
import type { BowState, RagdollHandle, RenderableProjectile, Side } from '../types';

const SIDES: Side[] = ['left', 'right'];

/** Frames older than this many are discarded outright rather than played late. */
const MAX_BUFFERED = 12;

/**
 * Bounds on the interpolation delay, in ms.
 *
 * The floor is low because the delay is now derived from how unevenly frames
 * actually arrive rather than from a flat multiple of the frame interval: a
 * steady link earns a short buffer instead of paying for jitter it does not
 * have.
 */
const MIN_DELAY = 20;
const MAX_DELAY = 220;

/**
 * How much of the measured jitter to hold in hand. Arrival gaps are roughly
 * normal around the send interval, so a little over two mean deviations covers
 * the large majority of frames; the rest are absorbed by holding the last one.
 */
const JITTER_ALLOWANCE = 2.5;

/**
 * Slack above the frame interval. Interpolating needs a frame on each side of
 * the playback point, so the delay can never usefully drop below one interval.
 */
const INTERVAL_MARGIN = 1.05;

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
 * turns that jitter into visible stutter; keeping a little slack means there is
 * almost always a later frame to interpolate towards.
 *
 * How much slack is measured rather than assumed. Every millisecond of it is a
 * millisecond of extra lag on everything the player sees, so the buffer is one
 * frame interval plus the jitter this particular link has actually shown, and
 * nothing more.
 */
export class RemoteView {
  private frames: Frame[] = [];
  private averageInterval = 33;
  /** Mean absolute deviation of arrival gaps: how uneven the link is. */
  private jitter = 0;
  private lastArrival = 0;
  private delay = 40;

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
   * This is how the opponent's bow makes noise: their draw and their shot are
   * heard exactly when they are seen, because both come off the same frames.
   * The listener's own bow is not handled here — it is predicted locally, so
   * that a button answers immediately rather than a round trip later.
   */
  onBowEvent: ((side: Side, event: 'draw' | 'fire') => void) | null = null;

  /** Drops everything buffered. Called whenever the host rebuilds the arena. */
  reset(): void {
    this.frames.length = 0;
    this.arrows.length = 0;
    this.lastArrival = 0;
    this.jitter = 0;
    for (const side of SIDES) Object.assign(this.bows[side], emptyBow(side));
  }

  /**
   * How far behind the host's live world this screen is, beyond the time the
   * frames spent in transit. The host is told this when a shot is released: the
   * whole game is the instant of release, so it has to rewind to the pose that
   * was actually on screen, not just undo the network trip.
   */
  get viewLagMs(): number {
    return this.delay;
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
        const deviation = Math.abs(gap - this.averageInterval);
        this.averageInterval += (gap - this.averageInterval) * 0.15;
        this.jitter += (deviation - this.jitter) * 0.15;
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

    this.delay = clamp(
      this.averageInterval * INTERVAL_MARGIN + this.jitter * JITTER_ALLOWANCE,
      MIN_DELAY,
      MAX_DELAY,
    );
    const target = now - this.delay;

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
        if (bow.phase === 'drawing') this.onBowEvent?.(side, 'draw');
        // Drawing straight into a reload is the string being let go; drawing
        // back to ready is a draw that was cancelled, and makes no sound.
        else if (previous === 'drawing' && bow.phase === 'reloading') {
          this.onBowEvent?.(side, 'fire');
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
