/**
 * Measures what an online match actually costs on the wire, and checks that a
 * slow link is survivable.
 *
 * The number that matters is the host's *upload*: it is the one side sending
 * continuously, home connections are asymmetric, and a saturated uplink does not
 * drop frames politely — it delays them, which the guest then has to buffer
 * against, which is felt as lag. So there is a budget here, and it is asserted.
 *
 * The second half re-runs the same match through a relay holding every frame for
 * a set delay, which is the only way to see the lag compensation do anything on
 * two machines sharing a desk.
 *
 *   node scripts/wire-check.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome or Edge binary found');
if (!existsSync(resolve(root, 'dist/index.html'))) {
  throw new Error('No dist/ build found. Run "npm run build" first.');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const note = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures.push(label + (detail ? ' - ' + detail : ''));
};

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

/** KB/s the host may spend uploading during continuous play. */
const HOST_UPLOAD_BUDGET = 8;
/** KB/s the guest may spend: a button and a heartbeat, and nothing else. */
const GUEST_UPLOAD_BUDGET = 1;
/** Bytes for one frame of the world. */
const FRAME_BUDGET = 320;

/**
 * Counts every byte the page puts on or takes off a socket, by wrapping the
 * WebSocket it is about to construct. Nothing in the game is aware of it.
 */
const INSTRUMENT = () => {
  const wire = { sent: 0, sentN: 0, recv: 0, recvN: 0, binN: 0, binBytes: 0, frames: [] };
  window.__wire = wire;
  const sizeOf = (d) =>
    typeof d === 'string' ? new TextEncoder().encode(d).length : (d.byteLength ?? d.size ?? 0);

  const Original = window.WebSocket;
  function Wrapped(...args) {
    const socket = new Original(...args);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      wire.sent += sizeOf(data);
      wire.sentN++;
      return send(data);
    };
    socket.addEventListener('message', (event) => {
      const n = sizeOf(event.data);
      wire.recv += n;
      wire.recvN++;
      if (typeof event.data !== 'string') {
        wire.binN++;
        wire.binBytes += n;
        wire.frames.push(n);
      }
    });
    return socket;
  }
  Wrapped.prototype = Original.prototype;
  Object.assign(Wrapped, Original);
  window.WebSocket = Wrapped;
};

/* ------------------------------------------------------------------ *
 * One measured match
 * ------------------------------------------------------------------ */

async function runMatch({ delayMs, seconds, label }) {
  const port = await new Promise((res, rej) => {
    const probe = createServer();
    probe.on('error', rej);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });

  const server = spawn(process.execPath, [resolve(root, 'server/lobby-server.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LOBBY_DELAY_MS: String(delayMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('lobby server did not start')), 20000);
    server.stdout.on('data', (c) => {
      if (c.toString().includes('listening on port')) {
        clearTimeout(timer);
        setTimeout(ready, 200);
      }
    });
    server.stderr.on('data', (c) => process.stderr.write(c));
  });

  // A browser each: a background tab gets no animation frames, and the host's
  // animation frame is the match.
  const launch = () =>
    puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  const browsers = [await launch(), await launch()];

  const open = async (name, browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(INSTRUMENT);
    await page.goto('http://localhost:' + port + '/?name=' + name, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.menu', { timeout: 15000 });
    return page;
  };

  try {
    const host = await open('Hosty', browsers[0]);
    const guest = await open('Guesty', browsers[1]);
    await wait(1500);

    await host.evaluate(() => {
      [...document.querySelectorAll('.player .btn')]
        .find((b) => b.textContent.includes('Challenge'))
        .click();
    });
    await wait(1200 + delayMs * 4);
    await guest.evaluate(() => {
      [...document.querySelectorAll('.invite .btn')]
        .find((b) => b.textContent.trim() === 'Accept')
        .click();
    });
    await Promise.all([host.waitForSelector('canvas'), guest.waitForSelector('canvas')]);
    // Let the round intro finish and the arrival-rate estimate settle.
    await wait(3500);

    const reset = (page) =>
      page.evaluate(() => {
        const w = window.__wire;
        w.sent = w.sentN = w.recv = w.recvN = w.binN = w.binBytes = 0;
        w.frames = [];
      });
    await Promise.all([reset(host), reset(guest)]);

    const started = Date.now();
    for (let i = 0; Date.now() - started < seconds * 1000; i++) {
      await Promise.all([host.keyboard.down('ArrowUp'), guest.keyboard.down('ArrowUp')]);
      await wait(300 + (i % 3) * 180);
      await host.keyboard.up('ArrowUp');
      await wait(120);
      await guest.keyboard.up('ArrowUp');
      await wait(360);
    }
    const elapsed = (Date.now() - started) / 1000;

    const readWire = (page) => page.evaluate(() => window.__wire);
    const hostWire = await readWire(host);
    const guestWire = await readWire(guest);
    const pingText = await guest.evaluate(
      () => (document.querySelector('.lobby__meta')?.textContent.match(/(\d+)ms/) ?? [])[1],
    );
    const alive = await guest.evaluate(() => !document.querySelector('.hud__stalled'));

    const frames = guestWire.frames.slice().sort((a, b) => a - b);
    return {
      label,
      elapsed,
      hostUp: hostWire.sent / elapsed / 1024,
      guestUp: guestWire.sent / elapsed / 1024,
      guestDown: guestWire.recv / elapsed / 1024,
      frameRate: guestWire.binN / elapsed,
      frameMedian: frames.length ? frames[Math.floor(frames.length / 2)] : 0,
      frameMax: frames.length ? frames[frames.length - 1] : 0,
      ping: pingText ? Number(pingText) : null,
      alive,
    };
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    server.kill('SIGTERM');
  }
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

console.log('\nOn a local link:');
const local = await runMatch({ delayMs: 0, seconds: 16, label: 'local' });
console.log(
  '  host up ' + local.hostUp.toFixed(1) + ' KB/s   guest up ' + local.guestUp.toFixed(2) +
    ' KB/s   frames ' + local.frameRate.toFixed(0) + '/s of ' + local.frameMedian + ' bytes' +
    ' (max ' + local.frameMax + ')',
);

note(
  local.hostUp < HOST_UPLOAD_BUDGET,
  'the host stays inside its upload budget',
  local.hostUp.toFixed(1) + ' of ' + HOST_UPLOAD_BUDGET + ' KB/s',
);
note(
  local.guestUp < GUEST_UPLOAD_BUDGET,
  'the guest sends almost nothing back',
  local.guestUp.toFixed(2) + ' of ' + GUEST_UPLOAD_BUDGET + ' KB/s',
);
note(
  local.frameMedian > 0 && local.frameMedian < FRAME_BUDGET,
  'one frame of the world fits in a packet',
  local.frameMedian + ' bytes, budget ' + FRAME_BUDGET,
);
note(
  local.frameRate > 20 && local.frameRate < 40,
  'frames arrive at about the rate they are sent',
  local.frameRate.toFixed(0) + '/s',
);
note(local.alive, 'the match is running, not stalled');

const DELAY = 120;
console.log('\nThrough a relay holding every frame ' + DELAY + 'ms each way:');
const slow = await runMatch({ delayMs: DELAY, seconds: 16, label: 'slow' });
console.log(
  '  host up ' + slow.hostUp.toFixed(1) + ' KB/s   frames ' + slow.frameRate.toFixed(0) +
    '/s of ' + slow.frameMedian + ' bytes   reported ping ' + slow.ping + 'ms',
);

note(slow.alive, 'a slow link still plays rather than stalling');
note(
  slow.frameRate > 20 && slow.frameRate < 40,
  'delay does not cost frames, only time',
  slow.frameRate.toFixed(0) + '/s',
);
// The probe crosses the relay twice, so it should read about two delays.
note(
  slow.ping !== null && slow.ping >= DELAY * 1.5 && slow.ping <= DELAY * 2 + 90,
  'the round trip is measured honestly',
  slow.ping + 'ms across a ' + DELAY + 'ms each-way relay',
);
note(
  slow.hostUp < HOST_UPLOAD_BUDGET,
  'a slow link does not inflate what the host sends',
  slow.hostUp.toFixed(1) + ' KB/s',
);

console.log('');
if (failures.length) {
  console.error('  ' + failures.length + ' check(s) failed:\n   - ' + failures.join('\n   - '));
  process.exit(1);
}
console.log('  all wire checks passed\n');
