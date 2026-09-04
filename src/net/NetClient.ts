import {
  decodeSnapshot,
  encodeSnapshot,
  type ClientMessage,
  type MatchMessage,
  type ServerMessage,
  type Snapshot,
} from './protocol';

/** The port `server/lobby-server.mjs` listens on unless PORT says otherwise. */
const LOBBY_PORT = '8787';

/** Reconnect backoff, in ms. The last value repeats. */
const BACKOFF = [500, 1000, 2000, 4000, 8000];

export type NetStatus = 'offline' | 'connecting' | 'online';

export interface NetClientHandlers {
  onStatus: (status: NetStatus) => void;
  onMessage: (message: ServerMessage) => void;
}

/**
 * Where the lobby lives, when nobody has said otherwise.
 *
 * A built game is served by the lobby process itself, so the same origin the
 * page came from is also the lobby — which is what makes the address typed on
 * the second computer work with no configuration at all. Under `npm run dev`
 * the page comes from Vite instead, so there we reach across to the lobby's own
 * port on the same host. Anything else is what the address field is for.
 */
export function defaultLobbyUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = import.meta.env.DEV ? LOBBY_PORT : window.location.port;
  const host = port ? window.location.hostname + ':' + port : window.location.hostname;
  return proto + '//' + host + '/lobby';
}

/**
 * The socket to the lobby. It owns exactly one connection, reconnects on its
 * own with a backoff, and hands every decoded message straight to the store.
 *
 * Nothing here knows what a match is: `relay` takes an opaque `MatchMessage`
 * and the engine on the other end decides what it means.
 */
export class NetClient {
  private socket: WebSocket | null = null;
  private url = defaultLobbyUrl();
  private name = 'Archer';
  private attempt = 0;
  private retryTimer: number | null = null;
  private wantConnection = false;
  private status: NetStatus = 'offline';

  constructor(private readonly handlers: NetClientHandlers) {}

  get serverUrl(): string {
    return this.url;
  }

  /** Opens the connection, or reopens it against a different address. */
  connect(name: string, url = this.url): void {
    this.name = name;
    this.wantConnection = true;
    if (url !== this.url) {
      this.url = url;
      this.close(false);
    }
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.open();
  }

  private open(): void {
    this.clearRetry();
    this.setStatus('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      // A malformed address throws synchronously rather than firing onerror.
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    // Snapshots arrive as raw bytes; anything else is text.
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('online');
      this.send({ t: 'hello', name: this.name });
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // The relay forwards these untouched, so there is no envelope to strip:
        // a binary frame in a match is a snapshot and nothing else.
        const snapshot = decodeSnapshot(event.data);
        if (snapshot) this.handlers.onMessage({ t: 'peer', d: { k: 'snap', s: snapshot } });
        return;
      }

      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      // The server assigns the final name, so keep ours in step for reconnects.
      if (message.t === 'welcome') this.name = message.name;
      this.handlers.onMessage(message);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('offline');
      if (this.wantConnection) this.scheduleRetry();
    };

    // `onerror` is always followed by `onclose`, which owns the retry.
    socket.onerror = () => undefined;
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.wantConnection) this.open();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: NetStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  /** Forwards a match message to the opponent, if there is one. */
  relay(message: MatchMessage): void {
    this.send({ t: 'relay', d: message });
  }

  /**
   * The hot path: one frame of the host's world, packed and sent raw.
   *
   * It skips the `relay` envelope entirely — the server forwards a binary frame
   * to the paired socket without decoding it, so a snapshot is never parsed and
   * re-serialised on its way through.
   */
  relaySnapshot(snapshot: Snapshot): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeSnapshot(snapshot));
  }

  /** Closes the socket. `permanent` also stops it from reconnecting. */
  close(permanent = true): void {
    if (permanent) this.wantConnection = false;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    if (permanent) this.setStatus('offline');
  }
}
