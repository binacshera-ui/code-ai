#!/usr/bin/env node
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Shared mode startup resolves every catalog, even when only one mode is enabled.
// Ship the complete runtime so a dist-only install has the same programs as source.
const directories = ['personal-chrome', 'browser-mode', 'phone-mode', 'design-mode',
  'ux-mode', 'codex-shared-modes'];
await mkdir(path.join(appRoot, 'dist'), { recursive: true });
for (const directory of directories) {
  await cp(path.join(appRoot, 'server', directory), path.join(appRoot, 'dist', directory),
    { recursive: true, force: true });
}
for (const filename of ['codexSharedAccountAuth.mjs', 'codexSharedSocket.mjs','codexRuntimePrograms.mjs']) {
  await cp(path.join(appRoot, 'server', filename), path.join(appRoot, 'dist', filename), { force: true });
}
