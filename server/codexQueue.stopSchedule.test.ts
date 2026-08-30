import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test, { after } from 'node:test';

import {
  clearCodexQueueItemStopSchedule,
  enqueueCodexQueueItem,
  getCodexQueueItem,
  listCodexQueueItems,
  setCodexQueueItemStopSchedule,
} from './codexQueue.js';

const testStorageRoot = process.env.CODEX_STORAGE_ROOT || '';

after(async () => {
  if (testStorageRoot.includes('code-ai-queue-stop-test-')) {
    await rm(testStorageRoot, { recursive: true, force: true });
  }
});

async function waitForItem(
  itemId: string,
  predicate: (item: NonNullable<Awaited<ReturnType<typeof getCodexQueueItem>>>) => boolean,
  timeoutMs = 3_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await getCodexQueueItem(itemId);
    if (item && predicate(item)) {
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for queue item ${itemId}`);
}

async function enqueueWaitingItem(queueKey: string) {
  return enqueueCodexQueueItem({
    profileId: 'developer',
    queueKey,
    prompt: `test prompt for ${queueKey}`,
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

test('hard stop cancels a waiting item at the persisted deadline', async () => {
  const item = await enqueueWaitingItem('hard-stop-queue');
  const armed = await setCodexQueueItemStopSchedule(item.id, {
    stopAt: new Date(Date.now() + 80).toISOString(),
    mode: 'hard',
  });
  assert.equal(armed.stopPolicy?.status, 'armed');

  const stopped = await waitForItem(item.id, (candidate) => candidate.stopPolicy?.status === 'stopped');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.stopPolicy?.outcome, 'hard-stopped');
  assert.equal(stopped.stopPolicy?.decision, false);
});

test('conditional stop creates one prioritized decision item and preserves a multiline question', async () => {
  const item = await enqueueWaitingItem('conditional-stop-queue');
  const question = 'האם הבדיקה הראשונה עברה?\nהמשך רק אם נותרה עבודה מהותית.';
  await setCodexQueueItemStopSchedule(item.id, {
    stopAt: new Date(Date.now() + 80).toISOString(),
    mode: 'conditional',
    question,
  });

  const stopped = await waitForItem(item.id, (candidate) => candidate.stopPolicy?.status === 'awaiting-decision');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.stopPolicy?.question, question);

  const items = await listCodexQueueItems('developer');
  const decisions = items.filter((candidate) => candidate.stopDecisionForItemId === item.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].priority, 100);
  assert.match(decisions[0].prompt, /\{"continue": true\}/);
  assert.match(decisions[0].prompt, /המשך רק אם נותרה עבודה מהותית/);

  await listCodexQueueItems('developer');
  const afterSecondRefresh = await listCodexQueueItems('developer');
  assert.equal(afterSecondRefresh.filter((candidate) => candidate.stopDecisionForItemId === item.id).length, 1);
});

test('an armed schedule can be edited and cleared before it triggers', async () => {
  const item = await enqueueWaitingItem('clear-stop-queue');
  await setCodexQueueItemStopSchedule(item.id, {
    stopAt: new Date(Date.now() + 20_000).toISOString(),
    mode: 'conditional',
    question: 'להמשיך?',
  });
  const cleared = await clearCodexQueueItemStopSchedule(item.id);
  assert.equal(cleared.stopPolicy, null);
  assert.equal(cleared.status, 'scheduled');
});
