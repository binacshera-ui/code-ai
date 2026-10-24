import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const storage = await mkdtemp(path.join(os.tmpdir(), 'code-ai-drafts-test-'));
process.env.CODEX_STORAGE_ROOT = storage;
process.env.CODEX_QUEUE_DISABLE_EXECUTION = '1';
process.env.CODEX_NTFY_STATE_FILE = path.join(storage, 'notifications.json');
const old = '2020-01-01T00:00:00.000Z';
const custody = (id: string, status: string, deliveryPhase = 'detached') => ({
  id, profileId: 'developer', queueKey: `custody-${id}`, sessionId: null,
  prompt: 'Synthetic custody preservation check', attachments: [], status,
  createdAt: old, updatedAt: old, scheduledAt: old, attempts: 1,
  nativeSubmission: {
    clientUserMessageId: `code-ai:${id}`, queuedSubmissionId: null,
    turnId: null, deliveryPhase,
  },
});
await mkdir(path.join(storage, 'queue'));
await writeFile(path.join(storage, 'queue/state.json'), JSON.stringify({
  items: [{
    id: 'old-draft', profileId: 'developer', queueKey: 'draft-old', sessionId: null,
    prompt: 'שאלה ישנה שנשמרה', attachments: [], status: 'draft',
    createdAt: old, updatedAt: old, scheduledAt: old, attempts: 0,
  }, custody('uncertain-queued', 'queued'), custody('uncertain-failed', 'failed'),
  custody('uncertain-cancelled', 'cancelled'), {
    ...custody('confirmed-cancelled', 'cancelled', 'cancelled'),
    updatedAt: new Date().toISOString(),
  }], sessionBindings: {},
}));
const queue = await import('./codexQueue.js');
after(async () => {
  await queue.shutdownCodexQueueWorker();
  await rm(storage, { recursive: true, force: true });
});

test('persisted drafts survive startup and retention without becoming runnable', async () => {
  const draft = await queue.getCodexQueueItem('old-draft');
  assert.equal(draft?.status, 'draft');
  assert.equal(draft?.attempts, 0);
  assert.equal((await queue.listCodexQueueCompletionTimes('developer'))['draft-old'], undefined);
});

test('uncertain native custody survives retention and cannot be cancelled, deleted or replayed', async () => {
  for (const id of ['uncertain-queued', 'uncertain-failed', 'uncertain-cancelled']) {
    const before = await queue.getCodexQueueItem(id);
    assert.ok(before, 'Unresolved custody must survive terminal-item retention');
    await assert.rejects(queue.cancelCodexQueueItem(id), /reconciled before cancellation/);
    if (id !== 'uncertain-queued') {
      await assert.rejects(queue.deleteCodexQueueItem(id), /reconciled before deletion/);
      await assert.rejects(queue.retryCodexQueueItem(id), /יש להמתין לאימות סיום/);
    }
    assert.deepEqual(await queue.getCodexQueueItem(id), before);
  }
  const confirmed = await queue.getCodexQueueItem('confirmed-cancelled');
  const retried = await queue.retryCodexQueueItem('confirmed-cancelled');
  assert.notEqual(retried.id, 'confirmed-cancelled');
  assert.equal(retried.retryOfItemId, 'confirmed-cancelled');
  assert.equal(retried.nativeSubmission, null);
  assert.deepEqual(await queue.getCodexQueueItem('confirmed-cancelled'), confirmed);
  await queue.deleteCodexQueueItem('confirmed-cancelled');
  assert.equal(await queue.getCodexQueueItem('confirmed-cancelled'), null);
});

test('saving a question persists its attachments, deduplicates requests and never notifies', async () => {
  const input = {
    saveAsDraft: true,
    profileId: 'developer', queueKey: 'session-1', sessionId: 'session-1',
    clientRequestId: 'draft-click-1', prompt: 'שאלה להמשך\nועוד פרט',
    attachments: [{ id: 'zip', name: 'code.zip', path: '/uploads/code.zip', mimeType: 'application/zip', size: 22, isImage: false }],
  };
  const draft = await queue.enqueueCodexQueueItem(input);
  const repeated = await queue.enqueueCodexQueueItem(input);
  assert.equal(draft.id, repeated.id);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.startedAt, null);
  assert.equal(draft.completedAt, null);
  assert.equal(draft.attempts, 0);
  const listed = await queue.listCodexQueueWorkspaceItems('developer', 'session-1');
  assert.equal(listed.items.find(item => item.id === draft.id)?.prompt, input.prompt);
  assert.deepEqual(listed.items.find(item => item.id === draft.id)?.attachments, input.attachments);
  const persisted = JSON.parse(await readFile(path.join(storage, 'queue/state.json'), 'utf8'));
  assert.equal(persisted.items.find((item: { id: string }) => item.id === draft.id)?.status, 'draft');
  await assert.rejects(access(process.env.CODEX_NTFY_STATE_FILE!));
  await assert.rejects(queue.retryCodexQueueItem(draft.id), /Only failed or cancelled/);
  await assert.rejects(queue.cancelCodexQueueItem(draft.id), /Drafts are not running/);
  await queue.deleteCodexQueueItem(draft.id);
  assert.equal(await queue.getCodexQueueItem(draft.id), null);
});

test('a draft cannot accidentally carry a schedule or recurring run', async () => {
  await assert.rejects(queue.enqueueCodexQueueItem({
    saveAsDraft: true, profileId: 'developer', queueKey: 'draft-no-schedule',
    prompt: 'לא לשלוח', scheduledAt: new Date().toISOString(),
  }), /Drafts cannot be scheduled/);
  await assert.rejects(queue.enqueueCodexQueueItem({
    saveAsDraft: true, profileId: 'developer', queueKey: 'draft-empty', prompt: '',
  }), /prompt text or attachments/);
});

test('saved questions do not block sent messages in existing or new conversations', async () => {
  for (const sessionId of ['existing-session', null]) {
    const queueKey = sessionId || 'draft-new-conversation';
    const draft = await queue.enqueueCodexQueueItem({
      saveAsDraft: true, profileId: 'developer', queueKey, sessionId,
      prompt: 'שאלה שמורה להמשך',
      attachments: [{ id: 'saved', name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 12, isImage: false }],
    });
    const sent = await queue.enqueueCodexQueueItem({
      profileId: 'developer', queueKey, sessionId, prompt: 'את ההודעה הזו להריץ עכשיו',
    });
    // The saved question precedes the message and even has higher priority.
    const earlierDraft = { ...draft, scheduledAt: old, createdAt: old, priority: 100 };
    const selected = queue.selectRunnableCodexQueueItems(
      [earlierDraft, sent], 3, new Set(), new Set(),
    );
    assert.deepEqual(selected.map(item => item.id), [sent.id]);
    assert.equal((await queue.getCodexQueueItem(draft.id))?.status, 'draft');
    assert.equal((await queue.getCodexQueueItem(draft.id))?.prompt, draft.prompt);
    assert.deepEqual((await queue.getCodexQueueItem(draft.id))?.attachments, draft.attachments);
  }
});

test('bypassing drafts preserves sent-message ordering, active turns and schedules', async () => {
  const base = (await queue.listCodexQueueItems('developer')).find(item => item.status === 'queued' && !item.nativeSubmission)!;
  assert.ok(base);
  const now = Date.now();
  const item = (id: string, status: typeof base.status, offset: number, queueKey = 'ordered-session') => ({
    ...base, id, status, queueKey, sessionId: queueKey,
    priority: 0, createdAt: new Date(now + offset).toISOString(),
    scheduledAt: new Date(now + offset).toISOString(),
  });
  const draft = item('saved', 'draft', -3000);
  const first = item('first-sent', 'queued', -2000);
  const second = item('second-sent', 'queued', -1000);
  const other = item('other-sent', 'queued', -1000, 'other-session');
  const select = (items: typeof base[], activeIds = new Set<string>(), activeKeys = new Set<string>(), limit = 3) =>
    queue.selectRunnableCodexQueueItems(items, limit, activeIds, activeKeys, now).map(entry => entry.id);

  assert.deepEqual(select([draft, first, second, other]), ['first-sent', 'other-sent']);
  assert.deepEqual(select([draft, { ...first, status: 'completed' }, second]), ['second-sent']);
  for (const status of ['running', 'cancelling', 'scheduled'] as const) {
    assert.deepEqual(select([draft, { ...first, status }, second]), []);
  }
  assert.deepEqual(select([draft, item('future', 'scheduled', 60_000), second]), ['second-sent']);
  assert.deepEqual(select([draft, first], new Set([first.id])), []);
  assert.deepEqual(select([draft, first], new Set(), new Set([first.queueKey])), []);
  assert.deepEqual(select([draft, first, other], new Set(), new Set(), 1), ['first-sent']);
  assert.deepEqual(select([draft, first], new Set(), new Set(), 0), []);
});
