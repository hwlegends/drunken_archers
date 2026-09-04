/**
 * Plays one online match between two real browsers, through the real lobby.
 *
 * Nothing here is stubbed: the lobby process serves the production build and
 * relays the match, one page hosts the simulation and the other only replays
 * it. The final assertion is that both screens agree on a score neither of them
 * could have reached alone — which is only true if the guest's button reached
 * the host, the host's world reached the guest, and both ends stayed in step.
 *
 *   node scripts/online-check.mjs [outDir]
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? resolve(root, 'shots'));
mkdirSync(outDir, { recursive: true });

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

/* ---- the lobby, on a port nothing else is using ------------------ */

const freePort = await new Promise((res, rej) => {
  const probe = createServer();
  probe.on('error', rej);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});

const server = spawn(process.execPath, [resolve(root, 'server/lobby-server.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(freePort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = 'http://localhost:' + freePort + '/';

function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
}
process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

await new Promise((ready, reject) => {
  const timer = setTimeout(() => reject(new Error('lobby server did not start')), 20000);
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('listening on port')) {
      clearTimeout(timer);
      setTimeout(ready, 200);
    }
  });
  server.stderr.on('data', (c) => process.stderr.write(c));
});

/* ---- two browsers ------------------------------------------------ */

/**
 * One browser per player, not two tabs in one.
 *
 * A background tab does not get requestAnimationFrame at all, and the host's
 * animation frame is the match: run both pages in one browser and whichever is
 * not focused stops simulating, which is a fact about tabs rather than anything
 * this game does. Two computers is what the feature is, so the test uses two
 * browsers.
 */
const launch = () =>
  puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
  });

const browsers = [await launch(), await launch()];

const failures = [];
const note = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures.push(label + (detail ? ' - ' + detail : ''));
};

const problems = [];

/**
 * Records where each archer is drawn, by wrapping the canvas call the renderer
 * makes once per archer to lay down its ground shadow. On the guest this is
 * proof of what the host sent, because the guest draws nothing of its own.
 */
const WATCH_POSITIONS = () => {
  window.__x = [];
  const ellipse = CanvasRenderingContext2D.prototype.ellipse;
  CanvasRenderingContext2D.prototype.ellipse = function (x, y, rx, ry, ...rest) {
    if (rx === 28 && ry === 7) window.__x.push(x);
    return ellipse.call(this, x, y, rx, ry, ...rest);
  };
};

async function openPage(name, browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(WATCH_POSITIONS);
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(name + ': ' + m.text());
  });
  page.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message));
  await page.goto(origin + '?name=' + name, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.menu', { timeout: 15000 });
  return page;
}

/** Polls `fn` on a page until it returns truthy, or gives up. */
async function until(page, fn, timeoutMs, step = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.evaluate(fn);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await wait(step);
  }
}

const readScore = (page) =>
  page.evaluate(() => {
    const l = document.querySelector('.hud__pip--left');
    const r = document.querySelector('.hud__pip--right');
    return l && r ? l.textContent + ':' + r.textContent : null;
  });

/** A coarse fingerprint of what the canvas is showing right now. */
const canvasFingerprint = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 420)).data;
    let hash = 0;
    for (let i = 0; i < d.length; i += 4 * 53) {
      hash = (hash * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
    }
    return hash;
  });

try {
  const host = await openPage('Hosty', browsers[0]);
  const guest = await openPage('Guesty', browsers[1]);

  /* ---- the lobby lists both -------------------------------------- */

  const hostSeesGuest = await until(
    host,
    () => [...document.querySelectorAll('.player__name')].map((e) => e.textContent).join(','),
    10000,
  );
  note(hostSeesGuest === 'Guesty', 'each computer appears in the other list', String(hostSeesGuest));
  await host.screenshot({ path: resolve(outDir, '20-lobby.png') });

  const connected = await host.$eval('.dot', (e) => e.className.includes('online'));
  note(connected, 'lobby reports a live connection');

  /* ---- the panel gets out of the way ----------------------------- */

  await host.click('.lobby__collapse');
  const collapsed = await until(host, () => !!document.querySelector('.lobby-tab'), 3000);
  const wider = await host.$eval('.stage', (c) => c.getBoundingClientRect().width);
  await host.screenshot({ path: resolve(outDir, '20b-lobby-collapsed.png') });
  await host.click('.lobby-tab');
  const reopened = await until(host, () => !!document.querySelector('.lobby'), 3000);
  const narrower = await host.$eval('.stage', (c) => c.getBoundingClientRect().width);
  note(
    !!collapsed && !!reopened && wider > narrower,
    'the panel collapses to a rail and gives the arena the space back',
    wider.toFixed(0) + 'px collapsed vs ' + narrower.toFixed(0) + 'px open',
  );

  /* ---- one player turns the sidestep on, the other does not ------ */

  const sidestepOn = await guest.evaluate(() => {
    const toggle = [...document.querySelectorAll('.toggle')].find((t) =>
      t.textContent.includes('Sidestep'),
    );
    if (!toggle) return null;
    if (toggle.dataset.on !== 'true') toggle.click();
    return toggle.dataset.on === 'true' || true;
  });
  note(sidestepOn !== null, 'the sidestep is offered as a menu option');

  /* ---- challenge and accept -------------------------------------- */

  await host.evaluate(() => {
    [...document.querySelectorAll('.player .btn')]
      .find((b) => b.textContent.includes('Challenge'))
      .click();
  });

  const invited = await until(guest, () => !!document.querySelector('.invite'), 8000);
  note(!!invited, 'the challenge reaches the other computer');
  await guest.screenshot({ path: resolve(outDir, '21-challenge-received.png') });

  const waiting = await host.$eval('.player .btn', (b) => b.textContent.trim());
  note(waiting.includes('Waiting'), 'the challenger is shown waiting', waiting);

  await guest.evaluate(() => {
    [...document.querySelectorAll('.invite .btn')]
      .find((b) => b.textContent.trim() === 'Accept')
      .click();
  });

  /* ---- both enter the same match --------------------------------- */

  const hostInMatch = await until(host, () => !!document.querySelector('.lobby__match'), 8000);
  const guestInMatch = await until(guest, () => !!document.querySelector('.lobby__match'), 8000);
  note(!!hostInMatch && !!guestInMatch, 'accepting starts the match on both computers');

  const roles = await Promise.all([
    host.$eval('.lobby__meta', (e) => e.textContent),
    guest.$eval('.lobby__meta', (e) => e.textContent),
  ]);
  note(
    roles[0].includes('Cobalt') && roles[0].includes('hosting') && roles[1].includes('Ember'),
    'the challenger hosts and takes the blue side',
    roles.join(' | '),
  );

  await Promise.all([host.waitForSelector('canvas'), guest.waitForSelector('canvas')]);
  await wait(2200);
  await host.screenshot({ path: resolve(outDir, '22-online-host.png') });
  await guest.screenshot({ path: resolve(outDir, '23-online-guest.png') });

  /* ---- the guest is being fed a live world ----------------------- */

  const before = await canvasFingerprint(guest);
  await wait(600);
  const after = await canvasFingerprint(guest);
  note(
    before !== null && after !== null && before !== after,
    'the guest renders a world that is moving, not a frozen frame',
  );

  const guestScene = await guest.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) {
      seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    }
    return seen.size;
  });
  note(guestScene > 12, 'the guest draws the full arena, not a placeholder', guestScene + ' colours');

  const latencyShown = await until(
    host,
    () => (document.querySelector('.lobby__meta')?.textContent.match(/(\d+)ms/) ?? [])[1],
    6000,
  );
  note(latencyShown !== null, 'round trip is measured and displayed', latencyShown + 'ms');

  /* ---- the guest can step, and the host is the one moving it ----- */

  /**
   * The guest draws nothing of its own: every pixel of that archer came off a
   * snapshot. So seeing its own archer move on its own screen is proof of the
   * whole path — keypress, relay, the host applying the step to the archer it
   * simulates, and the frame coming back.
   */
  /**
   * Walks an archer to one edge of its platform, then to the other, and reports
   * how far the stance moved between them.
   *
   * Reading the stance is the awkward part: the archer swings through a wide arc
   * on its own, and full leans come anywhere from 1.7 to 7.2 seconds apart, so
   * any short window reads that arc as movement. What is stable is the leftmost
   * point of a lean — the arc has the same width wherever the archer stands, so
   * the *difference* between two windows' minima is the stance difference and
   * the lean cancels out. Pinning against both edges then makes the signal the
   * full usable width of the platform, several times the noise left over.
   */
  const traverse = async (page, second, label) => {
    const leftmost = async () => {
      await page.evaluate(() => {
        window.__x = [];
      });
      await wait(5000);
      return page.evaluate((takeSecond) => {
        const mine = window.__x.filter((_, i) => (i % 2 === 1) === takeSecond);
        return mine.length ? Math.min(...mine) : null;
      }, second);
    };
    const press = async (key, times) => {
      for (let i = 0; i < times; i++) {
        await page.keyboard.press(key);
        await wait(420);
      }
    };

    await press('ArrowLeft', 6);
    const atLeft = await leftmost();
    await press('ArrowRight', 12);
    const atRight = await leftmost();
    if (atLeft === null || atRight === null) return null;
    void label;
    return atRight - atLeft;
  };

  // The guest draws nothing of its own, so its archer moving on its own screen
  // is the whole path proven: keypress, relay, the host stepping the archer it
  // simulates, and the frame coming back.
  const guestTravel = await traverse(guest, true, 'guest');
  note(
    guestTravel !== null && guestTravel > 55,
    'a sidestep on the guest is carried out by the host and comes back',
    guestTravel === null ? 'no archer sampled' : guestTravel.toFixed(0) + 'px across the platform',
  );
  await guest.screenshot({ path: resolve(outDir, '23c-guest-stepped.png') });

  // The host never turned the option on, so the same keys must do nothing.
  const hostTravel = await traverse(host, false, 'host');
  note(
    hostTravel !== null && Math.abs(hostTravel) < 55,
    'and the player who left the option off does not move',
    hostTravel === null ? 'no archer sampled' : Math.abs(hostTravel).toFixed(0) + 'px of drift',
  );

  /* ---- a stalled host is explained, not just frozen -------------- */

  // The real failure this guards: a browser gives a hidden tab no animation
  // frames, and the host's animation frame is the match. Backgrounding the host
  // page is that situation exactly.
  const distraction = await browsers[0].newPage();
  await distraction.goto('about:blank');
  await distraction.bringToFront();

  const stallShown = await until(guest, () => !!document.querySelector('.hud__stalled'), 9000);
  note(!!stallShown, 'the guest is told when the host window stops running');
  await guest.screenshot({ path: resolve(outDir, '23b-host-stalled.png') });

  await host.bringToFront();
  const stallCleared = await until(
    guest,
    () => (document.querySelector('.hud__stalled') ? null : 'cleared'),
    9000,
  );
  note(stallCleared === 'cleared', 'and the match picks up again when it returns');
  await distraction.close();

  /* ---- both play a whole match, and both see the same of it ------ */

  /** One volley from each side. The hold lengths differ so the two archers do
   *  not end up firing in permanent lockstep. */
  const volley = async (i) => {
    await Promise.all([host.keyboard.down('ArrowUp'), guest.keyboard.down('ArrowUp')]);
    await wait(220 + (i % 4) * 200);
    await host.keyboard.up('ArrowUp');
    await wait(90 + (i % 3) * 120);
    await guest.keyboard.up('ArrowUp');
    await wait(320);
  };

  const resultTitle = (page) =>
    page.evaluate(() => document.querySelector('.panel__title')?.textContent.trim() ?? null);

  let score = null;
  let firstPoint = null;
  let title = null;
  // Played out in full: every round rebuilds the arena from a fresh seed on both
  // machines, so five rounds is five re-synchronisations rather than one.
  for (let i = 0; i < 700 && !title; i++) {
    await volley(i);
    score = await readScore(host);
    if (!firstPoint && score && score !== '0:0') {
      firstPoint = score;
      // Read the guest immediately: the point exists on its screen only because
      // the host's event arrived and was replayed there.
      const echo = await until(guest, () => {
        const l = document.querySelector('.hud__pip--left');
        const r = document.querySelector('.hud__pip--right');
        return l && r ? l.textContent + ':' + r.textContent : null;
      }, 5000);
      note(true, 'a point is scored in the online match', 'host ' + firstPoint);
      note(echo === firstPoint, 'both computers show the same score', 'host ' + firstPoint + ' guest ' + echo);
      await host.screenshot({ path: resolve(outDir, '26-online-point-host.png') });
      await guest.screenshot({ path: resolve(outDir, '27-online-point-guest.png') });
    }
    if (i === 6) {
      await host.screenshot({ path: resolve(outDir, '24-online-volley-host.png') });
      await guest.screenshot({ path: resolve(outDir, '25-online-volley-guest.png') });
    }
    title = await resultTitle(host);
  }

  if (!firstPoint) note(false, 'a point is scored in the online match', 'host ' + score);

  const guestTitle = await until(guest, () => {
    const el = document.querySelector('.panel__title');
    return el ? el.textContent.trim() : null;
  }, 6000);

  note(title !== null, 'the match plays out to a result', 'host ' + title);
  // One won and one lost: the result is read against the archer each was given,
  // so the two screens must disagree here, and only here.
  note(
    (title === 'Victory' && guestTitle === 'Defeated') ||
      (title === 'Defeated' && guestTitle === 'Victory'),
    'each computer is told whether it won, not who won',
    'host ' + title + ' / guest ' + guestTitle,
  );
  await host.screenshot({ path: resolve(outDir, '28-online-result-host.png') });
  await guest.screenshot({ path: resolve(outDir, '29-online-result-guest.png') });

  const guestOffered = await guest.evaluate(
    () => !![...document.querySelectorAll('.panel__waiting')].length,
  );
  note(guestOffered, 'only the challenger is offered the rematch');

  /* ---- rematch rebuilds both ends -------------------------------- */

  await host.evaluate(() => {
    [...document.querySelectorAll('.panel .btn')]
      .find((b) => b.textContent.trim() === 'Rematch')
      .click();
  });

  const hostReset = await until(host, () => {
    if (document.querySelector('.panel__title')) return null;
    const l = document.querySelector('.hud__pip--left');
    const r = document.querySelector('.hud__pip--right');
    return l && r ? l.textContent + ':' + r.textContent : null;
  }, 10000);
  const guestReset = await until(guest, () => {
    if (document.querySelector('.panel__title')) return null;
    const l = document.querySelector('.hud__pip--left');
    const r = document.querySelector('.hud__pip--right');
    return l && r ? l.textContent + ':' + r.textContent : null;
  }, 10000);
  note(
    hostReset === '0:0' && guestReset === '0:0',
    'a rematch restarts both computers, not just the challenger',
    'host ' + hostReset + ' guest ' + guestReset,
  );

  // And the rebuilt guest is being fed the new world, not the old one.
  const rematchBefore = await canvasFingerprint(guest);
  await wait(700);
  const rematchAfter = await canvasFingerprint(guest);
  note(rematchBefore !== rematchAfter, 'the guest is live again after a rematch');
  await guest.screenshot({ path: resolve(outDir, '30-online-rematch-guest.png') });

  /* ---- leaving releases the other player ------------------------- */

  await host.evaluate(() => {
    [...document.querySelectorAll('.lobby .btn')]
      .find((b) => b.textContent.includes('Leave match'))
      .click();
  });

  const guestReleased = await until(
    guest,
    () => !document.querySelector('.lobby__match') && !!document.querySelector('.menu'),
    8000,
  );
  note(!!guestReleased, 'one player leaving returns the other to the lobby');

  const backInList = await until(
    guest,
    () => [...document.querySelectorAll('.player__name')].map((e) => e.textContent).join(','),
    8000,
  );
  note(backInList === 'Hosty', 'both are challengeable again afterwards', String(backInList));
  await guest.screenshot({ path: resolve(outDir, '31-after-leaving.png') });

  note(problems.length === 0, 'no console errors on either computer', problems.slice(0, 3).join(' | '));
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  stopServer();
}

console.log('\n  shots written to ' + outDir);
if (failures.length) {
  console.error('\n  ' + failures.length + ' check(s) failed:\n   - ' + failures.join('\n   - '));
  process.exit(1);
}
console.log('  all online checks passed\n');
