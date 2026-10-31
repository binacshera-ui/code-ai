import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexSharedOwnerBroker } from './codexSharedOwnerBroker.mjs';
import { CodexSharedSubscriptions, trackExplicitSubscription } from './codexSharedSubscriptions.mjs';

function fixture(t, threads, records = []) {
  const calls = [];
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const broker = new CodexSharedOwnerBroker({ records });
  const makeChannel = (name, roots = []) => ({
    clientName: name, subscriptionRoots: new Set(roots), subscriptions: new Set(threads.filter(t => t.loaded !== false).map(t => t.id)),
    async call(method, params) {
      calls.push({ name, method, params });
      const thread = byId.get(params.threadId);
      if (method === 'thread/loaded/list') return { data: threads.filter(t => t.loaded !== false).map(t => t.id), nextCursor: null };
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        return { thread: { id: thread.id, ephemeral: thread.ephemeral ?? false,
          status: { type: thread.status ?? 'idle' }, source: thread.source ?? (thread.parent
            ? { subAgent: { thread_spawn: { parent_thread_id: thread.parent } } } : 'vscode') } };
      }
      if (method === 'thread/queue/list') return { data: thread.queued ? [{}] : [], nextCursor: null };
      if (method === 'thread/goal/get') return { goal: thread.goal ?? null };
      if (method === 'thread/backgroundTerminals/list') return { data: thread.terminals ? [{}] : [], nextCursor: null };
      if (method === 'thread/resume') { assert.equal(params.excludeTurns, true); this.subscriptions.add(params.threadId); return { thread: { id: params.threadId } }; }
      if (method === 'thread/unsubscribe') return { status: this.subscriptions.delete(params.threadId) ? 'unsubscribed' : 'notSubscribed' };
      assert.fail('Unexpected mutation or history read: ' + method);
    },
  });
  const recovery = makeChannel('code-ai-broker-recovery');
  const web = makeChannel('code-ai', ['own']);
  const desktop = makeChannel('codex-desktop', ['own']);
  const channels = new Set([recovery, web, desktop]);
  const lifecycle = new CodexSharedSubscriptions({ broker, channels, recovery });
  t.after(() => lifecycle.close());
  return { lifecycle, broker, recovery, web, desktop, calls, byId };
}

test('idle children of unloaded roots release incidental subscribers, while active trees and intentional desktop subscriptions remain', async t => {
  const f = fixture(t, [
    { id: 'own', status: 'active' }, { id: 'own-idle-child', parent: 'own' },
    { id: 'foreign-root', loaded: false, status: 'notLoaded' },
    { id: 'orphan', parent: 'foreign-root' },
    { id: 'foreign-active', status: 'active' }, { id: 'foreign-idle-child', parent: 'foreign-active' },
  ]);
  assert.deepEqual(await f.lifecycle.sweep(), { unsubscribed: 2 });
  for (const channel of [f.recovery, f.web]) {
    assert.equal(channel.subscriptions.has('orphan'), false);
    for (const id of ['own', 'own-idle-child', 'foreign-active', 'foreign-idle-child']) assert.ok(channel.subscriptions.has(id));
  }
  assert.ok(f.desktop.subscriptions.has('orphan'));
  assert.equal(f.calls.some(call => /archive|interrupt|shutdown|queue\/add|items\/list|turns\/list/.test(call.method)), false);
  for (const id of ['own', 'own-idle-child', 'foreign-active', 'foreign-idle-child']) {
    assert.ok(f.calls.some(call => call.name === 'code-ai-broker-recovery' && call.method === 'thread/resume' && call.params.threadId === id));
  }
});

test('queued inputs, goals, background terminals and active descendants protect their complete trees', async t => {
  const f = fixture(t, [
    { id: 'own', status: 'active' },
    { id: 'queue-root' }, { id: 'queued', parent: 'queue-root', queued: true },
    { id: 'goal-root' }, { id: 'goal', parent: 'goal-root', goal: { status: 'active' } },
    { id: 'terminal-root' }, { id: 'terminal', parent: 'terminal-root', terminals: true },
    { id: 'child-root' }, { id: 'active-child', parent: 'child-root', status: 'active' },
    { id: 'idle-sibling', parent: 'child-root' },
  ]);
  assert.deepEqual(await f.lifecycle.sweep(), { unsubscribed: 0 });
  for (const threadId of ['queued', 'goal']) assert.equal(f.calls.some(call =>
    call.method === 'thread/resume' && call.params.threadId === threadId), false, 'Cleanup must not wake pending work or an active goal');
});

test('released reservation can lose the recovery subscription; an explicitly opened root and children remain with their frontend', async t => {
  const f = fixture(t, [{ id: 'own' }, { id: 'child', parent: 'own' }]);
  assert.deepEqual(await f.lifecycle.sweep(), { unsubscribed: 2 });
  assert.equal(f.recovery.subscriptions.size, 0);
  assert.ok(f.web.subscriptions.has('own'));
  assert.ok(f.web.subscriptions.has('child'));
  trackExplicitSubscription(f.web, 'thread/resume', { thread: { id: 'other' } });
  assert.ok(f.web.subscriptionRoots.has('other'));
});

test('unfinished durable custody and an in-flight resume cannot be pruned even after an idle observation', async t => {
  const f = fixture(t, [{ id: 'own' }, { id: 'reserved' }, { id: 'unrelated' }],
    [{ threadId: 'reserved', phase: 'released', turnComplete: false }]);
  f.web.pendingSubscriptions = 1;
  await f.lifecycle.sweep();
  assert.ok(f.recovery.subscriptions.has('reserved'));
  assert.ok(f.web.subscriptions.has('unrelated'));
  assert.equal(f.recovery.subscriptions.has('unrelated'), false);
});

test('missing native inspection support, unknown sources, ephemeral threads and malformed pagination retain resources', async t => {
  const f = fixture(t, [{ id: 'own', status: 'active' }, { id: 'unknown', source: { subAgent: 'review' } },
    { id: 'ephemeral', ephemeral: true }]);
  assert.deepEqual(await f.lifecycle.sweep(), { unsubscribed: 0 });
  f.recovery.call = async () => { throw Error('Unsupported old native method'); };
  await assert.rejects(f.lifecycle.sweep(), /Unsupported/);
  assert.equal(f.calls.filter(call => call.method === 'thread/unsubscribe').length, 0);
  f.recovery.call = async () => ({ data: ['own'], nextCursor: 'repeated' });
  await assert.rejects(f.lifecycle.sweep(), /pagination/);
});

test('unsubscription is serialized with a late public resume and cleanup closes without signalling any owner', async t => {
  const f = fixture(t, [{ id: 'own', status: 'active' }, { id: 'other' }]);
  const serialize = f.broker.serialize.bind(f.broker);
  f.broker.serialize = async (id, operation) => {
    trackExplicitSubscription(f.web, 'thread/resume', { thread: { id } });
    return serialize(id, operation);
  };
  await f.lifecycle.sweep();
  assert.ok(f.web.subscriptions.has('other'));
  f.lifecycle.close();
  assert.deepEqual(await f.lifecycle.sweep(), { unsubscribed: 0 });
});

test('a goal activated after inspection is rechecked under admission before attaching recovery', async t => {
  const f = fixture(t, [{ id: 'own', status: 'active' }, { id: 'child', parent: 'own' }]);
  const serialize = f.broker.serialize.bind(f.broker);
  f.broker.serialize = async (threadId, operation) => {
    if (threadId === 'child') f.byId.get('child').goal = { status: 'active' };
    return serialize(threadId, operation);
  };
  await f.lifecycle.sweep();
  assert.equal(f.calls.some(call => call.method === 'thread/resume' && call.params.threadId === 'child'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/unsubscribe'), false);
});
