import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const condition = 'if (item.status === "draft" || isTerminalStatus(item.status)) {';
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Queue function missing: ' + name);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, 'Queue function end missing: ' + name);
  return source.slice(start, end).trim();
}
const now = Date.now();
function item(id, status, offset, queueKey = 'conversation') {
  return { id, status, queueKey, priority: 0,
    scheduledAt: new Date(now + offset).toISOString(), createdAt: new Date(now + offset).toISOString() };
}
let checks = 0;
for (const [variant, identity] of Object.entries(manifest.runtimes)) {
  const filename = 'runtime/' + variant + '.mjs';
  const source = await readFile(filename, 'utf8');
  assert.equal(hash(source), identity.candidateSha256);
  assert.equal(hash(source.replace(condition, 'if (isTerminalStatus(item.status)) {')), identity.baselineSha256);
  execFileSync(process.execPath, ['--check', filename], { stdio: 'pipe' });
  const blocker = extract(source, 'hasBlockingPreviousItem');
  const stateName = blocker.match(/return (state\d*)\.items\.some/)[1];
  const functions = ['isTerminalStatus', 'compareQueueExecutionOrder', 'hasBlockingPreviousItem', 'pickRunnableItems']
    .map(name => extract(source, name)).join('\n');
  function select(items, activeIds = [], activeKeys = [], limit = 4, legacy = false) {
    const context = vm.createContext({
      [stateName]: { items }, activeWorkerItemIds: new Set(activeIds), activeWorkerQueueKeys: new Set(activeKeys),
    });
    const code = legacy ? functions.replace(condition, 'if (isTerminalStatus(item.status)) {') : functions;
    vm.runInContext(code + ';result = pickRunnableItems(' + limit + ').map(item => item.id);', context);
    return Array.from(context.result);
  }
  const draft = item('draft', 'draft', -4000);
  const first = item('first', 'queued', -3000);
  const second = item('second', 'queued', -2000);
  const other = item('other', 'queued', -1000, 'other-conversation');
  assert.deepEqual(select([draft, first], [], [], 4, true), [], 'Original defect must reproduce'); checks++;
  assert.deepEqual(select([draft, first]), ['first']); checks++;
  assert.equal(draft.status, 'draft'); checks++;
  assert.deepEqual(select([{ ...draft, priority: 100 }, first, second, other]), ['first', 'other']); checks++;
  assert.deepEqual(select([draft, { ...first, status: 'completed' }, second]), ['second']); checks++;
  for (const status of ['queued', 'running', 'cancelling', 'scheduled']) {
    const selected = select([draft, { ...first, status }, second]);
    assert.deepEqual(selected, status === 'queued' ? ['first'] : []); checks++;
  }
  assert.deepEqual(select([draft, item('future', 'scheduled', 60_000), first]), ['first']); checks++;
  assert.deepEqual(select([draft, first], ['first']), []); checks++;
  assert.deepEqual(select([draft, first], [], ['conversation']), []); checks++;
  assert.deepEqual(select([draft, first, other], [], [], 1), ['first']); checks++;
  assert.deepEqual(select([draft, first], [], [], 0), []); checks++;
}
console.log(JSON.stringify({ ok: true, runtimeVariants: Object.keys(manifest.runtimes).length,
  checks, originalDefectReproduced: true, changesOutsideDraftCondition: false, productionEffects: false }));
