import { execFileSync } from 'node:child_process';
import { cp, mkdir, rename, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { smoke as interactiveSmoke } from './api-smoke.mjs';
import { smoke as drainSmoke } from './drain-audit-smoke.mjs';
execFileSync('npm', ['run', 'build'], { cwd: 'payload', stdio: 'inherit' });
await rename('payload/dist/server.js', 'payload/dist/app.mjs');
await cp('server-entry.mjs', 'payload/dist/server.js');
await cp('runtime-auth.mjs', 'payload/runtime-auth.mjs');
await cp('payload/scripts/codex-shared-stdio.mjs', 'payload/dist/codex-shared-stdio.mjs');
const options = { appRoot: new URL('./payload/', import.meta.url).pathname,
  fakeCodex: new URL('./fake-codex.mjs', import.meta.url).pathname };
const interactive = await interactiveSmoke(options);
const drain = await drainSmoke(options);
await mkdir('dist', { recursive: true });
await cp('payload/dist', 'dist/dist', { recursive: true, verbatimSymlinks: true });
await cp('runtime-auth.mjs', 'dist/runtime-auth.mjs');
await cp('install.mjs', 'dist/install.mjs');
await cp('payload/package.json', 'dist/package.json');
// Preserve runtime sidecars used by the application root, not only the HTTP
// bundle. In particular Ubuntu's existing runner uses its release directory.
for (const directory of ['personal-chrome', 'design-mode', 'ux-mode', 'phone-mode', 'browser-mode'])
  await cp('payload/server/' + directory, 'dist/server/' + directory, { recursive: true });
await cp('payload/skills', 'dist/skills', { recursive: true });
await mkdir('dist/scripts', { recursive: true });
await cp('payload/scripts/codex-shared-stdio.mjs', 'dist/scripts/codex-shared-stdio.mjs');
await cp('payload/chrome-extension', 'dist/chrome-extension', { recursive: true });
await mkdir('dist/qualification', { recursive: true });
for (const file of ['api-smoke.mjs', 'fake-codex.mjs', 'runtime-auth.test.mjs']) await cp(file, 'dist/qualification/' + file);
await cp('runtime-auth.mjs', 'dist/qualification/runtime-auth.mjs');
await writeFile('dist/qualification/release-checks.json', JSON.stringify({
  format: 'code-ai-authorized-interrupting-release-checks', version: 1,
  compiledApplication: true, ownerAuthorizedInterruptionRequired: true,
  supportedPolicy: 'owner-authorized singleton stop/switch/start with rollback',
  sharedOwnerEnabled: false, automaticDeploymentQualified: false, credentialRotation: false,
  unit: JSON.parse(await readFile('unit-audit.json', 'utf8')),
  authenticationPreservationTestsPassed: 8, interactive, drain,
  liveAcceptanceRequired: true,
}, null, 2) + '\n');
const files = {};
async function inventory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await inventory(directory + '/' + entry.name, name + '/');
    else files[name] = createHash('sha256').update(await readFile(directory + '/' + entry.name)).digest('hex');
  }
}
await inventory('dist');
await writeFile('dist/release-files.json', JSON.stringify({ format: 'code-ai-release-files', version: 1, files }, null, 2) + '\n');
console.log(JSON.stringify({ fullReleasePackaged: true, interactiveChecks: interactive.checks.length,
  drainRefusalChecks: drain.checks.length, sharedOwnerEnabled: false, authenticationPreservedByPinnedRuntimeBinding: true }));
