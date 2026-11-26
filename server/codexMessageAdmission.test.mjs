import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAppendLiveMessage, withCodexMessageAdmission } from './codexMessageAdmission.mjs';

test('only an ordinary unscheduled message to an existing Codex session can append', () => {
  const request = { route: '/messages', sessionId: 'thread-1', draft: false, provider: 'codex' };
  assert.equal(shouldAppendLiveMessage(request), true);
  for (const patch of [
    { route: '/queue/items' }, { route: '/queue/drafts' }, { draft: true },
    { sessionId: undefined }, { sessionId: '' }, { sessionId: 'draft-1' },
    { provider: 'gemini' }, { provider: 'claude' },
    { scheduledAt: '2000-01-01T00:00:00Z' }, { scheduledAt: '2099-01-01T00:00:00Z' },
    { recurrence: { frequency: 'daily' } },
  ]) assert.equal(shouldAppendLiveMessage({ ...request, ...patch }), false, JSON.stringify(patch));
});

test('duplicate HTTP admissions wait for one another without serializing other messages', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const first = withCodexMessageAdmission('profile', 'request', async () => {
    calls.push('first-start'); await gate; calls.push('first-end');
  });
  const duplicate = withCodexMessageAdmission('profile', 'request', async () => { calls.push('duplicate'); });
  await withCodexMessageAdmission('profile', 'other-request', async () => { calls.push('other'); });
  await withCodexMessageAdmission('other-profile', 'request', async () => { calls.push('other-profile'); });
  assert.deepEqual(calls, ['first-start', 'other', 'other-profile']);
  release(); await Promise.all([first, duplicate]);
  assert.deepEqual(calls, ['first-start', 'other', 'other-profile', 'first-end', 'duplicate']);
});

test('failed admission does not poison the same request or leave an execution job', async () => {
  await assert.rejects(withCodexMessageAdmission('profile', 'failed', () => { throw new Error('fixture'); }), /fixture/);
  assert.equal(await withCodexMessageAdmission('profile', 'failed', () => 'retried'), 'retried');
});
