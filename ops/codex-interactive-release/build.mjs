import { execFileSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { smoke } from './api-smoke.mjs';
execFileSync('npm', ['run', 'build'], { cwd: 'payload', stdio: 'inherit' });
const checks = await smoke({ appRoot: new URL('./payload/', import.meta.url).pathname,
  fakeCodex: new URL('./fake-codex.mjs', import.meta.url).pathname });
await mkdir('dist', { recursive: true });
await cp('payload/dist', 'dist', { recursive: true, verbatimSymlinks: true });
await mkdir('dist/qualification', { recursive: true });
await writeFile('dist/qualification/checks.json', JSON.stringify({ ...checks, productionEffects: false }) + '\n');
for (const file of ['fake-codex.mjs', 'api-smoke.mjs']) await cp(file, 'dist/qualification/' + file);
console.log(JSON.stringify({ integratedSmoke: true, ...checks, productionEffects: false }));
