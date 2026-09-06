import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { SessionReadReceiptStore, latestCompletionTimes } from './codexSessionReadState.js';
import { canAcknowledgeCompletion, hasUnreadCompletion } from '../client/src/components/codex/sessionUnread.js';

test('completion receipts survive reloads, isolate viewers/profiles and cannot hide newer results', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-read-receipts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'receipts.json');
  const store = new SessionReadReceiptStore(file);
  assert.equal(hasUnreadCompletion({ completedAt: 2000, startedAt: 1000 }), true);
  await Promise.all([store.markViewed('alice', 'one', 'session', 2000), store.markViewed('alice', 'one', 'session', 1000), store.markViewed('alice', 'one', 'second', 3000)]);
  const restored = new SessionReadReceiptStore(file);
  const receipts = await restored.read('alice', 'one');
  assert.equal(receipts.session, 2000);
  assert.equal(receipts.second, 3000);
  assert.equal(Object.keys(await restored.read('bob', 'one')).length, 0);
  assert.equal(Object.keys(await restored.read('alice', 'two')).length, 0);
  assert.equal(hasUnreadCompletion({ completedAt: 2000, startedAt: 1000 }, receipts.session), false);
  assert.equal(hasUnreadCompletion({ completedAt: 4000, startedAt: 3000 }, receipts.session), true);
});

test('only visible foreground results at the end of the transcript count as viewed', () => {
  const input = { visible: true, focused: true, blocked: false, atBottom: true, renderedFinalAt: 1500, completion: { completedAt: 2000, startedAt: 1000 } };
  assert.equal(canAcknowledgeCompletion(input), true);
  for (const override of [{ visible: false }, { focused: false }, { blocked: true }, { atBottom: false }, { renderedFinalAt: 500 }]) {
    assert.equal(canAcknowledgeCompletion({ ...input, ...override }), false);
  }
});

test('completion discovery retains only successful latest runs, including offline and recurring runs', () => {
  const result = latestCompletionTimes([
    { sessionId: 'one', status: 'completed', startedAt: '2026-09-06T05:00:00Z', completedAt: '2026-09-06T05:01:00Z' },
    { sessionId: 'one', status: 'completed', completedAt: '2026-09-06T04:00:00Z' },
    { sessionId: 'two', status: 'running', completedAt: null },
    { sessionId: 'three', status: 'failed', completedAt: '2026-09-06T05:01:00Z' },
    { sessionId: 'recurring', status: 'scheduled', completedAt: '2026-09-06T05:01:00Z', lastRunStatus: 'completed' },
    { sessionId: 'recurring', status: 'running', startedAt: '2026-09-06T06:00:00Z', completedAt: '2026-09-06T05:01:00Z', lastRunStatus: 'completed' },
  ]);
  assert.deepEqual(Object.keys(result).sort(), ['one', 'recurring']);
  assert.equal(result.one.completedAt, Date.parse('2026-09-06T05:01:00Z'));
  assert.equal(result.one.startedAt, Date.parse('2026-09-06T05:00:00Z'));
  assert.ok(result.recurring.startedAt <= result.recurring.completedAt);
});
