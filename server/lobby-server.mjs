/**
 * Drunken Archers — lobby and match relay.
 *
 * One small Node process does two jobs:
 *
 *   1. Serves the production build in `dist/`, so a second computer only needs
 *      the URL printed at startup.
 *   2. Runs the WebSocket lobby: who is online, who is challenging whom, and
 *      the message pipe between the two players of a live match.
 *
 * It is deliberately not a game server. It never sees a body transform and
 * never decides a hit — the challenger's browser is the authority for its own
 * match, and all this process does is forward bytes to the one other socket
 * that is allowed to receive them.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

/** Names are shown to strangers, so they are stripped and length-capped. */
const MAX_NAME = 18;
/** A single relayed frame is bounded; a snapshot sits well under a kilobyte. */
const MAX_RELAY_BYTES = 64 * 1024;
/** Sockets that miss two heartbeats are dropped and removed from the lobby. */
const HEARTBEAT_MS = 15000;

/* ------------------------------------------------------------------ *
 * Static file serving
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and reject anything that climbs back out of it.
  const candidate = resolve(join(ROOT, normalize(pathname)));
  const inRoot = candidate === ROOT || candidate.startsWith(ROOT + sep);

  const sendFile = async (file) => {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      // Asset names are content-hashed; index.html must not be cached or a
      // rebuild stays invisible to whoever already has the page open.
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
  };

  try {
    if (!inRoot) throw new Error('outside root');
    await sendFile(candidate);
  } catch {
    try {
      await sendFile(join(ROOT, 'index.html'));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'No build found in dist/. Run "npm run build" first, or run "npm run dev"\n' +
          'here and point the other computer at the address Vite prints.\n',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Lobby state
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Client
 * @property {string} id
 * @property {string} name
 * @property {import('ws').WebSocket} ws
 * @property {'idle'|'inMatch'} status
 * @property {string|null} opponentId
 * @property {string|null} matchId
 * @property {Set<string>} invitesOut ids this client has challenged
 * @property {Set<string>} invitesIn  ids that have challenged this client
 * @property {boolean} alive
 */

/** @type {Map<string, Client>} */
const clients = new Map();

const cleanName = (raw, fallback) => {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return name || fallback;
};

/** A name nobody else is using, so the list is never ambiguous. */
function uniqueName(base, selfId) {
  const taken = new Set(
    [...clients.values()].filter((c) => c.id !== selfId).map((c) => c.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 999; n++) {
    const candidate = (base + ' ' + n).slice(0, MAX_NAME + 4);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

const send = (client, message) => {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message));
};

const publicView = (client) => ({ id: client.id, name: client.name, status: client.status });

/** The lobby is small, so it is simply re-sent in full whenever it changes. */
function broadcastPlayers() {
  const payload = JSON.stringify({
    t: 'players',
    players: [...clients.values()].map(publicView),
  });
  for (const client of clients.values()) {
    if (client.ws.readyState === 1) client.ws.send(payload);
  }
}

/** Drops every pending invite in either direction, telling the other end. */
function clearInvites(client) {
  for (const id of client.invitesOut) {
    const target = clients.get(id);
    if (!target) continue;
    target.invitesIn.delete(client.id);
    send(target, { t: 'invite-withdrawn', from: client.id });
  }
  for (const id of client.invitesIn) {
    const source = clients.get(id);
    if (!source) continue;
    source.invitesOut.delete(client.id);
    send(source, { t: 'declined', by: publicView(client), reason: 'unavailable' });
  }
  client.invitesOut.clear();
  client.invitesIn.clear();
}

function endMatch(client, reason) {
  const opponent = client.opponentId ? clients.get(client.opponentId) : null;
  for (const party of [client, opponent]) {
    if (!party) continue;
    party.status = 'idle';
    party.opponentId = null;
    party.matchId = null;
  }
  if (opponent) send(opponent, { t: 'ended', reason });
}

/* ------------------------------------------------------------------ *
 * Message handling
 * ------------------------------------------------------------------ */

const HANDLERS = {
  hello(client, msg) {
    client.name = uniqueName(cleanName(msg.name, 'Archer'), client.id);
    send(client, { t: 'welcome', id: client.id, name: client.name });
    broadcastPlayers();
  },

  rename(client, msg) {
    const next = uniqueName(cleanName(msg.name, client.name), client.id);
    if (next === client.name) return;
    client.name = next;
    send(client, { t: 'welcome', id: client.id, name: client.name });
    broadcastPlayers();
  },

  challenge(client, msg) {
    const target = clients.get(String(msg.to));
    if (!target || target.id === client.id) {
      send(client, { t: 'notice', level: 'error', message: 'That player is no longer here.' });
      return;
    }
    if (client.status !== 'idle' || target.status !== 'idle') {
      send(client, { t: 'notice', level: 'error', message: target.name + ' is already in a match.' });
      return;
    }
    // If they had already challenged us, the second challenge is an accept.
    if (client.invitesIn.has(target.id)) {
      HANDLERS.accept(client, { from: target.id });
      return;
    }
    if (client.invitesOut.has(target.id)) return;

    client.invitesOut.add(target.id);
    target.invitesIn.add(client.id);
    send(target, { t: 'invited', from: publicView(client) });
    send(client, { t: 'invite-sent', to: publicView(target) });
  },

  withdraw(client, msg) {
    const id = String(msg.to);
    if (!client.invitesOut.delete(id)) return;
    const target = clients.get(id);
    if (target) {
      target.invitesIn.delete(client.id);
      send(target, { t: 'invite-withdrawn', from: client.id });
    }
  },

  decline(client, msg) {
    const id = String(msg.from);
    if (!client.invitesIn.delete(id)) return;
    const source = clients.get(id);
    if (source) {
      source.invitesOut.delete(client.id);
      send(source, { t: 'declined', by: publicView(client), reason: 'declined' });
    }
  },

  accept(client, msg) {
    const host = clients.get(String(msg.from));
    if (!host || !client.invitesIn.has(host.id)) {
      send(client, { t: 'notice', level: 'error', message: 'That challenge has expired.' });
      return;
    }
    if (host.status !== 'idle' || client.status !== 'idle') {
      client.invitesIn.delete(host.id);
      host.invitesOut.delete(client.id);
      send(client, { t: 'notice', level: 'error', message: host.name + ' is already in a match.' });
      return;
    }

    // Every other pending invite for either player is now stale.
    clearInvites(client);
    clearInvites(host);

    const matchId = randomUUID();
    // The challenger hosts: their browser owns the simulation, and it takes the
    // blue left-hand side so both screens agree on who is who.
    const pairing = [
      [host, client, 'host', 'left'],
      [client, host, 'guest', 'right'],
    ];
    for (const [self, other, role, side] of pairing) {
      self.status = 'inMatch';
      self.opponentId = other.id;
      self.matchId = matchId;
      send(self, { t: 'start', matchId, role, side, opponent: publicView(other) });
    }
    broadcastPlayers();
  },

  leave(client) {
    if (client.status !== 'inMatch') return;
    endMatch(client, 'left');
    broadcastPlayers();
  },

  relay(client, msg, raw) {
    if (client.status !== 'inMatch' || !client.opponentId) return;
    if (raw.length > MAX_RELAY_BYTES) return;
    const opponent = clients.get(client.opponentId);
    // Only ever to the one socket paired with this one.
    if (opponent) send(opponent, { t: 'peer', d: msg.d });
  },
};

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});

const wss = new WebSocketServer({
  server: httpServer,
  path: '/lobby',
  maxPayload: MAX_RELAY_BYTES,
});

wss.on('connection', (ws) => {
  /** @type {Client} */
  const client = {
    id: randomUUID().slice(0, 8),
    name: 'Archer',
    ws,
    status: 'idle',
    opponentId: null,
    matchId: null,
    invitesOut: new Set(),
    invitesIn: new Set(),
    alive: true,
  };
  clients.set(client.id, client);

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const handler = HANDLERS[msg && msg.t];
    if (handler) handler(client, msg, raw);
  });

  ws.on('close', () => {
    clients.delete(client.id);
    clearInvites(client);
    if (client.status === 'inMatch') endMatch(client, 'disconnected');
    broadcastPlayers();
  });

  ws.on('error', () => ws.terminate());
});

// A tab closed by a lid or a dropped network never sends a close frame, so
// without this a ghost would sit in everyone's list until the TCP timeout.
const heartbeat = setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

function localAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

httpServer.listen(PORT, () => {
  console.log('\n  Drunken Archers lobby listening on port ' + PORT + '\n');
  console.log('  This computer   http://localhost:' + PORT);
  for (const address of localAddresses()) {
    console.log('  Other computer  http://' + address + ':' + PORT);
  }
  console.log('\n  Serving ' + ROOT + '\n');
});
