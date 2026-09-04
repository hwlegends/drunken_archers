import type { ArenaThemeId, Side } from '../types';

/**
 * The wire format, in two layers.
 *
 * `ClientMessage` / `ServerMessage` are the lobby: who is online, challenges,
 * and the pairing that starts a match. They are handled by `server/lobby-server.mjs`.
 *
 * `MatchMessage` is what the two paired browsers say to each other. The server
 * never reads it — it arrives wrapped in `{ t: 'relay', d }` and comes back out
 * of the other socket as `{ t: 'peer', d }`.
 */

export type MatchRole = 'host' | 'guest';

export interface LobbyPlayer {
  id: string;
  name: string;
  status: 'idle' | 'inMatch';
}

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */

export type ClientMessage =
  | { t: 'hello'; name: string }
  | { t: 'rename'; name: string }
  | { t: 'challenge'; to: string }
  | { t: 'withdraw'; to: string }
  | { t: 'accept'; from: string }
  | { t: 'decline'; from: string }
  | { t: 'leave' }
  | { t: 'relay'; d: MatchMessage };

export type ServerMessage =
  | { t: 'welcome'; id: string; name: string }
  | { t: 'players'; players: LobbyPlayer[] }
  | { t: 'invited'; from: LobbyPlayer }
  | { t: 'invite-sent'; to: LobbyPlayer }
  | { t: 'invite-withdrawn'; from: string }
  | { t: 'declined'; by: LobbyPlayer; reason: 'declined' | 'unavailable' }
  | { t: 'start'; matchId: string; role: MatchRole; side: Side; opponent: LobbyPlayer }
  | { t: 'peer'; d: MatchMessage }
  | { t: 'ended'; reason: 'left' | 'disconnected' }
  | { t: 'notice'; level: 'error' | 'info'; message: string };

/* ------------------------------------------------------------------ *
 * Match
 * ------------------------------------------------------------------ */

/**
 * One frame of the host's world.
 *
 * Transforms are flattened into a single number array rather than sent as
 * objects: at 30 Hz the field names would be most of the payload. Both peers
 * build their ragdolls from the same factory in the same order, so index `i`
 * addresses the same body on both machines.
 *
 * Layout: `[x, y, angle] * bodyCount` for the left archer, then the right.
 */
export interface Snapshot {
  /** Host's frame counter, so an out-of-order or duplicated frame is dropped. */
  n: number;
  /**
   * When the host produced this frame, on the host's clock.
   *
   * The guest spaces frames apart by this rather than by when they happened to
   * arrive. Arrival gaps carry every wobble in the network, and interpolating
   * across them turns that wobble into the world visibly speeding up and
   * slowing down; the host's own spacing is what the motion actually was.
   */
  t: number;
  /** Flattened `[x, y, angle]` triples, left archer first. */
  b: number[];
  /** Arrows in flight: `[id, ownerIsLeft, x, y, angle]` per arrow. */
  a: number[];
  /** Bow phase index and charge per side, for the draw pose and charge meter. */
  bw: [number, number, number, number];
  /** `[leftDead, rightDead]` — a dead archer is drawn differently. */
  d: [number, number];
}

export type MatchMessage =
  /** Host: a fresh arena and two fresh archers. Sent before every round. */
  | { k: 'begin'; theme: ArenaThemeId; seed: number; scores: Record<Side, number> }
  /**
   * Host: one simulation frame. This never travels as JSON — it is packed by
   * `encodeSnapshot` and forwarded as raw bytes — but it reaches the engine in
   * this shape like every other message.
   */
  | { k: 'snap'; s: Snapshot }
  /** Host: a landed hit, so the guest can spawn the same effects. */
  | { k: 'hit'; x: number; y: number; dir: number; headshot: boolean; fatal: boolean }
  /**
   * Host: an engine event to replay verbatim on the guest. `n` is the name of
   * an `EngineEvents` member and `a` its arguments, so both sides drive their
   * store through exactly the same code path.
   */
  | { k: 'ev'; n: string; a: unknown[] }
  /**
   * Guest: its own charge button went down or up.
   *
   * `at` is the host-clock time the guest's screen was displaying at that
   * moment, read straight off the frames it was interpolating. The host rewinds
   * a release to exactly that instant, so no estimate of the round trip enters
   * the shot at all.
   */
  | { k: 'in'; down: boolean; at: number }
  /**
   * Guest: a sidestep. Unlike a shot this needs no rewinding — a step changes
   * where the archer will be from now on rather than resolving an instant, so
   * the host simply applies it when it arrives.
   */
  | { k: 'step'; dir: -1 | 1 }
  /**
   * Guest: "I am here, tell me where we are." Both browsers build their engine
   * at the same moment, so whichever spoke first may have spoken to nobody.
   * The guest repeats this until an arena arrives, which also recovers a guest
   * that reloaded mid-match.
   */
  | { k: 'ready' }
  /**
   * Host: throw away the finished match and start another with the same
   * opponent. Handled above the engine, because both sides have to build a new
   * one rather than carry the old one forward.
   */
  | { k: 'restart' }
  /** Round-trip probe, echoed back as `pong`. Drives lag compensation. */
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number };

/** Bow phases, indexed for the snapshot. */
export const BOW_PHASES = ['reloading', 'ready', 'drawing', 'released'] as const;

/* ------------------------------------------------------------------ *
 * Snapshot codec
 * ------------------------------------------------------------------ */

/**
 * Snapshots go over the wire as bytes, not as JSON.
 *
 * They are the only message sent continuously, so they are the only one whose
 * size is worth caring about: as JSON a frame ran about 650 bytes, most of it
 * spent writing out decimal digits and punctuation. Packed into fixed-width
 * integers the same frame is around 220, which matters because the number that
 * has to fit down a home connection is the host's *upload*, and a saturated
 * uplink does not drop frames politely — it delays them, which shows up as the
 * jitter the guest then has to buffer against.
 *
 * Positions are quarter-pixels and angles ten-thousandths of a radian. Both are
 * far below anything a 1280-wide viewport can show.
 */
const POS_SCALE = 4;
const ANGLE_SCALE = 10000;
/** Bytes before the body array. Kept even so the 16-bit fields stay aligned. */
const HEADER_BYTES = 16;
const BODY_BYTES = 6;
const ARROW_BYTES = 8;

/** i16 range, in the units above: about ±8191 px and ±3.27 rad. */
const clampI16 = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));

/**
 * Angles arrive unwrapped — a spinning ragdoll accumulates them without bound —
 * so they are wrapped into (-PI, PI] to fit the field. Nothing downstream reads
 * an angle as anything but a direction, and the guest lerps them the short way
 * round regardless.
 */
const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

export function encodeSnapshot(snap: Snapshot): ArrayBuffer {
  const bodyCount = Math.floor(snap.b.length / 3);
  const arrowCount = Math.floor(snap.a.length / 5);
  const buffer = new ArrayBuffer(HEADER_BYTES + bodyCount * BODY_BYTES + arrowCount * ARROW_BYTES);
  const view = new DataView(buffer);

  view.setUint32(0, snap.n, true);
  // Milliseconds since the host's page loaded. Wraps after seven weeks of one
  // continuous session, which is not a match anybody is playing.
  view.setUint32(4, snap.t >>> 0, true);
  view.setUint8(8, (snap.d[0] ? 1 : 0) | (snap.d[1] ? 2 : 0));
  view.setUint8(9, snap.bw[0]);
  view.setUint8(10, Math.round(Math.max(0, Math.min(1, snap.bw[1])) * 255));
  view.setUint8(11, snap.bw[2]);
  view.setUint8(12, Math.round(Math.max(0, Math.min(1, snap.bw[3])) * 255));
  view.setUint8(13, bodyCount);
  view.setUint8(14, arrowCount);

  let at = HEADER_BYTES;
  for (let i = 0; i < bodyCount * 3; i += 3) {
    view.setInt16(at, clampI16(snap.b[i] * POS_SCALE), true);
    view.setInt16(at + 2, clampI16(snap.b[i + 1] * POS_SCALE), true);
    view.setInt16(at + 4, clampI16(wrapAngle(snap.b[i + 2]) * ANGLE_SCALE), true);
    at += BODY_BYTES;
  }

  for (let i = 0; i < arrowCount * 5; i += 5) {
    // Ids only have to tell one live arrow from another between two adjacent
    // frames, so the counter is truncated and the top bit carries the owner.
    const id = (snap.a[i] & 0x7fff) | (snap.a[i + 1] === 1 ? 0x8000 : 0);
    view.setUint16(at, id, true);
    view.setInt16(at + 2, clampI16(snap.a[i + 2] * POS_SCALE), true);
    view.setInt16(at + 4, clampI16(snap.a[i + 3] * POS_SCALE), true);
    view.setInt16(at + 6, clampI16(wrapAngle(snap.a[i + 4]) * ANGLE_SCALE), true);
    at += ARROW_BYTES;
  }

  return buffer;
}

/** Returns null for a frame that is truncated or not a snapshot at all. */
export function decodeSnapshot(buffer: ArrayBuffer): Snapshot | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);

  const bodyCount = view.getUint8(13);
  const arrowCount = view.getUint8(14);
  const expected = HEADER_BYTES + bodyCount * BODY_BYTES + arrowCount * ARROW_BYTES;
  if (buffer.byteLength !== expected) return null;

  const flags = view.getUint8(8);
  const b = new Array<number>(bodyCount * 3);
  const a = new Array<number>(arrowCount * 5);

  let at = HEADER_BYTES;
  for (let i = 0; i < bodyCount * 3; i += 3) {
    b[i] = view.getInt16(at, true) / POS_SCALE;
    b[i + 1] = view.getInt16(at + 2, true) / POS_SCALE;
    b[i + 2] = view.getInt16(at + 4, true) / ANGLE_SCALE;
    at += BODY_BYTES;
  }

  for (let i = 0; i < arrowCount * 5; i += 5) {
    const id = view.getUint16(at, true);
    a[i] = id & 0x7fff;
    a[i + 1] = id & 0x8000 ? 1 : 0;
    a[i + 2] = view.getInt16(at + 2, true) / POS_SCALE;
    a[i + 3] = view.getInt16(at + 4, true) / POS_SCALE;
    a[i + 4] = view.getInt16(at + 6, true) / ANGLE_SCALE;
    at += ARROW_BYTES;
  }

  return {
    n: view.getUint32(0, true),
    t: view.getUint32(4, true),
    b,
    a,
    bw: [view.getUint8(9), view.getUint8(10) / 255, view.getUint8(11), view.getUint8(12) / 255],
    d: [flags & 1 ? 1 : 0, flags & 2 ? 1 : 0],
  };
}
