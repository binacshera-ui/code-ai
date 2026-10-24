#!/usr/bin/env node
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['personal-chrome', 'browser-mode', 'phone-mode', 'design-mode',
  'ux-mode', 'codex-shared-modes'];
await mkdir(path.join(appRoot, 'dist'), { recursive: true });
for (const directory of directories) {
  await cp(path.join(appRoot, 'server', directory), path.join(appRoot, 'dist', directory),
    { recursive: true, force: true });
}
// Keep runtime siblings and their relative imports together, including the
// canonical broker. Tests are source inputs, not shipped runtime programs.
for (const entry of await readdir(path.join(appRoot, 'server'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
    await cp(path.join(appRoot, 'server', entry.name), path.join(appRoot, 'dist', entry.name));
  }
}
// The adapter imports source helpers through ../server. Bundle those helpers
// so its installed execution does not depend on a checkout beside dist.
await build({ absWorkingDir: appRoot, entryPoints: ['scripts/codex-shared-stdio.mjs'],
  outfile: path.join(appRoot, 'dist/codex-shared-stdio.mjs'), bundle: true,
  platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' });
await import('./verify-runtime-programs.mjs');
