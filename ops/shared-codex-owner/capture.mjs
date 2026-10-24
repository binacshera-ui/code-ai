import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = '/root/projects/code-ai';
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/shared-codex-owner-source-');
for (const file of ['package.json', 'pnpm-lock.yaml', 'test.mjs', 'build.mjs'])
  await cp(path.join(root, 'ops/shared-codex-owner', file), path.join(stage, file));
const files = [
  'package.json', 'package-lock.json',
  'server/codexAppServer.ts', 'server/codexAppServer.test.ts',
  'server/codexUserInput.ts', 'server/codexUserInput.test.ts',
  'server/providerProcessLifecycle.ts', 'server/providerProcessLifecycle.test.ts',
  'shared/codexUserInput.ts',
  'scripts/codex-shared-stdio.mjs', 'scripts/codex-shared-stdio.test.mjs',
];
const hashes = {};
for (const file of files) {
  await mkdir(path.dirname(path.join(stage, 'payload', file)), { recursive: true });
  const contents = await readFile(path.join(root, file));
  await writeFile(path.join(stage, 'payload', file), contents);
  hashes[file] = createHash('sha256').update(contents).digest('hex');
}
const identity = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
  format: 'code-ai-shared-codex-owner-qualification', version: 1, identity, hashes,
  installedEffects: false, productionReady: false,
  gates: ['All native clients must join the same owner', 'Active-turn and subagent queue arbitration is not qualified',
    'Mode-specific config homes must be mapped without cross-client configuration leakage',
    'Existing exec-based installed runtimes are not migrated by this transport-only artifact',
    'No live GUI process handoff or Windows transport has been proven'],
}, null, 2) + '\n');
console.log(JSON.stringify({ stage, identity, capturedPaths: files.length, installedEffects: false }));
