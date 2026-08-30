import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectPendingDraftConversations,
  type PendingDraftQueueItem,
} from './pendingDraftConversations.js';

function queueItem(overrides: Partial<PendingDraftQueueItem> = {}): PendingDraftQueueItem {
  return {
    id: 'item-1',
    queueKey: 'draft-one',
    sessionId: null,
    cwd: '/workspace/project',
    prompt: 'Investigate the missing conversation',
    promptPreview: 'Investigate the missing conversation',
    status: 'running',
    scheduledAt: '2026-08-13T12:00:00.000Z',
    createdAt: '2026-08-13T12:00:00.000Z',
    updatedAt: '2026-08-13T12:00:00.000Z',
    ...overrides,
  };
}

test('keeps one newest visible placeholder per general draft', () => {
  const older = queueItem({ id: 'older', status: 'failed' });
  const newer = queueItem({
    id: 'newer',
    status: 'queued',
    updatedAt: '2026-08-13T12:05:00.000Z',
  });
  const forkDraft = queueItem({ id: 'fork', queueKey: 'draft:fork-session' });

  assert.deepEqual(
    selectPendingDraftConversations([older, newer, forkDraft], new Set()).map((item) => item.id),
    ['newer']
  );
});

test('removes a placeholder once its real provider session is catalogued', () => {
  const bound = queueItem({ sessionId: 'session-1' });
  assert.deepEqual(
    selectPendingDraftConversations([bound], new Set(['session-1'])),
    []
  );
});

test('keeps pre-session failures discoverable and applies sidebar search', () => {
  const failed = queueItem({ status: 'failed', promptPreview: 'Google profile check' });
  assert.deepEqual(
    selectPendingDraftConversations([failed], new Set(), 'google').map((item) => item.id),
    ['item-1']
  );
  assert.deepEqual(selectPendingDraftConversations([failed], new Set(), 'unrelated'), []);
});
