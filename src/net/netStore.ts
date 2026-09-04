import { create } from 'zustand';
import type { Side } from '../types';
import { NetClient, defaultLobbyUrl, type NetStatus } from './NetClient';
import type { LobbyPlayer, MatchMessage, MatchRole, ServerMessage } from './protocol';

const STORAGE = {
  name: 'drunkenArchers.playerName.v1',
  lobby: 'drunkenArchers.lobbyUrl.v1',
} as const;

/** How long a rejection or an error stays on screen. */
const NOTICE_MS = 4200;

export interface ActiveMatch {
  matchId: string;
  role: MatchRole;
  /** Which archer this computer drives. Host is always blue on the left. */
  side: Side;
  opponent: LobbyPlayer;
}

/* ------------------------------------------------------------------ *
 * Stored preferences
 * ------------------------------------------------------------------ */

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the name simply does not survive a reload */
  }
}

/** A friendly default so nobody has to type anything to get into the list. */
function suggestName(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('name');
  if (fromUrl) return fromUrl.slice(0, 18);
  const stored = readStored(STORAGE.name);
  if (stored) return stored;
  return 'Archer ' + Math.floor(100 + Math.random() * 900);
}

function initialLobbyUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('lobby') ?? readStored(STORAGE.lobby) ?? defaultLobbyUrl();
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/**
 * Match traffic does not belong in React state — it arrives up to 30 times a
 * second — so peer messages are dispatched straight to whoever subscribed,
 * which in practice is the engine inside `GameCanvas`.
 */
type PeerListener = (message: MatchMessage) => void;
const peerListeners = new Set<PeerListener>();

interface NetState {
  status: NetStatus;
  lobbyUrl: string;
  selfId: string | null;
  selfName: string;
  players: LobbyPlayer[];
  /** Challenges waiting on our answer. */
  incoming: LobbyPlayer[];
  /** Ids we have challenged and not yet heard back about. */
  outgoing: string[];
  match: ActiveMatch | null;
  /** A short-lived line of feedback under the player list. */
  notice: string | null;

  connect: () => void;
  setName: (name: string) => void;
  setLobbyUrl: (url: string) => void;
  challenge: (id: string) => void;
  withdraw: (id: string) => void;
  accept: (id: string) => void;
  decline: (id: string) => void;
  leaveMatch: () => void;
  relay: (message: MatchMessage) => void;
  subscribePeer: (listener: PeerListener) => () => void;
}

let client: NetClient | null = null;
let noticeTimer: number | null = null;

export const useNetStore = create<NetState>((set, get) => {
  const notify = (message: string | null) => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    set({ notice: message });
    if (message) {
      noticeTimer = window.setTimeout(() => {
        noticeTimer = null;
        set({ notice: null });
      }, NOTICE_MS);
    }
  };

  const handle = (message: ServerMessage): void => {
    switch (message.t) {
      case 'welcome':
        set({ selfId: message.id, selfName: message.name });
        writeStored(STORAGE.name, message.name);
        break;

      case 'players': {
        const selfId = get().selfId;
        set({ players: message.players.filter((p) => p.id !== selfId) });
        break;
      }

      case 'invited':
        set((s) =>
          s.incoming.some((p) => p.id === message.from.id)
            ? s
            : { incoming: [...s.incoming, message.from] },
        );
        break;

      case 'invite-sent':
        set((s) =>
          s.outgoing.includes(message.to.id) ? s : { outgoing: [...s.outgoing, message.to.id] },
        );
        break;

      case 'invite-withdrawn':
        set((s) => ({ incoming: s.incoming.filter((p) => p.id !== message.from) }));
        break;

      case 'declined':
        set((s) => ({ outgoing: s.outgoing.filter((id) => id !== message.by.id) }));
        notify(
          message.reason === 'declined'
            ? message.by.name + ' declined.'
            : message.by.name + ' is no longer available.',
        );
        break;

      case 'start':
        notify(null);
        set({
          match: {
            matchId: message.matchId,
            role: message.role,
            side: message.side,
            opponent: message.opponent,
          },
          incoming: [],
          outgoing: [],
        });
        break;

      case 'peer':
        for (const listener of peerListeners) listener(message.d);
        break;

      case 'ended': {
        const match = get().match;
        set({ match: null });
        if (match) {
          notify(
            message.reason === 'left'
              ? match.opponent.name + ' left the match.'
              : match.opponent.name + ' disconnected.',
          );
        }
        break;
      }

      case 'notice':
        notify(message.message);
        break;
    }
  };

  const ensureClient = (): NetClient => {
    if (!client) {
      client = new NetClient({
        onStatus: (status) => {
          // A dropped socket cannot carry a match, and every invite is stale.
          if (status !== 'online') set({ players: [], incoming: [], outgoing: [], match: null });
          set({ status });
        },
        onMessage: handle,
      });
    }
    return client;
  };

  return {
    status: 'offline',
    lobbyUrl: initialLobbyUrl(),
    selfId: null,
    selfName: suggestName(),
    players: [],
    incoming: [],
    outgoing: [],
    match: null,
    notice: null,

    connect: () => {
      const { selfName, lobbyUrl } = get();
      ensureClient().connect(selfName, lobbyUrl);
    },

    setName: (raw) => {
      const name = raw.replace(/\s+/g, ' ').trim().slice(0, 18);
      if (!name || name === get().selfName) return;
      set({ selfName: name });
      writeStored(STORAGE.name, name);
      ensureClient().send({ t: 'rename', name });
    },

    setLobbyUrl: (url) => {
      const next = url.trim();
      if (!next || next === get().lobbyUrl) return;
      set({ lobbyUrl: next });
      writeStored(STORAGE.lobby, next);
      ensureClient().connect(get().selfName, next);
    },

    challenge: (id) => ensureClient().send({ t: 'challenge', to: id }),

    withdraw: (id) => {
      set((s) => ({ outgoing: s.outgoing.filter((other) => other !== id) }));
      ensureClient().send({ t: 'withdraw', to: id });
    },

    accept: (id) => {
      set((s) => ({ incoming: s.incoming.filter((p) => p.id !== id) }));
      ensureClient().send({ t: 'accept', from: id });
    },

    decline: (id) => {
      set((s) => ({ incoming: s.incoming.filter((p) => p.id !== id) }));
      ensureClient().send({ t: 'decline', from: id });
    },

    leaveMatch: () => {
      if (!get().match) return;
      set({ match: null });
      ensureClient().send({ t: 'leave' });
    },

    relay: (message) => ensureClient().relay(message),

    subscribePeer: (listener) => {
      peerListeners.add(listener);
      return () => {
        peerListeners.delete(listener);
      };
    },
  };
});
