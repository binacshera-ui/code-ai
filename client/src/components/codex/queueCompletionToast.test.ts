import assert from 'node:assert/strict';
import test from 'node:test';
import { observeQueueStatusTransitions } from './queueCompletionToast.js';

test('does not treat terminal history loaded after startup as a new completion', () => {
  const observation = observeQueueStatusTransitions({}, [
    { id: 'old-completed', status: 'completed' as const },
    { id: 'old-failed', status: 'failed' as const },
  ]);

  assert.deepEqual(observation.newTerminalItems, []);
  assert.deepEqual(observation.nextStatuses, {
    'old-completed': 'completed',
    'old-failed': 'failed',
  });
});

test('reports only a real active-to-terminal transition', () => {
  const observation = observeQueueStatusTransitions(
    { running: 'running', unchanged: 'completed' },
    [
      { id: 'running', status: 'completed' as const },
      { id: 'unchanged', status: 'completed' as const },
    ],
  );

  assert.deepEqual(observation.newTerminalItems.map((item) => item.id), ['running']);
});

test('remembered terminal items do not become new after leaving and reopening a conversation', () => {
  const first = observeQueueStatusTransitions({}, [
    { id: 'history-item', status: 'cancelled' as const },
  ]);
  const whileElsewhere = observeQueueStatusTransitions(first.nextStatuses, []);
  const reopened = observeQueueStatusTransitions(whileElsewhere.nextStatuses, [
    { id: 'history-item', status: 'cancelled' as const },
  ]);

  assert.deepEqual(reopened.newTerminalItems, []);
});

test('a retried item can produce a fresh terminal transition', () => {
  const retried = observeQueueStatusTransitions(
    { item: 'failed' },
    [{ id: 'item', status: 'queued' as const }],
  );
  const finished = observeQueueStatusTransitions(
    retried.nextStatuses,
    [{ id: 'item', status: 'completed' as const }],
  );

  assert.deepEqual(finished.newTerminalItems.map((item) => item.id), ['item']);
});
