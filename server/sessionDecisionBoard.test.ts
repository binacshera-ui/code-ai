import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionDecisionBoardService, type DecisionBoardEnqueueInput } from './sessionDecisionBoard.js';
import { DecisionBoardError, type DecisionBoard } from '../shared/decisionBoard.js';

const definition = { title: 'החלטות לתכנון', items: [
  { id: 'approve', title: 'להתחיל?', description: 'היקף מוגדר', kind: 'approval', options: [] },
  { id: 'choice', title: 'איזה מסלול?', description: '', kind: 'single', options: [{ id: 'simple', label: 'פשוט' }, { id: 'advanced', label: 'מורכב' }] },
] };
const fence = (value = definition) => 'הסבר\n```code-ai-decisions\n' + JSON.stringify(value) + '\n```';
const answer = { verdict: 'approved' as const, optionIds: [], note: 'USER_PRIVATE_UNSENT_NOTE' };
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-decision-board-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createSessionDecisionBoardService({ storageRoot: root });
  const enabled = await service.setSessionDecisionBoard('profile', 'session', { expectedRevision: 0, enabled: true });
  const board = await service.ingestSessionDecisionBoardFromText('profile', 'session', fence());
  assert.ok(board); assert.equal(enabled.revision, 1);
  return { root, service, board };
}
async function answered(service: ReturnType<typeof createSessionDecisionBoardService>, board: DecisionBoard) {
  return service.setSessionDecisionBoard('profile', 'session', { expectedRevision: board.revision,
    answers: [{ decisionId: 'approve', answer }, { decisionId: 'choice', answer: { verdict: null, optionIds: ['simple'], note: '' } }] });
}

test('answers persist without dispatch and remain absent from AI prompts until explicit submission', async t => {
  const { root, service, board } = await fixture(t);
  const saved = await answered(service, board);
  assert.equal(saved.items[0].answer?.note, answer.note); assert.equal(saved.items[0].submittedAt, null);
  const prompt = await service.buildSessionDecisionBoardPromptAdditions('profile', 'session');
  assert.equal(prompt?.includes(answer.note), false);
  assert.equal(prompt?.includes('"verdict":"approved"'), false);
  const reopened = createSessionDecisionBoardService({ storageRoot: root });
  assert.equal((await reopened.getSessionDecisionBoard('profile', 'session')).items[0].answer?.note, answer.note);
  assert.equal((await reopened.getSessionDecisionBoard('profile', 'other')).items.length, 0);
  assert.equal((await reopened.getSessionDecisionBoard('other', 'session')).items.length, 0);
  const files = await readdir(path.join(root, 'local', 'decision-boards'));
  assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
  assert.equal((await stat(path.join(root, 'local', 'decision-boards', files[0]))).mode & 0o777, 0o600);
});
test('agent definitions cannot rewrite, remove or fabricate human answers', async t => {
  const { service, board } = await fixture(t); const saved = await answered(service, board);
  const changed = await service.ingestSessionDecisionBoardFromText('profile', 'session', fence({ title: 'חדש', items: [
    { ...definition.items[0], title: 'Approve a totally different scope', kind: 'text' },
  ] }));
  assert.equal(changed?.items.length, 2);
  assert.equal(changed?.items[0].title, saved.items[0].title);
  assert.equal(changed?.items[0].kind, 'approval');
  assert.deepEqual(changed?.items[0].answer, saved.items[0].answer);
  assert.deepEqual(changed?.items.find(item => item.id === 'choice')?.answer, saved.items.find(item => item.id === 'choice')?.answer);
});
test('optimistic revision, malformed bulk payload and atomic validation preserve prior answers', async t => {
  const { service, board } = await fixture(t);
  await assert.rejects(service.setSessionDecisionBoard('profile', 'session', { expectedRevision: board.revision - 1, enabled: false }),
    error => error instanceof DecisionBoardError && error.statusCode === 409);
  for (const invalid of [null, {}, 'not-array']) await assert.rejects(service.setSessionDecisionBoard('profile', 'session',
    { expectedRevision: board.revision, answers: invalid } as any), error => error instanceof DecisionBoardError && error.statusCode === 400);
  await assert.rejects(service.setSessionDecisionBoard('profile', 'session', { expectedRevision: board.revision, answers: [
    { decisionId: 'approve', answer }, { decisionId: 'choice', answer: { verdict: null, optionIds: ['missing'], note: '' } },
  ] }));
  assert.equal((await service.getSessionDecisionBoard('profile', 'session')).items[0].answer, null);
  assert.equal((await service.getSessionDecisionBoard('profile', 'session')).revision, board.revision);
});
test('explicit concurrent submission persists pending immutable answers before one queue call', async t => {
  const { service, board } = await fixture(t); const saved = await answered(service, board);
  let resolve!: () => void; const gate = new Promise<void>(yes => { resolve = yes; });
  let didEnter!: () => void; const entered = new Promise<void>(yes => { didEnter = yes; });
  let calls = 0; let captured: DecisionBoardEnqueueInput | undefined;
  const enqueue = async (input: DecisionBoardEnqueueInput) => {
    calls++; captured = input; didEnter();
    const pending = await service.getSessionDecisionBoard('profile', 'session');
    assert.equal(pending.pendingDelivery, true); assert.equal(pending.items[0].submittedAt, null);
    await gate; return { id: 'durable-queue-id' };
  };
  const first = service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: saved.revision, requestId: 'click-one' }, enqueue);
  const second = service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: saved.revision, requestId: 'click-two' }, enqueue);
  await entered; assert.equal(calls, 1); resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.batchId, b.batchId); assert.equal(a.queueItemId, 'durable-queue-id'); assert.equal(b.duplicate, true);
  assert.equal(a.board.pendingDelivery, false); assert.ok(a.board.items[0].submittedAt);
  assert.ok(captured?.prompt.includes(answer.note)); assert.equal(captured?.sessionId, 'session');
  assert.ok((await service.buildSessionDecisionBoardPromptAdditions('profile', 'session'))?.includes(answer.note));
  const duplicate = await service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: saved.revision, requestId: 'click-one' }, enqueue);
  assert.equal(duplicate.duplicate, true); assert.equal(calls, 1);
});
test('lost acknowledgement survives service restart and retry uses identical client ID and immutable payload', async t => {
  const { root, service, board } = await fixture(t); const saved = await answered(service, board);
  const inputs: DecisionBoardEnqueueInput[] = []; const accepted = new Map<string, string>();
  const enqueue = async (input: DecisionBoardEnqueueInput) => {
    inputs.push(input); if (!accepted.has(input.clientRequestId)) {
      accepted.set(input.clientRequestId, 'durable-before-timeout'); throw new Error('Synthetic lost ACK');
    } return { id: accepted.get(input.clientRequestId)! };
  };
  await assert.rejects(service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: saved.revision }, enqueue), /lost ACK/);
  const pending = await service.getSessionDecisionBoard('profile', 'session'); assert.equal(pending.pendingDelivery, true);
  await assert.rejects(service.setSessionDecisionBoard('profile', 'session', { expectedRevision: pending.revision,
    decisionId: 'approve', answer: { ...answer, verdict: 'rejected' } }), error => error instanceof DecisionBoardError && error.statusCode === 409);
  assert.equal((await service.buildSessionDecisionBoardPromptAdditions('profile', 'session'))?.includes(answer.note), false);
  const reopened = createSessionDecisionBoardService({ storageRoot: root });
  const result = await reopened.submitSessionDecisionBoard('profile', 'session', { expectedRevision: pending.revision, requestId: 'new-browser-click' }, enqueue);
  assert.equal(result.queueItemId, 'durable-before-timeout'); assert.equal(result.duplicate, true);
  assert.equal(accepted.size, 1); assert.deepEqual(inputs[0], inputs[1]);
});
test('editing submitted answer preserves its historical batch while creating a new explicit submission', async t => {
  const { root, service, board } = await fixture(t); const saved = await answered(service, board); let calls = 0;
  const enqueue = async () => ({ id: 'queue-' + (++calls) });
  const first = await service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: saved.revision }, enqueue);
  const edited = await service.setSessionDecisionBoard('profile', 'session', { expectedRevision: first.board.revision,
    decisionId: 'approve', answer: { verdict: 'rejected', optionIds: [], note: 'New explicit answer' } });
  assert.equal(edited.items[0].submittedAt, null);
  assert.equal((await service.buildSessionDecisionBoardPromptAdditions('profile', 'session'))?.includes('New explicit answer'), false);
  const second = await service.submitSessionDecisionBoard('profile', 'session', { expectedRevision: edited.revision }, enqueue);
  assert.notEqual(first.batchId, second.batchId); assert.equal(calls, 2);
  const directory = path.join(root, 'local', 'decision-boards', 'batches');
  const owner = (await readdir(directory))[0]; const files = await readdir(path.join(directory, owner));
  assert.equal(files.length, 2);
  const batches = await Promise.all(files.map(file => readFile(path.join(directory, owner, file), 'utf8')));
  assert.ok(batches.some(bytes => bytes.includes(answer.note))); assert.ok(batches.some(bytes => bytes.includes('New explicit answer')));
});
test('draft colon and hyphen keys omit native sessionId, and durable rebinding preserves answers', async t => {
  const { service } = await fixture(t);
  for (const draft of ['draft:AUDIT', 'draft-AUDIT']) {
    const enabled = await service.setSessionDecisionBoard('profile', draft, { expectedRevision: 0, enabled: true });
    const ingested = await service.ingestSessionDecisionBoardFromText('profile', draft, fence()); assert.ok(ingested);
    const saved = await service.setSessionDecisionBoard('profile', draft, { expectedRevision: ingested.revision, decisionId: 'approve', answer });
    let received: DecisionBoardEnqueueInput | undefined;
    const sent = await service.submitSessionDecisionBoard('profile', draft, { expectedRevision: saved.revision }, async input => { received = input; return { id: 'queued-' + draft }; });
    assert.equal(received?.sessionId, undefined); assert.equal(received?.queueKey, draft);
    const canonical = 'canonical-' + draft;
    await service.rebindSessionDecisionBoard('profile', draft, canonical);
    assert.deepEqual((await service.getSessionDecisionBoard('profile', canonical)).items, sent.board.items);
    assert.deepEqual((await service.getSessionDecisionBoard('profile', draft)).items, sent.board.items);
    await service.rebindSessionDecisionBoard('profile', draft, canonical);
    assert.ok(enabled.enabled);
  }
});
test('rebind conflict preserves both existing boards instead of discarding human answers', async t => {
  const { service, board } = await fixture(t); const source = await answered(service, board);
  const destination = await service.setSessionDecisionBoard('profile', 'target', { expectedRevision: 0, enabled: true, title: 'Separate board' });
  await assert.rejects(service.rebindSessionDecisionBoard('profile', 'session', 'target'), error => error instanceof DecisionBoardError && error.statusCode === 409);
  assert.equal((await service.getSessionDecisionBoard('profile', 'session')).revision, source.revision);
  assert.equal((await service.getSessionDecisionBoard('profile', 'target')).title, destination.title);
});
