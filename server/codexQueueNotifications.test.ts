import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  cancelCodexQueueItem,
  enqueueCodexQueueItem,
} from './codexQueue.js';
import { resetCodexFinalNotificationRuntimeForTests } from './codexFinalNotifications.js';

test('cancelling a queued conversation creates a durable stopped notification', async () => {
  const storageRoot = process.env.CODEX_STORAGE_ROOT;
  assert.ok(storageRoot, 'CODEX_STORAGE_ROOT must be set by the test script');
  const notificationStateFile = path.join(storageRoot, 'queue-notifications.json');
  process.env.CODEX_NTFY_STATE_FILE = notificationStateFile;
  process.env.CODEX_NTFY_URL = 'https://ntfy.test/code-ai-test';
  process.env.CODEX_NTFY_ENABLED = 'true';
  process.env.CODEX_NTFY_DEFAULT_ENABLED = 'true';
  process.env.CODEX_SERVER_ID = 'beam-10g';
  process.env.CODEX_SERVER_LABEL = 'BEAM 10G';
  resetCodexFinalNotificationRuntimeForTests();

  const item = await enqueueCodexQueueItem({
    profileId: 'developer',
    queueKey: 'draft:cancelled-conversation',
    prompt: 'Run a long task',
    promptPreview: 'Long task',
  });
  await cancelCodexQueueItem(item.id);

  const persisted = JSON.parse(await fs.readFile(notificationStateFile, 'utf8')) as {
    deliveriesById: Record<string, {
      outcome: string;
      serverId: string;
      sessionId: string;
      finalMessage: string;
      status: string;
    }>;
  };
  const deliveries = Object.values(persisted.deliveriesById);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.outcome, 'cancelled');
  assert.equal(deliveries[0]?.serverId, 'beam-10g');
  assert.equal(deliveries[0]?.sessionId, 'draft:cancelled-conversation');
  assert.equal(deliveries[0]?.status, 'pending');
  assert.match(deliveries[0]?.finalMessage || '', /המשך במשימה/u);
});
