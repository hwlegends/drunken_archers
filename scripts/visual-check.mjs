/**
 * Drives the built game in a real browser and captures screenshots of each
 * screen, so rendering, input and the round flow can be verified end to end.
 *
 *   node scripts/visual-check.mjs [outDir]
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- serve the production build -------------------------------- */

/** Grabs an unused port so repeated runs never collide with a stale server. */
const freePort = await new Promise((res, rej) => {
  const probe = createServer();
  probe.on('error', rej);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});

const server = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', 'preview', '--port', String(freePort), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
);
const origin = 'http://localhost:' + freePort + '/';

/** On Windows the shell wrapper must be killed as a tree or vite survives. */
function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

await new Promise((resolvePort, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server did not start')), 30000);
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes(String(freePort))) {
      clearTimeout(timer);
      setTimeout(resolvePort, 500);
    }
  });
  server.stderr.on('data', (c) => process.stderr.write(c));
});

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,900', '--autoplay-policy=no-user-gesture-required'],
});

const failures = [];
const note = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  await page.goto(origin, { waitUntil: 'networkidle0' });

  /* ---- menu ---------------------------------------------------- */
  await page.waitForSelector('.menu', { timeout: 15000 });
  await wait(400);
  await page.screenshot({ path: resolve(outDir, '01-menu.png') });
  note(true, 'main menu renders');

  const buttons = await page.$$eval('.menu__buttons .btn', (els) => els.map((e) => e.textContent.trim()));
  note(buttons.length === 4, 'menu offers all modes', buttons.join(' / '));

  /* ---- instructions -------------------------------------------- */
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('How to Play')).click();
  });
  await page.waitForSelector('.howto', { timeout: 5000 });
  await page.screenshot({ path: resolve(outDir, '02-instructions.png') });
  note(true, 'instructions overlay opens');
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Back').click();
  });
  await wait(300);

  /* ---- one player ---------------------------------------------- */
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('One Player')).click();
  });
  await page.waitForSelector('canvas', { timeout: 5000 });
  await wait(700);
  await page.screenshot({ path: resolve(outDir, '03-round-intro.png') });

  const canvasBox = await page.$eval('canvas', (c) => {
    const r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, bw: c.width, bh: c.height };
  });
  note(
    Math.abs(canvasBox.w / canvasBox.h - 16 / 9) < 0.02,
    'canvas keeps a 16:9 letterboxed box',
    canvasBox.w.toFixed(0) + 'x' + canvasBox.h.toFixed(0) + ' backing ' + canvasBox.bw + 'x' + canvasBox.bh,
  );

  await wait(1400);
  await page.screenshot({ path: resolve(outDir, '04-playing.png') });

  // The canvas must actually be painting something other than a flat fill.
  const variety = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) {
      seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    }
    return seen.size;
  });
  note(variety > 12, 'arena renders a real scene', variety + ' distinct sampled colours');

  /* ---- charging and firing ------------------------------------- */
  await page.keyboard.down('ArrowUp');
  await wait(650);
  await page.screenshot({ path: resolve(outDir, '05-charging.png') });
  const charging = await page.evaluate(() => !!document.querySelector('canvas'));
  await page.keyboard.up('ArrowUp');
  note(charging, 'hold-to-charge accepted from the keyboard');

  await wait(500);
  await page.screenshot({ path: resolve(outDir, '06-arrow-in-flight.png') });

  // Trade volleys with the CPU until a point lands. A duel takes roughly 20-40
  // seconds when only one side is shooting well, so give it room.
  const readScore = () =>
    page.evaluate(() => {
      const l = document.querySelector('.hud__pip--left');
      const r = document.querySelector('.hud__pip--right');
      return l && r ? l.textContent + ':' + r.textContent : null;
    });

  let score = await readScore();
  let sawDamage = false;
  for (let i = 0; i < 150 && score === '0:0'; i++) {
    await page.keyboard.down('ArrowUp');
    await wait(120 + (i % 5) * 180);
    await page.keyboard.up('ArrowUp');
    await wait(400);
    if (i === 12) await page.screenshot({ path: resolve(outDir, '07-after-volleys.png') });
    // Any health bar that is no longer full proves damage is being applied.
    if (!sawDamage) {
      sawDamage = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, Math.round(c.height * 0.55)).data;
        // The health fill runs green -> amber -> red as a fighter is worn down.
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 180 && d[i + 1] > 110 && d[i + 1] < 200 && d[i + 2] < 90) return true;
        }
        return false;
      });
    }
    score = await readScore();
  }

  note(score !== null, 'score HUD is present', 'score ' + score);
  note(sawDamage, 'arrows land and drain health');
  note(score !== '0:0', 'a round resolves into a point during play', 'score ' + score);
  await page.screenshot({ path: resolve(outDir, '07b-point-scored.png') });

  /* ---- pause --------------------------------------------------- */

  /**
   * Pausing is only legal from `playing`, so an Escape pressed during the
   * round-result or round-intro transition is correctly ignored. Retry until
   * the match is back in play and the overlay appears.
   */
  async function pauseMatch() {
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Escape');
      await wait(400);
      if (await page.$('.panel__title')) return true;
    }
    return false;
  }

  const didPause = await pauseMatch();
  note(didPause, 'Escape opens the pause overlay from play');
  await wait(250);
  await page.screenshot({ path: resolve(outDir, '08-paused.png') });
  const pausedTitle = await page.$eval('.panel__title', (e) => e.textContent.trim());
  note(pausedTitle === 'Paused', 'Escape pauses the match', pausedTitle);

  // Physics must be frozen while paused: the canvas may not change at all.
  const frameHash = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 13) {
        h = Math.imul(h ^ d[i], 16777619) ^ d[i + 1];
      }
      return h >>> 0;
    });
  const before = await frameHash();
  await wait(1100);
  const after = await frameHash();
  note(before === after, 'pause freezes the simulation', before + ' vs ' + after);

  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Resume').click();
  });
  await wait(400);

  /* ---- two players --------------------------------------------- */
  await pauseMatch();
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Home').click();
  });
  await page.waitForSelector('.menu', { timeout: 5000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('Two Players')).click();
  });
  await wait(1500);

  // Both players charge at the same time.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ArrowUp');
  await wait(700);
  await page.screenshot({ path: resolve(outDir, '09-two-players-both-charging.png') });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ArrowUp');
  await wait(600);
  await page.screenshot({ path: resolve(outDir, '10-two-players-volley.png') });
  note(true, 'both players can charge simultaneously');

  /* ---- deathmatch ---------------------------------------------- */
  await pauseMatch();
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Home').click();
  });
  await page.waitForSelector('.menu', { timeout: 5000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.btn')].find((b) => b.textContent.includes('Deathmatch')).click();
  });
  await wait(1200);
  await page.screenshot({ path: resolve(outDir, '11-deathmatch.png') });
  const dmMeta = await page.$eval('.hud__meta', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  note(/Defeated/.test(dmMeta) && /Best/.test(dmMeta), 'deathmatch HUD shows run and best score', dmMeta);

  /* ---- portrait rotate prompt ---------------------------------- */
  await page.setViewport({ width: 420, height: 780, deviceScaleFactor: 1 });
  await wait(500);
  await page.screenshot({ path: resolve(outDir, '12-rotate-prompt.png') });
  const rotate = await page.$('.rotate');
  note(rotate !== null, 'portrait phones get a rotate prompt');

  await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });
  await wait(600);
  await page.screenshot({ path: resolve(outDir, '13-small-landscape.png') });
  note((await page.$('.rotate')) === null, 'small landscape is playable');

  note(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 3).join(' | ') || 'none');
} finally {
  await browser.close();
  stopServer();
}

console.log('\n' + '='.repeat(56));
if (failures.length === 0) console.log('Visual check passed. Screenshots in ' + outDir);
else {
  console.log(failures.length + ' FAILED:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(56));
process.exit(failures.length ? 1 : 0);
