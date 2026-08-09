import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const testStorageRoot = await mkdtemp(path.join(os.tmpdir(), 'code-ai-queue-persistence-test-'));
const queueRoot = path.join(testStorageRoot, 'queue');
const stateFile = path.join(queueRoot, 'state.json');

process.env.CODEX_STORAGE_ROOT = testStorageRoot;
process.env.CODEX_QUEUE_DISABLE_EXECUTION = '1';

function queueItem(id: string, status: 'completed' | 'scheduled') {
  const now = new Date().toISOString();
  return {
    id,
    profileId: 'developer',
    sourceProfileId: null,
    queueKey: `queue-${id}`,
    clientRequestId: null,
    sessionId: `session-${id}`,
    cwd: '/tmp',
    model: null,
    reasoningEffort: null,
    permissionModeId: null,
    prompt: `prompt-${id}`,
    promptPreview: `prompt-${id}`,
    contextPrefix: null,
    sessionInstruction: null,
    actionRestriction: null,
    browserMode: null,
    personalChromeMode: null,
    designMode: null,
    uxMode: null,
    goalMode: null,
    forkContext: null,
    attachments: [],
    status,
    scheduledAt: status === 'scheduled'
      ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
      : now,
    createdAt: now,
    updatedAt: now,
    startedAt: status === 'completed' ? now : null,
    completedAt: status === 'completed' ? now : null,
    finalMessage: status === 'completed' ? `done-${id}` : null,
    error: null,
    attempts: status === 'completed' ? 1 : 0,
    scheduleMode: 'once',
    recurringFrequency: null,
    recurringTimeZone: null,
    lastRunAt: null,
    lastRunStatus: null,
    agentSessionId: null,
    agentId: null,
    agentLinkKind: null,
    priority: 0,
    stopPolicy: null,
    stopDecisionForItemId: null,
    continuationOfItemId: null,
  };
}

await mkdir(queueRoot, { recursive: true });
const firstItem = queueItem('first', 'completed');
const secondItem = queueItem('second', 'scheduled');
await writeFile(
  stateFile,
  `{"items":[${JSON.stringify(firstItem)},${JSON.stringify(secondItem)},{"id":"cut","prompt":"unterminated`,
  'utf8'
);

const queue = await import('./codexQueue.js');

after(async () => {
  await queue.shutdownCodexQueueWorker();
  await rm(testStorageRoot, { recursive: true, force: true });
});

test('recovers complete queue items from a truncated state and quarantines the source', async () => {
  const items = await queue.listCodexQueueItems('developer');
  assert.deepEqual(new Set(items.map((item) => item.id)), new Set(['first', 'second']));

  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.items.length, 2);
  assert.equal(persisted.sessionBindings['queue-first'], 'session-first');
  assert.equal(persisted.sessionBindings['session-second'], 'session-second');

  const queueFiles = await readdir(queueRoot);
  assert.equal(queueFiles.filter((name) => name.startsWith('state.json.corrupt-')).length, 1);
});

test('atomically replaces state and keeps the previous valid snapshot as a backup', async () => {
  await queue.enqueueCodexQueueItem({
    profileId: 'developer',
    queueKey: 'queue-third',
    prompt: 'third prompt',
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const primary = JSON.parse(await readFile(stateFile, 'utf8'));
  const backup = JSON.parse(await readFile(`${stateFile}.bak`, 'utf8'));
  assert.equal(primary.items.length, 3);
  assert.equal(backup.items.length, 2);

  const queueFiles = await readdir(queueRoot);
  assert.equal(queueFiles.some((name) => name.endsWith('.tmp')), false);
});
