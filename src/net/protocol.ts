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
  /** Host: one simulation frame. */
  | { k: 'snap'; s: Snapshot }
  /** Host: a landed hit, so the guest can spawn the same effects. */
  | { k: 'hit'; x: number; y: number; dir: number; headshot: boolean; fatal: boolean }
  /**
   * Host: an engine event to replay verbatim on the guest. `n` is the name of
   * an `EngineEvents` member and `a` its arguments, so both sides drive their
   * store through exactly the same code path.
   */
  | { k: 'ev'; n: string; a: unknown[] }
  /** Guest: its own charge button went down or up. */
  | { k: 'in'; down: boolean }
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
