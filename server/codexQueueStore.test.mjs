import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createCodexQueueStore, readRecoveredQueueItems, readCodexQueueStoreSnapshot,
  closeCodexQueueStoreReaders,
} from './codexQueueStore.mjs';
import { createQueueStateTracker } from './codexQueueStoreTracking.mjs';

const roots = [];
test.after(async () => {
  await closeCodexQueueStoreReaders();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-queue-store-test-'));
  roots.push(root); return root;
}
function item(id, extra = {}) {
  return { id, profileId: 'developer', queueKey: `draft:${id}`, sessionId: `session:${id}`,
    prompt: `original ${id}`, status: 'failed', createdAt: '2026-10-29T08:00:00.000Z',
    nativeSubmission: { clientUserMessageId: `code-ai:${id}`, deliveryPhase: 'unknown' }, ...extra };
}
const emptyChanges = () => ({ upserts: [], deletedIds: [], bindingUpserts: {}, bindingDeletes: [] });

test('absent SQLite yields null without creating a writer or database', async () => {
  const root = await fixture();
  assert.equal(await readRecoveredQueueItems({ queueRoot: root, profileId: 'developer' }), null);
  assert.equal(await readCodexQueueStoreSnapshot({ queueRoot: root }), null);
});

test('atomic migration preserves originals, every field, stable bindings, projections and order', async () => {
  const root = await fixture(); const file = path.join(root, 'state.json');
  const original = { items: [item('one', { forkContext: { data: 'x'.repeat(100_000) } }), item('two', { profileId: 'developer2' })],
    sessionBindings: { 'draft:one': 'session:one', 'draft:two': 'session:two' } };
  const bytes = JSON.stringify(original, null, 2); await writeFile(file, bytes);
  const store = createCodexQueueStore({ queueRoot: root });
  try {
    assert.equal(await store.loadState(), null);
    await assert.rejects(readRecoveredQueueItems({ queueRoot: root, profileId: 'developer' }), /migration is not complete/);
    assert.deepEqual(await store.initializeFromLegacyFile(file), { itemCount: 2, bindingCount: 2 });
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.deepEqual(await store.loadState(), original);
    const recovered = await readRecoveredQueueItems({ queueRoot: root, profileId: 'developer', sessionId: 'session:one' });
    assert.equal(recovered.length, 1); assert.equal(recovered[0].prompt, 'original one');
    assert.equal(recovered[0].nativeSubmission, undefined); assert.equal(recovered[0].forkContext, undefined);
    const db = new DatabaseSync(path.join(root, 'queue.sqlite'), { readOnly: true });
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
  } finally { await store.close(); }
  assert.deepEqual(await readCodexQueueStoreSnapshot({ queueRoot: root }), original);
});

test('delta update atomically changes only requested item and bindings, preserving original failure', async () => {
  const root = await fixture(); const store = createCodexQueueStore({ queueRoot: root });
  try {
    const originalFailure = item('original', { error: 'Selected model is at capacity.' });
    await store.initialize({ items: [originalFailure, item('continuation')], sessionBindings: { old: 'old-session' } });
    const next = item('continuation', { status: 'running', attempts: 2 });
    await store.commit({ upserts: [next], deletedIds: [], bindingUpserts: { draft: 'session:continuation' }, bindingDeletes: ['old'] });
    const state = await store.loadState();
    assert.deepEqual(state.items, [originalFailure, next]);
    assert.deepEqual(state.sessionBindings, { draft: 'session:continuation' });
    // A bad binding after a valid row update must roll the entire transaction back.
    await assert.rejects(store.commit({ ...emptyChanges(), upserts: [item('new')], bindingUpserts: { broken: 2 } }), /binding/);
    assert.deepEqual(await store.loadState(), state);
  } finally { await store.close(); }
});

test('catalog summary is bounded without truncating recovered session history', async () => {
  const root = await fixture(); const store = createCodexQueueStore({ queueRoot: root });
  const original = item('large', { prompt: 'p'.repeat(90_000), finalMessage: 'a'.repeat(80_000), error: 'e'.repeat(70_000) });
  try {
    await store.initialize({ items: [original], sessionBindings: {} });
    const summary = await readRecoveredQueueItems({ queueRoot: root, profileId: 'developer', summary: true });
    assert.equal(summary[0].prompt.length, 2000); assert.equal(summary[0].finalMessage.length, 2000); assert.equal(summary[0].error.length, 2000);
    const full = await readRecoveredQueueItems({ queueRoot: root, profileId: 'developer', sessionId: 'session:large' });
    assert.equal(full[0].prompt, original.prompt); assert.equal(full[0].finalMessage, original.finalMessage); assert.equal(full[0].error, original.error);
  } finally { await store.close(); }
});

test('duplicate IDs abort migration without dropping history and allow correction', async () => {
  const root = await fixture(); const store = createCodexQueueStore({ queueRoot: root });
  try {
    await assert.rejects(store.initialize({ items: [item('one'), item('one')], sessionBindings: {} }), /UNIQUE/);
    assert.equal(await store.loadState(), null);
    await store.initialize({ items: [item('one')], sessionBindings: {} });
    await assert.rejects(store.initialize({ items: [], sessionBindings: {} }), /already initialized/);
    assert.equal((await store.loadState()).items.length, 1);
  } finally { await store.close(); }
});

test('export produces complete current legacy-compatible snapshot for explicit rollback', async () => {
  const root = await fixture(); const store = createCodexQueueStore({ queueRoot: root });
  try {
    await store.initialize({ items: [item('one'), item('two'), item('three')], sessionBindings: {} });
    await store.commit({ ...emptyChanges(), deletedIds: ['two'], upserts: [item('four')], orderIds: ['four', 'one', 'three'] });
    const target = path.join(root, 'rollback', 'state.json');
    await store.exportLegacySnapshot(target);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), await store.loadState());
  } finally { await store.close(); }
});

test('existing corrupt or uninitialized SQLite never silently falls back to legacy', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'queue.sqlite'), 'invalid sqlite');
  await writeFile(path.join(root, 'state.json'), JSON.stringify({ items: [item('stale')], sessionBindings: {} }));
  await assert.rejects(readRecoveredQueueItems({ queueRoot: root, profileId: 'developer' }), /database|encrypted/);
});

test('deep tracking catches same-millisecond status, nested additions/deletes, array changes and bindings', () => {
  const tracker = createQueueStateTracker({ items: [item('one'), item('two')], sessionBindings: { original: 'session:one' } });
  assert.deepEqual(JSON.parse(JSON.stringify(tracker.state)), tracker.snapshot());
  assert.deepEqual(tracker.takeChanges(), emptyChanges());
  const row = tracker.state.items.find((entry) => entry.id === 'one');
  row.nativeSubmission.deliveryPhase = 'running'; row.stopPolicy = { attempts: [1], nested: { old: true } };
  row.stopPolicy.attempts.push(2); delete row.stopPolicy.nested.old; row.stopPolicy.nested.new = true;
  tracker.state.sessionBindings.new = 'session:one'; delete tracker.state.sessionBindings.original;
  const batch = tracker.takeChanges();
  assert.equal(batch.upserts.length, 1); assert.equal(batch.upserts[0].id, 'one');
  assert.deepEqual(batch.upserts[0].stopPolicy, { attempts: [1, 2], nested: { new: true } });
  assert.deepEqual(batch.bindingUpserts, { new: 'session:one' }); assert.deepEqual(batch.bindingDeletes, ['original']);
  assert.doesNotThrow(() => structuredClone(batch));
  // The snapshot is not a live alias while asynchronous SQLite commit is in flight.
  row.stopPolicy.attempts.push(3); assert.equal(batch.upserts[0].stopPolicy.attempts.length, 2);
  assert.equal(tracker.takeChanges().upserts[0].stopPolicy.attempts.length, 3);
});

test('failed batches merge current edits/deletes without resurrecting stale snapshots', () => {
  const tracker = createQueueStateTracker({ items: [item('one'), item('two')], sessionBindings: {} });
  tracker.state.items[0].status = 'running'; const batch = tracker.takeChanges();
  tracker.state.items[0].status = 'completed'; tracker.state.items.splice(1, 1);
  tracker.restoreChanges(batch);
  const retry = tracker.takeChanges();
  assert.equal(retry.upserts[0].status, 'completed'); assert.deepEqual(retry.deletedIds, ['two']);
  tracker.state.items.splice(0, 1); tracker.restoreChanges(retry);
  const removed = tracker.takeChanges(); assert.deepEqual(removed.upserts, []); assert.deepEqual(new Set(removed.deletedIds), new Set(['one', 'two']));
});

test('tracker handles filtered replacement, new rows, mutable nested aliases and explicit raw bridge', () => {
  const raw = item('one'); const tracker = createQueueStateTracker({ items: [raw, item('two')], sessionBindings: {} });
  tracker.state.items.push(item('three'));
  tracker.state.items = tracker.state.items.filter((entry) => entry.id !== 'two');
  raw.status = 'completed'; tracker.markItem('one');
  const batch = tracker.takeChanges();
  assert.deepEqual(new Set(batch.upserts.map((entry) => entry.id)), new Set(['one', 'three']));
  assert.deepEqual(batch.deletedIds, ['two']); assert.deepEqual(batch.orderIds, ['one', 'three']);
  assert.equal(batch.upserts.find((entry) => entry.id === 'one').status, 'completed');
  assert.throws(() => { tracker.state.items[0].id = 'different'; }, /stable id/);
  assert.throws(() => tracker.state.items.push(item('one')), /Duplicate/);
});

test('durable acknowledged commits survive abrupt process death and reopen', async () => {
  const root = await fixture();
  const moduleUrl = new URL('./codexQueueStore.mjs', import.meta.url).href;
  const source = `import {createCodexQueueStore} from ${JSON.stringify(moduleUrl)};
    const store=createCodexQueueStore({queueRoot:process.argv[1]});
    await store.initialize({items:[],sessionBindings:{}});
    await store.commit({upserts:[${JSON.stringify(item('durable'))}],bindingUpserts:{original:'session:durable'}});
    console.log('DURABLE');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('DURABLE')) resolve(); });
    child.once('error', reject); child.once('exit', (code) => reject(new Error(`child exited ${code}: ${errors}`)));
  });
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve));
  const state = await readCodexQueueStoreSnapshot({ queueRoot: root });
  assert.equal(state.items[0].nativeSubmission.clientUserMessageId, 'code-ai:durable');
  assert.equal(state.sessionBindings.original, 'session:durable');
});

test('worker starts under V8 process flags and an input-type eval launcher', async () => {
  const root = await fixture();
  const moduleUrl = new URL('./codexQueueStore.mjs', import.meta.url).href;
  const source = `import {createCodexQueueStore} from ${JSON.stringify(moduleUrl)};
    const store=createCodexQueueStore({queueRoot:process.argv[1]});
    try {
      await store.initialize({items:[${JSON.stringify(item('launcher'))}],sessionBindings:{}});
      const state=await store.loadState();
      if(state.items[0].id!=='launcher')throw Error('Worker fixture did not persist');
      console.log('WORKER_CLI_OK');
    } finally {await store.close();}`;
  const child = spawn(process.execPath,
    ['--max-old-space-size=256', '--input-type=module', '-e', source, root],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0, errors);
  assert.match(output, /WORKER_CLI_OK/);
});
