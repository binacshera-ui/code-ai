import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionBoard, DecisionBoardAnswer, DecisionBoardItem, DecisionBoardMutation } from '../../../../shared/decisionBoard';
import { createDecisionBoardClient, createDecisionBoardClientCache, decisionAnswer, decisionAnswerError, decisionBoardProgress, emptyDecisionAnswer, isDecisionBoardCode, toggleDecisionOption, type DecisionBoardApi } from './decisionBoardClient';

const approved = (): DecisionBoardAnswer => ({ verdict: 'approved', optionIds: [], note: '' });
const item = (kind: DecisionBoardItem['kind'] = 'approval', id = 'one'): DecisionBoardItem => ({ id, title: id, description: '', kind, options: kind === 'single' || kind === 'multiple' ? [{ id: 'a', label: 'אפשרות א' }, { id: 'b', label: 'אפשרות ב' }] : [], answer: null, answeredAt: null, submittedAt: null });
const board = (items = [item()]): DecisionBoard => ({ enabled: true, title: 'בדיקה', revision: 1, items, updatedAt: '2026-11-01T10:00:00Z' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(initial = board()) {
  let stored = initial;
  let ids = 0;
  const mutations: DecisionBoardMutation[] = [];
  const submissions: Array<{ expectedRevision: number; requestId: string }> = [];
  const api: DecisionBoardApi = {
    read: async () => ({ board: structuredClone(stored) }),
    save: async mutation => {
      assert.equal(mutation.expectedRevision, stored.revision);
      mutations.push(structuredClone(mutation));
      stored = { ...stored, enabled: mutation.enabled ?? stored.enabled, revision: stored.revision + 1,
        items: stored.items.map(item => {
          const value = mutation.answers?.find(answer => answer.decisionId === item.id);
          return value ? { ...item, answer: value.answer, answeredAt: 'now', submittedAt: null } : item;
        }) };
      return { board: structuredClone(stored) };
    },
    submit: async input => {
      submissions.push({ ...input });
      stored = { ...stored, revision: stored.revision + 1, pendingDelivery: false, items: stored.items.map(item => item.answer ? { ...item, submittedAt: 'submitted' } : item) };
      return { board: structuredClone(stored), batchId: 'batch-one', queueItemId: 'queue-one', duplicate: false };
    },
  };
  return { api, mutations, submissions, create: () => createDecisionBoardClient(api, () => `request-${++ids}`), setStored: (value: DecisionBoard) => { stored = value; } };
}

test('no approval or choice is preselected; four kinds share canonical validation', () => {
  for (const kind of ['approval', 'single', 'multiple', 'text'] as const) assert.ok(decisionAnswerError(item(kind), emptyDecisionAnswer()));
  assert.equal(decisionAnswerError(item(), approved()), null);
  assert.equal(decisionAnswerError(item('text'), { ...emptyDecisionAnswer(), note: 'תשובה' }), null);
  assert.equal(decisionAnswerError(item('single'), { ...emptyDecisionAnswer(), optionIds: ['a'] }), null);
  assert.ok(decisionAnswerError(item('single'), { ...emptyDecisionAnswer(), optionIds: ['a', 'b'] }));
  assert.ok(decisionAnswerError(item(), { ...approved(), note: 'x'.repeat(4001) }));
});

test('multiple selection is a toggle; single selection replaces; unknown IDs are ignored', () => {
  const multi = item('multiple');
  let answer = toggleDecisionOption(multi, emptyDecisionAnswer(), 'a');
  answer = toggleDecisionOption(multi, answer, 'b');
  assert.deepEqual(answer.optionIds, ['a', 'b']);
  assert.deepEqual(toggleDecisionOption(multi, answer, 'a').optionIds, ['b']);
  assert.deepEqual(toggleDecisionOption(item('single'), answer, 'b').optionIds, ['b']);
  assert.equal(toggleDecisionOption(multi, answer, 'foreign'), answer);
});

test('one bulk save persists choices without executing or sending anything', async () => {
  const h = harness(board([item(), item('text', 'two')]));
  const client = h.create();
  await client.refresh();
  client.change('one', approved());
  client.change('two', { ...emptyDecisionAnswer(), note: 'לעשות פשוט' });
  assert.equal(h.mutations.length, 0);
  assert.equal(decisionBoardProgress(client.getSnapshot().board, client.getSnapshot().drafts).dirty, 2);
  assert.equal(await client.save(), true);
  assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].answers?.length, 2);
  assert.equal(h.submissions.length, 0);
  assert.deepEqual(client.getSnapshot().drafts, {});
  assert.equal(client.getSnapshot().board?.items[0].submittedAt, null);
});

test('explicit submit saves current choices first, then submits exactly their acknowledged revision', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  assert.equal(await client.submit(), true);
  assert.equal(h.mutations.length, 1);
  assert.deepEqual(h.submissions, [{ expectedRevision: 2, requestId: 'request-1' }]);
  assert.equal(client.getSnapshot().receipt?.queueItemId, 'queue-one');
  assert.equal(client.getSnapshot().board?.items[0].submittedAt, 'submitted');
});

test('invalid drafts cannot save or execute, and restoring the saved value cancels an edit', async () => {
  const h = harness(board([item('single')])); const client = h.create(); await client.refresh();
  client.change('one', { ...emptyDecisionAnswer(), optionIds: ['missing'] });
  assert.equal(await client.submit(), false);
  assert.equal(h.mutations.length, 0); assert.equal(h.submissions.length, 0);
  client.change('one', emptyDecisionAnswer());
  assert.deepEqual(client.getSnapshot().drafts, {});
});

test('enabling the mode never saves partial draft answers or submits them', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  assert.equal(await client.setEnabled(false), true);
  assert.deepEqual(h.mutations[0], { expectedRevision: 1, enabled: false });
  assert.equal(h.submissions.length, 0); assert.deepEqual(client.getSnapshot().drafts.one, approved());
});

test('slow read preceding a save cannot overwrite the durable acknowledgement', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  const old = deferred<{ board: DecisionBoard }>(); h.api.read = () => old.promise;
  const refresh = client.refresh();
  await client.save();
  old.resolve({ board: board() }); await refresh;
  assert.equal(client.getSnapshot().board?.revision, 2);
  assert.deepEqual(client.getSnapshot().board?.items[0].answer, approved());
});

test('overlapping refreshes issue only one request', async () => {
  const h = harness(); const pending = deferred<{ board: DecisionBoard }>(); let reads = 0;
  h.api.read = () => { reads++; return pending.promise; };
  const client = h.create(); const first = client.refresh(); await client.refresh();
  assert.equal(reads, 1); pending.resolve({ board: board() }); await first;
});

test('a new local edit while saving is retained instead of cleared by the old acknowledgement', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  const saving = deferred<{ board: DecisionBoard }>(); h.api.save = () => saving.promise;
  const first = client.save(); client.change('one', { ...approved(), verdict: 'rejected' });
  saving.resolve({ board: { ...board(), revision: 2, items: [{ ...item(), answer: approved(), answeredAt: 'now' }] } });
  assert.equal(await first, true); assert.equal(client.getSnapshot().drafts.one.verdict, 'rejected');
});

test('rapid repeat save/submit is single-flight before its first await', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  const saving = deferred<{ board: DecisionBoard }>(); let writes = 0;
  h.api.save = () => { writes++; return saving.promise; };
  const first = client.save(); assert.equal(await client.save(), false); assert.equal(await client.submit(), false);
  assert.equal(writes, 1); saving.resolve({ board: board() }); await first;
});

test('lost submit acknowledgement is explicitly retried with unchanged ID and revision', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  const inputs: Array<{ expectedRevision: number; requestId: string }> = [];
  const realSubmit = h.api.submit;
  h.api.submit = async input => { inputs.push({ ...input }); if (inputs.length === 1) throw new TypeError('lost ack'); return realSubmit(input); };
  assert.equal(await client.submit(), false); assert.equal(client.getSnapshot().uncertain, true);
  client.change('one', { ...approved(), verdict: 'rejected' });
  assert.equal(client.getSnapshot().drafts.one, undefined);
  assert.equal(await client.submit(), true);
  assert.deepEqual(inputs, [{ expectedRevision: 2, requestId: 'request-1' }, { expectedRevision: 2, requestId: 'request-1' }]);
  assert.equal(h.mutations.length, 1); assert.equal(client.getSnapshot().uncertain, false);
});

test('reload pending-delivery recovery skips PUT and resumes the existing server-owned batch', async () => {
  const pendingBoard = { ...board(), revision: 7, pendingDelivery: true, items: [{ ...item(), answer: approved(), answeredAt: 'now' }] };
  const h = harness(pendingBoard); const client = h.create(); await client.refresh();
  client.change('one', { ...approved(), verdict: 'rejected' }); assert.deepEqual(client.getSnapshot().drafts, {});
  assert.equal(await client.submit(), true); assert.equal(h.mutations.length, 0);
  assert.deepEqual(h.submissions, [{ expectedRevision: 7, requestId: 'request-1' }]);
});

test('close/reopen and navigation preserve separate drafts and isolate late responses', async () => {
  const cache = createDecisionBoardClientCache(); const a = harness(); const b = harness(board([item('text')]));
  const first = cache.get('server-a/profile/session', a.api, () => 'a'); await first.refresh(); first.change('one', approved());
  const pending = deferred<{ board: DecisionBoard }>(); a.api.read = () => pending.promise; const oldRefresh = first.refresh();
  const other = cache.get('server-b/profile/session', b.api, () => 'b'); await other.refresh();
  other.change('one', { ...emptyDecisionAnswer(), note: 'draft on B' }); pending.resolve({ board: board() }); await oldRefresh;
  assert.equal(other.getSnapshot().drafts.one.note, 'draft on B');
  const reopened = cache.get('server-a/profile/session', a.api, () => 'unused');
  assert.equal(reopened, first); assert.deepEqual(reopened.getSnapshot().drafts.one, approved());
});

test('valid decision fences are summarized, malformed or unrelated code stays visible', () => {
  const definition = JSON.stringify({ title: 'החלטות', items: [{ id: 'deploy', title: 'לפרוס?', kind: 'approval' }] });
  assert.equal(isDecisionBoardCode('code-ai-decisions', definition), true);
  assert.equal(isDecisionBoardCode('json', definition), false);
  assert.equal(isDecisionBoardCode('code-ai-decisions', '{bad json}'), false);
  assert.equal(isDecisionBoardCode('code-ai-decisions', '{"items":[{"id":"x","kind":"unknown"}]}'), false);
});

test('progress differentiates valid local choices, durable answers and submitted receipts', () => {
  const value = board([item(), { ...item('text', 'two'), answer: { ...emptyDecisionAnswer(), note: 'saved' }, answeredAt: 'now', submittedAt: 'sent' }]);
  assert.deepEqual(decisionBoardProgress(value, { one: approved() }), { total: 2, answered: 2, pending: 1, dirty: 1, unsent: 0 });
  assert.deepEqual(decisionAnswer(value.items[0], {}), emptyDecisionAnswer());
});

test('same-ID changed question invalidates approval, preserves note and requires explicit review', async () => {
  const h = harness(); const client = h.create(); await client.refresh();
  client.change('one', { ...approved(), note: 'רק אחרי גיבוי' });
  h.setStored({ ...board(), revision: 2, items: [{ ...item(), title: 'למחוק במקום לפרוס?' }] });
  await client.refresh();
  assert.deepEqual(client.getSnapshot().drafts.one, { verdict: null, optionIds: [], note: 'רק אחרי גיבוי' });
  assert.match(client.getSnapshot().error!, /השאלה או האפשרויות השתנו/);
  assert.equal(await client.save(), false); assert.equal(await client.submit(), false);
  assert.equal(h.mutations.length, 0); assert.equal(h.submissions.length, 0);
  await client.refresh();
  assert.match(client.getSnapshot().error!, /יש לבחור מחדש/);
  client.change('one', { ...client.getSnapshot().drafts.one, verdict: 'rejected' });
  assert.equal(client.getSnapshot().error, null);
  assert.equal(await client.save(), true);
  assert.equal(h.mutations[0].expectedRevision, 2);
  assert.equal(h.mutations[0].answers?.[0].answer.verdict, 'rejected');
});

test('same option IDs with changed labels/description cannot inherit a dirty choice', async () => {
  for (const field of ['label', 'description'] as const) {
    const initial = board([item('single')]); const h = harness(initial); const client = h.create(); await client.refresh();
    client.change('one', { ...emptyDecisionAnswer(), optionIds: ['a'], note: 'הערה שצריכה להישאר' });
    h.setStored({ ...initial, revision: 2, items: [{ ...initial.items[0], options: [{ ...initial.items[0].options[0], [field]: 'משמעות חדשה' }, initial.items[0].options[1]] }] });
    await client.refresh();
    assert.deepEqual(client.getSnapshot().drafts.one.optionIds, []);
    assert.equal(client.getSnapshot().drafts.one.note, 'הערה שצריכה להישאר');
    assert.equal(await client.submit(), false); assert.equal(h.submissions.length, 0);
  }
});

test('changed free-text question cannot silently submit its preserved note until edited or cancelled', async () => {
  const initial = board([item('text')]); const h = harness(initial); const client = h.create(); await client.refresh();
  client.change('one', { ...emptyDecisionAnswer(), note: 'החלטה לשאלה הישנה' });
  h.setStored({ ...initial, revision: 2, items: [{ ...initial.items[0], description: 'זו עכשיו שאלה אחרת' }] });
  await client.refresh();
  assert.equal(await client.save(), false); assert.equal(h.mutations.length, 0);
  client.change('one', { ...client.getSnapshot().drafts.one, note: 'בדקתי מחדש: תשובה לשאלה החדשה' });
  assert.equal(await client.submit(), true); assert.equal(h.submissions.length, 1);
});

test('removed dirty item cannot block the board or resurrect its answer on ID reuse', async () => {
  const h = harness(); const client = h.create(); await client.refresh(); client.change('one', approved());
  h.setStored({ ...board([]), revision: 2 }); await client.refresh();
  assert.deepEqual(client.getSnapshot().drafts, {});
  h.setStored({ ...board([{ ...item(), title: 'שאלה חדשה עם אותו מזהה' }]), revision: 3 }); await client.refresh();
  assert.deepEqual(decisionAnswer(client.getSnapshot().board!.items[0], client.getSnapshot().drafts), emptyDecisionAnswer());
  assert.equal(client.getSnapshot().error, null);
});
