/**
 * Bundles the TypeScript simulation smoke test with esbuild and runs it under
 * Node. Keeps `npm run sim-check` a single command with no extra dev deps.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'node_modules/.tmp/sim-check.cjs');
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, 'scripts/sim-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile,
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
