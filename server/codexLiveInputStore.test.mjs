import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexLiveInputStore } from './codexLiveInputStore.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'li-store-'));
  const filename = root + '/live-inputs.sqlite';
  const stores = [];
  t.after(async () => { for (const store of stores) store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const create = async () => { const store = await createCodexLiveInputStore({ filename }); stores.push(store); return store; };
  return { root, filename, create };
}
const reservation = { profileId: 'main', sessionId: 'thread-one', clientRequestId: 'request-one', payloadHash: 'a'.repeat(64), turnId: 'turn-one' };

test('receipts are durable, private, and unique across independent handles without storing prompt content', async t => {
  const f = await fixture(t), first = await f.create(), second = await f.create();
  const a = first.reserve({ ...reservation, prompt: 'PRIVATE_FOLLOWUP_NOT_STORED' });
  const b = second.reserve(reservation);
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.row.id, b.row.id);
  assert.equal(second.get('main', 'request-one').status, 'pending');
  first.markDelivered(a.row.id, 'turn-one');
  assert.equal(second.get('main', 'request-one').status, 'delivered');
  for (const name of await fs.readdir(f.root)) {
    assert.equal((await fs.stat(f.root + '/' + name)).mode & 0o077, 0, name + ' must be private');
    assert.doesNotMatch((await fs.readFile(f.root + '/' + name)).toString(), /PRIVATE_FOLLOWUP_NOT_STORED/);
  }
  const third = await f.create(); assert.equal(third.get('main', 'request-one').turnId, 'turn-one');
});

test('profile isolation and reservation conflict do not overwrite original bindings', async t => {
  const f = await fixture(t), store = await f.create();
  const original = store.reserve(reservation).row;
  const conflict = store.reserve({ ...reservation, sessionId: 'different-thread', payloadHash: 'b'.repeat(64), turnId: 'different-turn' });
  assert.equal(conflict.created, false); assert.deepEqual(conflict.row, original);
  const other = store.reserve({ ...reservation, profileId: 'other' });
  assert.equal(other.created, true); assert.notEqual(other.row.id, original.id);
});

test('late unknown/rejection cannot downgrade delivery and confirmed rejection cannot become delivered', async t => {
  const f = await fixture(t), store = await f.create();
  const original = store.reserve(reservation).row;
  store.markDelivered(original.id, original.turnId);
  assert.equal(store.markUnconfirmed(original.id).status, 'delivered');
  assert.equal(store.markNotDelivered(original.id).status, 'delivered');
  assert.throws(() => store.markDelivered(original.id, 'wrong-turn'), /target changed/);
  const rejected = store.reserve({ ...reservation, clientRequestId: 'rejected' }).row;
  store.markNotDelivered(rejected.id, 'LIVE_TURN_ENDED');
  assert.equal(store.markUnconfirmed(rejected.id).status, 'not-delivered');
  assert.throws(() => store.markDelivered(rejected.id, rejected.turnId), /target changed/);
});

test('crash-shaped pending and unknown receipts survive reopening without an execution worker', async t => {
  const f = await fixture(t), first = await f.create();
  first.reserve(reservation);
  const unknown = first.reserve({ ...reservation, clientRequestId: 'unknown' }).row;
  first.markUnconfirmed(unknown.id);
  const second = await f.create();
  assert.equal(second.get('main', 'request-one').status, 'pending');
  assert.equal(second.get('main', 'unknown').status, 'unconfirmed');
  assert.equal(typeof second.start, 'undefined'); assert.equal(typeof second.enqueue, 'undefined');
});

test('existing public file and symlink targets are rejected without rewriting permissions or contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'li-store-refuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = root + '/existing'; await fs.writeFile(file, 'original', { mode: 0o644 });
  await fs.chmod(file, 0o644); // Do not depend on the operator's private umask.
  await assert.rejects(createCodexLiveInputStore({ filename: file }), /Private live input/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original'); assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
  await fs.chmod(file, 0o600); const link = root + '/link'; await fs.symlink(file, link);
  await assert.rejects(createCodexLiveInputStore({ filename: link }), /Private live input/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
});
