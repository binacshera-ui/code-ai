import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceMovePlan } from './workspaceMoveSelection.js';

const sessions = [
  { id: 'session-a1', cwd: '/source/a', topic: { id: 'topic-a', cwd: '/source/a' } },
  { id: 'session-a2', cwd: '/source/a', topic: { id: 'topic-a', cwd: '/source/a' } },
  { id: 'session-b', cwd: '/source/b', topic: null },
  { id: 'already-there', cwd: '/target', topic: null },
];

test('deduplicates sessions covered by a successfully moved topic', () => {
  const plan = buildWorkspaceMovePlan({
    sessions,
    selectedSessionIds: ['session-a1', 'session-a1', 'session-b', 'already-there'],
    selectedTopicIds: ['topic-a', 'topic-a'],
    successfullyMovedTopicIds: ['topic-a'],
    targetCwd: '/target',
  });

  assert.deepEqual(plan.topicIds, ['topic-a']);
  assert.deepEqual(plan.sessionIds, ['session-b']);
});

test('keeps explicitly selected sessions as fallback when their topic move failed', () => {
  const plan = buildWorkspaceMovePlan({
    sessions,
    selectedSessionIds: ['session-a1', 'session-b'],
    selectedTopicIds: ['topic-a'],
    successfullyMovedTopicIds: [],
    targetCwd: '/target',
  });

  assert.deepEqual(plan.sessionIds, ['session-a1', 'session-b']);
});
