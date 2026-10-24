import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = '/root/projects/code-ai';
const stage = await mkdtemp('/mnt/hdd/code-ai-builds/draft-unblock-source-');
const hash = value => createHash('sha256').update(value).digest('hex');
const baselines = {
  main: { file: root + '/dist/server.js', sha256: '240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7' },
  ubuntu: {
    file: '/mnt/hdd/code-ai-builds/ubuntu-gpu-lab-session-duplicate-20261009-v2/dist/server.js',
    sha256: '404457832dfc997adef4b42fdf959ab4c9105e906e06f50339ee9d00db8dc3a6',
  },
};
for (const file of ['package.json', 'pnpm-lock.yaml', 'test.mjs', 'build.mjs']) {
  await cp(path.join(root, 'ops/draft-unblock-release', file), path.join(stage, file));
}
await mkdir(stage + '/runtime');
const runtimes = {};
for (const [variant, baseline] of Object.entries(baselines)) {
  const before = await readFile(baseline.file, 'utf8');
  assert.equal(hash(before), baseline.sha256, 'Installed baseline changed: ' + variant);
  const start = before.indexOf('function hasBlockingPreviousItem(candidate) {');
  const end = before.indexOf('\nfunction applyRecurringResult(', start);
  assert.ok(start > 0 && end > start, 'Queue function boundary missing: ' + variant);
  const prior = before.slice(start, end);
  const oldCondition = 'if (isTerminalStatus(item.status)) {';
  const condition = 'if (item.status === "draft" || isTerminalStatus(item.status)) {';
  assert.equal(prior.split(oldCondition).length, 2, 'Expected blocker condition missing: ' + variant);
  const after = before.slice(0, start) + prior.replace(oldCondition, condition) + before.slice(end);
  assert.equal(hash(after.replace(condition, oldCondition)), baseline.sha256, 'Changes outside blocker condition');
  await writeFile(stage + '/runtime/' + variant + '.mjs', after, { mode: 0o600 });
  runtimes[variant] = { baselineSha256: baseline.sha256, candidateSha256: hash(after) };
}
await mkdir(stage + '/source');
for (const file of ['server/codexQueue.ts', 'server/codexQueue.drafts.test.ts']) {
  await cp(path.join(root, file), path.join(stage, 'source', path.basename(file)));
}
await writeFile(stage + '/manifest.json', JSON.stringify({
  format: 'code-ai-draft-unblock-release', version: 1,
  change: 'Saved drafts do not block execution of sent messages in the same conversation.',
  runtimes,
  changedSourcePaths: ['server/codexQueue.ts', 'server/codexQueue.drafts.test.ts'],
  persistentStateChanges: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ stage, variants: Object.keys(runtimes), runtimeChangesPerVariant: 1 }));
