import Matter from 'matter-js';
import { BOW_PHASES, type Snapshot } from '../net/protocol';
import type { BowState, RagdollHandle, RenderableProjectile, Side } from '../types';

const SIDES: Side[] = ['left', 'right'];

/** Frames older than this many are discarded outright rather than played late. */
const MAX_BUFFERED = 12;

/**
 * Bounds on the interpolation delay, in ms. The floor is low because the delay
 * is derived from what the link is actually doing rather than from a flat
 * multiple of the frame rate: a steady connection should not pay for jitter it
 * does not have.
 */
const MIN_DELAY = 20;
const MAX_DELAY = 220;

/**
 * How fast the worst-case lateness is forgiven, in ms per frame.
 *
 * The buffer is sized on the worst frame seen recently rather than the average
 * one, because the average is not what empties it: a single frame arriving
 * 30ms late runs playback off the end of the buffer, and the world stops until
 * it lands. The peak is held and then forgotten slowly, so a link that settles
 * down earns its latency back over a second or two.
 */
const LATENESS_DECAY_PER_FRAME = 0.5;

/** Headroom above the worst case, so the very next frame still has room. */
const LATENESS_MARGIN = 12;

/**
 * Slack above the frame interval. Interpolating needs a frame on each side of
 * the playback point, so the delay can never usefully drop below one interval.
 */
const INTERVAL_MARGIN = 1.15;

/**
 * How fast the clock estimate is allowed to creep upward, in ms per frame.
 *
 * The offset between the two machines' clocks is estimated by the least-delayed
 * frame seen, because that one spent the least time in the network. A pure
 * minimum would latch onto one lucky early frame and never let go, so it is
 * allowed to drift up slowly — fast enough to follow two clocks running at
 * slightly different rates, slow enough that it does not follow congestion.
 */
const CLOCK_DRIFT_PER_FRAME = 0.05;

/**
 * How hard the playback clock is pulled toward where it ought to be, per ms of
 * error, and the most it may be sped up or slowed by.
 *
 * Playback does not simply jump to `estimated host now minus the buffer` each
 * frame. That estimate moves in steps — the clock offset drops the instant a
 * frame arrives unusually early, the buffer widens the moment the link gets
 * rougher — and every step would be a jump in the world. Instead the clock runs
 * at real time and is nudged, so an error of any size is absorbed as the world
 * running a few percent fast or slow for a moment. Nobody can see 8%; everybody
 * can see a jump.
 */
const CLOCK_CORRECTION_GAIN = 0.012;

/**
 * The correction is deliberately lopsided.
 *
 * Running behind where we should be is harmless — it only means a slightly
 * larger buffer than needed — so it is crept out of at a rate nobody can see.
 * Running *ahead* is not harmless: it is playback about to reach the end of what
 * has arrived, and the world stops dead when it does. Falling back is therefore
 * allowed to be four times more urgent, because a moment at three-quarter speed
 * is far less noticeable than a freeze.
 */
const MAX_RATE_FAST = 0.08;
const MAX_RATE_SLOW = 0.3;

/**
 * An error this large is not drift to be corrected but a discontinuity — a new
 * round, or the host having been away — so playback re-locks rather than
 * crawling across it at 8%.
 */
const CLOCK_SNAP_MS = 250;

/** Wraps an angle into (-PI, PI] so a lerp always takes the short way round. */
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number): number => a + wrap(b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Frame {
  snap: Snapshot;
  /** Local arrival time, used only to notice that the host has gone quiet. */
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
 * Playback runs on the host's clock, a fixed distance behind it.
 *
 * The distance exists because a network delivers frames unevenly: without slack
 * the buffer runs dry and the world freezes until the next frame lands. How much
 * slack is measured rather than assumed, because every millisecond of it is a
 * millisecond of lag on everything the player sees — one frame interval, plus
 * twice however late this particular link has been running.
 *
 * The clock matters as much as the slack. Frames used to be spaced apart by when
 * they arrived, which quietly made the network's wobble into the world's: two
 * frames a solid frame-time of motion apart, arriving 12ms apart, played that
 * motion three times too fast, and the next pair played it too slow. On a link
 * with any jitter at all the archers surged and stalled. Spacing them by the
 * host's own timestamps plays the motion at the rate it was made, and leaves
 * jitter to do the only thing it should: decide how much slack is needed.
 */
export class RemoteView {
  private frames: Frame[] = [];
  /** Host-clock spacing between frames: what the send rate actually is. */
  private averageInterval = 33;
  /** The latest a frame has arrived recently, relative to the best case. */
  private lateness = 0;
  /**
   * Local time minus host time, estimated from the least-delayed frame. Both
   * clocks start at their own page load, so this is arbitrary and only ever
   * used as a difference.
   */
  private clockOffset = Number.POSITIVE_INFINITY;
  private lastArrival = 0;
  private delay = 40;
  /**
   * The host-clock instant currently on screen. Advanced at real time and
   * steered, rather than recomputed from scratch each frame.
   */
  private displayed = 0;
  private locked = false;
  private lastApply = 0;

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
    this.lateness = 0;
    this.displayed = 0;
    this.locked = false;
    // The clock estimate is deliberately kept: it belongs to the pair of
    // machines, not to the round, and re-earning it would stutter the restart.
    for (const side of SIDES) Object.assign(this.bows[side], emptyBow(side));
  }

  /**
   * The host-clock instant this screen is showing.
   *
   * Sent with every button, and it is the whole of the lag compensation: the
   * host rewinds a release to this exact time rather than estimating a round
   * trip and a buffer separately and hoping the two add up.
   */
  get displayedHostTime(): number {
    return this.displayed;
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

    // The frame that took the least time to arrive is the best view of how the
    // two clocks are offset; everything above that is delay this frame suffered.
    const offset = now - snap.t;
    this.clockOffset = Math.min(offset, this.clockOffset + CLOCK_DRIFT_PER_FRAME);
    const late = Math.max(0, offset - this.clockOffset);

    if (last) {
      const sent = snap.t - last.snap.t;
      // A gap that long is a stall, not a rate — folding it in would push the
      // playback delay up and leave it there.
      if (sent > 0 && sent < 400) {
        this.averageInterval += (sent - this.averageInterval) * 0.15;
        this.lateness = Math.max(late, this.lateness - LATENESS_DECAY_PER_FRAME);
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
      this.averageInterval * INTERVAL_MARGIN + this.lateness + LATENESS_MARGIN,
      MIN_DELAY,
      MAX_DELAY,
    );
    // Everything below is on the host's clock. `now - clockOffset` is what the
    // host's clock reads at this instant, as well as it can be known.
    const desired = now - this.clockOffset - this.delay;
    if (!this.locked || Math.abs(desired - this.displayed) > CLOCK_SNAP_MS) {
      this.displayed = desired;
      this.locked = true;
    } else {
      const elapsed = Math.max(0, Math.min(now - this.lastApply, 100));
      const error = desired - this.displayed;
      const rate = 1 + clamp(error * CLOCK_CORRECTION_GAIN, -MAX_RATE_SLOW, MAX_RATE_FAST);
      this.displayed += elapsed * rate;
      // Never run past what has actually arrived: playing the newest frame
      // twice is better than playing a frame that does not exist yet.
      const newest = this.frames[this.frames.length - 1].snap.t;
      if (this.displayed > newest) this.displayed = newest;
    }
    this.lastApply = now;
    const target = this.displayed;

    // Keep exactly one frame older than the playback point.
    while (this.frames.length > 2 && this.frames[1].snap.t <= target) this.frames.shift();

    const from = this.frames[0];
    const to = this.frames[1] ?? from;
    // Spacing is the host's, not the network's: two frames a solid frame-time
    // apart are played a frame-time apart however unevenly they turned up.
    const span = Math.max(1, to.snap.t - from.snap.t);
    // Clamped, so a starved buffer holds on the newest frame rather than
    // extrapolating the archers off into open space.
    const t = clamp((target - from.snap.t) / span, 0, 1);

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
