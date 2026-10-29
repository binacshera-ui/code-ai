import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQueueHistoryPage, selectQueueWorkspaceView, type QueueWorkspaceRecord } from './queueWorkspaceSelection.js';

const at = '2026-10-29T10:00:00.000Z';
function item(id: string, status = 'completed', extra: Partial<QueueWorkspaceRecord> = {}): QueueWorkspaceRecord {
  return { id, status, queueKey: `queue-${id}`, sessionId: null, createdAt: at, updatedAt: at, ...extra };
}

test('bounds all terminal kinds while retaining every active profile item and selected latest failure', () => {
  const terminals = Array.from({ length: 1000 }, (_, index) => item(String(index).padStart(4, '0'),
    ['completed', 'failed', 'cancelled'][index % 3]));
  const active = ['draft', 'scheduled', 'queued', 'running', 'cancelling'].map(status => item(status, status));
  const selectedFailure = item('selected-old', 'failed', { queueKey: 'selected', updatedAt: '2026-01-01T00:00:00Z' });
  const result = selectQueueWorkspaceView([...terminals, ...active, selectedFailure], 'selected', null,
    { recentTerminalLimit: 20, relatedTerminalLimit: 0 });
  assert.equal(result.items.length, 26);
  for (const entry of [...active, selectedFailure]) assert.ok(result.items.includes(entry));
  assert.equal(result.history.totalTerminal, 1001);
  assert.equal(result.history.returnedTerminal, 21);
  assert.equal(result.history.hasMoreTerminal, true);
  assert.equal(result.history.hasMoreRelatedTerminal, false);
});

test('retains terminal uncertain custody, pending retry, and unresolved stop decisions independent of limits', () => {
  const required = [
    item('uncertain', 'failed', { nativeSubmission: { deliveryPhase: 'detached' } }),
    item('prepared', 'cancelled', { nativeSubmission: { deliveryPhase: 'prepared' } }),
    item('retry', 'failed', { capacityRetryPendingAt: at }),
    item('decision', 'cancelled', { stopPolicy: { status: 'awaiting-decision' } }),
    item('stopping', 'cancelled', { stopPolicy: { status: 'stopping' } }),
  ];
  const result = selectQueueWorkspaceView([...required, item('ordinary', 'failed')], null, null,
    { recentTerminalLimit: 0, relatedTerminalLimit: 0 });
  assert.deepEqual(result.items.map(entry => entry.id), required.map(entry => entry.id));
});

test('related terminal cap covers aliases and retains explicit historical pagination', () => {
  const rows = Array.from({ length: 70 }, (_, index) => item(String(index).padStart(3, '0'), 'failed',
    index % 2 ? { queueKey: 'draft:alias', sessionId: 'session' } : { queueKey: 'session', sessionId: 'session' }));
  const result = selectQueueWorkspaceView(rows, 'draft:alias', 'session', { recentTerminalLimit: 0, relatedTerminalLimit: 50 });
  assert.equal(result.items.length, 50);
  assert.equal(result.history.relatedTerminal, 70);
  assert.equal(result.history.hasMoreRelatedTerminal, true);
  const history = selectQueueHistoryPage(rows, { queueKey: 'draft:alias', resolvedSessionId: 'session', limit: 100 });
  assert.equal(history.items.length, 70);
});

test('keyset pages are complete and disjoint for identical timestamps and concurrent newer insertions', () => {
  const rows = Array.from({ length: 105 }, (_, index) => item(String(index).padStart(3, '0'), index % 2 ? 'failed' : 'cancelled'));
  const first = selectQueueHistoryPage(rows, { limit: 50 });
  const withNewer = [...rows, item('new', 'completed', { updatedAt: '2026-10-29T11:00:00Z' })];
  const second = selectQueueHistoryPage(withNewer, { limit: 50, cursor: first.nextCursor });
  const third = selectQueueHistoryPage(withNewer, { limit: 50, cursor: second.nextCursor });
  const ids = [...first.items, ...second.items, ...third.items].map(row => row.id);
  assert.equal(ids.length, 105);
  assert.equal(new Set(ids).size, 105);
  assert.equal(third.nextCursor, null);
  assert.equal(first.items[0].id, '104');
  assert.equal(third.items.at(-1)?.id, '000');
});

test('history excludes all live work and rejects malformed cursors', () => {
  const rows = [item('active', 'running'), item('failed', 'failed'), item('other', 'failed')];
  assert.deepEqual(selectQueueHistoryPage(rows, { queueKey: 'queue-failed' }).items.map(row => row.id), ['failed']);
  for (const cursor of ['!', Buffer.from('{}').toString('base64url'), 'x'.repeat(2049)]) {
    assert.throws(() => selectQueueHistoryPage(rows, { cursor }), /Invalid queue history cursor/);
  }
});
