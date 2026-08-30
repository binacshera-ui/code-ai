import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectCodexQueueWorkspaceItems,
  type CodexQueueItem,
  type CodexQueueItemStatus,
} from './codexQueue.js';

function createQueueItem(
  id: string,
  status: CodexQueueItemStatus,
  updatedAt: string,
  queueKey = `queue-${id}`,
  sessionId: string | null = null
): CodexQueueItem {
  return {
    id,
    profileId: 'developer',
    sourceProfileId: null,
    queueKey,
    clientRequestId: null,
    sessionId,
    cwd: '/tmp/workspace',
    model: null,
    reasoningEffort: null,
    permissionModeId: null,
    prompt: `prompt-${id}`,
    promptPreview: `preview-${id}`,
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
    scheduledAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
    startedAt: null,
    completedAt: status === 'completed' ? updatedAt : null,
    finalMessage: null,
    error: status === 'failed' ? 'failed' : null,
    attempts: 0,
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

test('workspace queue list retains actionable items and bounds completed history', () => {
  const items = [
    createQueueItem('running', 'running', '2026-08-30T10:00:00.000Z'),
    createQueueItem('failed', 'failed', '2026-08-30T09:00:00.000Z'),
    createQueueItem('cancelled', 'cancelled', '2026-08-30T08:00:00.000Z'),
    createQueueItem('completed-new', 'completed', '2026-08-30T07:00:00.000Z'),
    createQueueItem('completed-middle', 'completed', '2026-08-30T06:00:00.000Z'),
    createQueueItem('completed-related', 'completed', '2026-08-30T05:00:00.000Z', 'draft-1', 'session-1'),
    createQueueItem('completed-old', 'completed', '2026-08-30T04:00:00.000Z'),
  ];

  const selected = selectCodexQueueWorkspaceItems(items, 'session-1', 'session-1', {
    recentCompletedLimit: 2,
    relatedCompletedLimit: 1,
  });

  assert.deepEqual(
    new Set(selected.map((item) => item.id)),
    new Set([
      'running',
      'failed',
      'cancelled',
      'completed-new',
      'completed-middle',
      'completed-related',
    ])
  );
});

test('workspace queue list does not add unrelated old completed items', () => {
  const items = [
    createQueueItem('completed-current', 'completed', '2026-08-30T07:00:00.000Z'),
    createQueueItem('completed-old', 'completed', '2026-08-30T06:00:00.000Z'),
  ];

  const selected = selectCodexQueueWorkspaceItems(items, 'session-missing', 'session-missing', {
    recentCompletedLimit: 1,
    relatedCompletedLimit: 5,
  });

  assert.deepEqual(selected.map((item) => item.id), ['completed-current']);
});
