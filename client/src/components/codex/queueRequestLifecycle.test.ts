import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableQueueSubmission, createQueueRequestScope, queueListViewForPanel, removeAcknowledgedAttachments } from './queueRequestLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const lifecycle = createDurableQueueSubmission();
  const events: string[] = [];
  let nextId = 0;
  const options = {
    fingerprint: 'enqueue:server/profile/session/prompt',
    createRequestId: () => `request-${++nextId}`,
    request: async (id: string) => { events.push(`post:${id}`); return { id: 'item' }; },
    accepted: (item: { id: string }) => { events.push(`accepted:${item.id}`); },
    failed: (_error: unknown) => { events.push('send-failed'); },
    sending: (sending: boolean) => { events.push(`sending:${sending}`); },
    refresh: async () => { events.push('refresh'); },
    backgroundFailed: (_error: unknown) => { events.push('refresh-failed'); },
  };
  return { lifecycle, events, options };
}

test('background summaries are compact but open queue details retain full history', () => {
  assert.equal(queueListViewForPanel('closed'), 'compact');
  assert.equal(queueListViewForPanel('summary'), 'compact');
  assert.equal(queueListViewForPanel('details'), 'full');
  // The click handler starts history retrieval before React commits the panel.
  assert.equal(queueListViewForPanel('summary', true), 'full');
  assert.equal(queueListViewForPanel('details', false), 'compact');
});

test('opening/closing history makes previous compact/full reads stale in either order', () => {
  const scope = createQueueRequestScope();
  scope.setScope('server/profile/session');
  const compactRead = scope.beginRead('server/profile/session')!;
  const fullRead = scope.beginRead('server/profile/session')!;
  assert.equal(scope.acceptRead(compactRead), false);
  assert.equal(scope.acceptRead(fullRead), true);
  const compactAfterClose = scope.beginRead('server/profile/session')!;
  assert.equal(scope.acceptRead(fullRead), false);
  assert.equal(scope.acceptRead(compactAfterClose), true);
});

test('acknowledgement releases sending without waiting for queue refresh', async () => {
  const { lifecycle, events, options } = harness();
  const ack = deferred<{ id: string }>();
  const refresh = deferred<void>();
  const send = lifecycle.run({ ...options, request: () => ack.promise, refresh: () => refresh.promise });
  assert.equal(lifecycle.inFlight, true);
  assert.deepEqual(events, ['sending:true']);
  ack.resolve({ id: 'durably-saved' });
  assert.equal(await send, true);
  assert.equal(lifecycle.inFlight, false);
  assert.deepEqual(events, ['sending:true', 'accepted:durably-saved', 'sending:false']);
  // A second message is accepted while the first queue GET is still pending.
  assert.equal(await lifecycle.run(options), true);
  refresh.resolve();
});

test('rapid double click is rejected before async slash/preflight finishes', async () => {
  const { lifecycle, events, options } = harness();
  const preflight = deferred<void>();
  let requests = 0;
  const request = async () => { requests++; await preflight.promise; return { id: 'one' }; };
  const first = lifecycle.run({ ...options, request });
  const duplicate = lifecycle.run({ ...options, request });
  assert.equal(await duplicate, false);
  assert.equal(requests, 1);
  preflight.resolve();
  assert.equal(await first, true);
  assert.equal(events.filter(event => event === 'sending:true').length, 1);
});

test('handled slash command releases gate, performs no queue merge or refresh', async () => {
  const { lifecycle, events, options } = harness();
  const result = await lifecycle.run({ ...options, request: async () => null });
  assert.equal(result, false);
  assert.equal(lifecycle.inFlight, false);
  assert.deepEqual(events, ['sending:true', 'sending:false']);
  assert.equal(await lifecycle.run(options), true);
});

test('failed hold preflight releases gate without refresh or accepted state', async () => {
  const { lifecycle, events, options } = harness();
  assert.equal(await lifecycle.run({ ...options, request: async () => { throw new Error('hold not released'); } }), false);
  assert.equal(lifecycle.inFlight, false);
  assert.deepEqual(events, ['sending:true', 'send-failed', 'sending:false']);
});

test('background refresh rejection cannot turn saved input into a failed send', async () => {
  const { lifecycle, events, options } = harness();
  assert.equal(await lifecycle.run({ ...options, refresh: async () => { throw new Error('GET unavailable'); } }), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(events.includes('refresh-failed'));
  assert.equal(events.includes('send-failed'), false);
  assert.ok(events.indexOf('accepted:item') < events.indexOf('sending:false'));
});

test('post-ack presentation exception does not retain request ID or report send failed', async () => {
  const { lifecycle, events, options } = harness();
  assert.equal(await lifecycle.run({ ...options, accepted: () => { throw new Error('UI state failed'); } }), true);
  assert.equal(events.includes('send-failed'), false);
  await lifecycle.run(options);
  assert.ok(events.includes('post:request-1'));
  assert.ok(events.includes('post:request-2'));
});

test('ambiguous failures retain exact request ID until a valid acknowledgement, not a TTL', async () => {
  const { lifecycle, events, options } = harness();
  const seen: string[] = [];
  const request = async (id: string) => { seen.push(id); throw new TypeError('connection lost after POST'); };
  await lifecycle.run({ ...options, request });
  const realNow = Date.now;
  Date.now = () => realNow() + 3_600_000;
  try { await lifecycle.run({ ...options, request }); }
  finally { Date.now = realNow; }
  assert.deepEqual(seen, ['request-1', 'request-1']);
  await lifecycle.run(options);
  await lifecycle.run(options);
  assert.deepEqual(events.filter(event => event.startsWith('post:')), ['post:request-1', 'post:request-2']);
});

test('changed server, profile, session or payload gets a separate explicit request ID', async () => {
  const { lifecycle, options } = harness();
  const seen: string[] = [];
  const request = async (id: string) => { seen.push(id); throw new TypeError('ambiguous'); };
  for (const fingerprint of ['server-a/profile/session/prompt', 'server-b/profile/session/prompt',
    'server-a/profile-b/session/prompt', 'server-a/profile/session-b/prompt', 'server-a/profile/session/edited']) {
    await lifecycle.run({ ...options, fingerprint, request });
  }
  assert.equal(new Set(seen).size, 5);
});

test('navigation before a retry POST cannot forget an earlier ambiguous request ID', async () => {
  const { lifecycle, events, options } = harness();
  await lifecycle.run({ ...options, request: async () => { throw new TypeError('lost acknowledgement'); } });
  await lifecycle.run({ ...options, request: async () => null });
  await lifecycle.run(options);
  assert.ok(events.includes('post:request-1'));
  assert.equal(events.includes('post:request-2'), false);
});

test('queue reads reject out-of-order responses and any read preceding a durable ack', () => {
  const scope = createQueueRequestScope();
  scope.setScope('server/profile/session');
  const first = scope.beginRead('server/profile/session')!;
  const second = scope.beginRead('server/profile/session')!;
  assert.equal(scope.acceptRead(first), false);
  assert.equal(scope.acceptRead(second), true);
  const send = scope.capture('server/profile/session');
  assert.equal(scope.acknowledged(send), true);
  assert.equal(scope.acceptRead(second), false);
  assert.equal(scope.acceptRead(scope.beginRead('server/profile/session')!), true);
});

test('navigation rejects old ack/list, including return to same conversation', async () => {
  const scope = createQueueRequestScope();
  scope.setScope('server-a/profile/session-a');
  const oldAck = scope.capture('server-a/profile/session-a');
  const oldRead = scope.beginRead('server-a/profile/session-a')!;
  scope.setScope('server-a/profile/session-b');
  assert.equal(scope.acknowledged(oldAck), false);
  assert.equal(scope.acceptRead(oldRead), false);
  assert.equal(scope.capture('server-a/profile/session-a'), null);
  scope.setScope('server-a/profile/session-a');
  assert.equal(scope.current(oldAck), false);
  assert.equal(scope.acceptRead(oldRead), false);
  assert.equal(scope.acknowledged(scope.capture('server-a/profile/session-a')), true);
});

test('late ack after navigation preserves new composer and has no cross-server refresh', async () => {
  const { lifecycle, events, options } = harness();
  const scope = createQueueRequestScope();
  scope.setScope('server-a/profile/session');
  const ticket = scope.capture('server-a/profile/session');
  const ack = deferred<{ id: string }>();
  let prompt = 'old message';
  const send = lifecycle.run({
    ...options, request: () => ack.promise,
    accepted: () => { if (scope.acknowledged(ticket)) prompt = ''; },
    refresh: () => { if (scope.current(ticket)) events.push('queue-refreshed'); },
  });
  scope.setScope('server-b/profile/session');
  prompt = 'new draft on other server';
  ack.resolve({ id: 'old saved message' });
  assert.equal(await send, true);
  assert.equal(prompt, 'new draft on other server');
  assert.equal(events.includes('queue-refreshed'), false);
  assert.equal(lifecycle.inFlight, false);
});

test('ack clears only sent attachments and revokes only their preview URLs', () => {
  const old = { id: 'sent', previewUrl: 'blob:old' };
  const added = { id: 'added-during-request', previewUrl: 'blob:new' };
  const revoked: string[] = [];
  assert.deepEqual(removeAcknowledgedAttachments([old, added], new Set(['sent']), url => revoked.push(url)), [added]);
  assert.deepEqual(revoked, ['blob:old']);
});
