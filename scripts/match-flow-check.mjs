/**
 * Long-running end-to-end checks that a whole match plays out correctly in the
 * browser: a standard match must run to five points and show the victory
 * screen, and a deathmatch run must end in defeat and persist the best score.
 *
 * The human player deliberately stays idle so the CPU wins, which also proves
 * the round loop keeps generating new rounds on its own.
 *
 *   node scripts/match-flow-check.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);

await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('preview server did not start')), 30000);
  server.stdout.on('data', (c) => {
    if (c.toString().includes(String(freePort))) {
      clearTimeout(timer);
      setTimeout(res, 500);
    }
  });
});

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

const failures = [];
const note = (ok, label, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures.push(label + (detail ? ' — ' + detail : ''));
};

const clickBtn = (page, text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('.btn')].find((x) => x.textContent.includes(t));
    if (b) b.click();
    return !!b;
  }, text);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:' + freePort + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.menu', { timeout: 15000 });

  /* ---- a standard match must run all the way to five points ------ */
  console.log('\nStandard match (idle player, CPU should reach 5):');
  await clickBtn(page, 'One Player');
  await page.waitForSelector('canvas', { timeout: 5000 });

  const scoreHistory = [];
  let result = null;
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(1500);
    const state = await page.evaluate(() => {
      const title = document.querySelector('.panel__title');
      const l = document.querySelector('.hud__pip--left');
      const r = document.querySelector('.hud__pip--right');
      return {
        title: title ? title.textContent.trim() : null,
        score: l && r ? l.textContent + ':' + r.textContent : null,
        panelScore: document.querySelector('.panel__score')?.textContent.trim() ?? null,
      };
    });
    if (state.score && scoreHistory.at(-1) !== state.score) scoreHistory.push(state.score);
    if (state.title === 'Victory' || state.title === 'Defeated') {
      result = state;
      break;
    }
  }

  note(result !== null, 'a standard match reaches a result screen', result ? result.title : 'timed out');
  if (result) {
    const [l, r] = result.panelScore.split(':').map((n) => Number(n.trim()));
    note(
      Math.max(l, r) === 5,
      'the match ends exactly at five points',
      'final ' + result.panelScore,
    );
    note(
      scoreHistory.length >= 5,
      'every round was played out in sequence',
      scoreHistory.join(' -> '),
    );
    await page.screenshot({ path: resolve(root, 'shots/14-match-result.png') });
  }

  /* ---- rematch must start a clean match -------------------------- */
  await clickBtn(page, 'Rematch');
  await wait(2500);
  const afterRematch = await page.evaluate(() => {
    const l = document.querySelector('.hud__pip--left');
    const r = document.querySelector('.hud__pip--right');
    return l && r ? l.textContent + ':' + r.textContent : null;
  });
  note(afterRematch === '0:0', 'rematch resets the score', 'score ' + afterRematch);

  /* ---- deathmatch defeat + best-score persistence ---------------- */
  console.log('\nDeathmatch (idle player, run should end in defeat):');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.hud__pause')][0];
    if (b) b.click();
  });
  await wait(600);
  await clickBtn(page, 'Home');
  await page.waitForSelector('.menu', { timeout: 8000 });
  await clickBtn(page, 'Deathmatch');
  await page.waitForSelector('canvas', { timeout: 5000 });

  let dmResult = null;
  const dmDeadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < dmDeadline) {
    await wait(1500);
    const title = await page.evaluate(() => {
      const t = document.querySelector('.panel__title');
      return t ? t.textContent.trim() : null;
    });
    if (title === 'Run Over') {
      dmResult = await page.evaluate(() => ({
        score: document.querySelector('.panel__score')?.textContent.trim() ?? null,
        stored: localStorage.getItem('drunkenArchers.stats.v1'),
      }));
      break;
    }
  }

  note(dmResult !== null, 'a deathmatch run ends in defeat', dmResult ? 'score ' + dmResult.score : 'timed out');
  if (dmResult) {
    note(dmResult.stored !== null, 'deathmatch stats persist to localStorage', dmResult.stored ?? 'nothing stored');
    await page.screenshot({ path: resolve(root, 'shots/15-deathmatch-result.png') });
  }

  /* ---- settings persistence -------------------------------------- */
  await clickBtn(page, 'Home');
  await page.waitForSelector('.menu', { timeout: 8000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.toggle')].find((t) => t.textContent.includes('Music')).click();
  });
  await wait(200);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.menu', { timeout: 15000 });
  const musicOff = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.toggle')].find((x) => x.textContent.includes('Music'));
    return t?.dataset.on;
  });
  note(musicOff === 'false', 'settings survive a reload', 'music toggle = ' + musicOff);

  note(errors.length === 0, 'no uncaught page errors', errors.slice(0, 2).join(' | ') || 'none');
} finally {
  await browser.close();
  stopServer();
}

console.log('\n' + '='.repeat(56));
if (failures.length === 0) console.log('Match-flow check passed.');
else {
  console.log(failures.length + ' FAILED:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(56));
process.exit(failures.length ? 1 : 0);
