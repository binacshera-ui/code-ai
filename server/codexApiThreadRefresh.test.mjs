import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshCodexApiThread } from './codexApiThreadRefresh.mjs';

const original = () => ({
  thread: { id: 'fixture-thread', status: { type: 'idle' } },
  model: 'gpt-fixture', modelProvider: 'code_ai', cwd: '/fixture/workspace',
  reasoningEffort: 'low', serviceTier: null, approvalPolicy: 'never',
  approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' },
});
function fixture(overrides = {}) {
  const threadResult = original(), refreshed = structuredClone(threadResult), calls = [];
  const options = { model: 'deepseek-v4.1-flash-venice', threadResult, managedOwner: true,
    recovery: false, catalogFile: '/fixture/home/code-ai-models.json',
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/queue/list') return { data: [], nextCursor: null };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      if (method === 'thread/resume') return refreshed;
      throw Error('Unexpected RPC');
    }, ...overrides };
  return { options, refreshed, calls };
}

test('registered API metadata refresh resubscribes the same idle thread with only the configured catalog', async () => {
  for (const model of ['gemini-4-neon', 'deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']) {
    const f = fixture({ model }), before = structuredClone(f.options.threadResult);
    assert.equal(await refreshCodexApiThread(f.options), f.refreshed);
    assert.deepEqual(f.options.threadResult, before);
    assert.deepEqual(f.calls, [
      { method: 'thread/queue/list', params: { threadId: 'fixture-thread', limit: 1 } },
      { method: 'thread/unsubscribe', params: { threadId: 'fixture-thread' } },
      { method: 'thread/resume', params: { threadId: 'fixture-thread', excludeTurns: true,
        config: { model_catalog_json: '/fixture/home/code-ai-models.json' } } },
    ]);
  }
});

test('non-managed, recovery, GPT, unknown aliases and non-idle/malformed thread snapshots make no RPC', async () => {
  for (const overrides of [{ managedOwner: false }, { recovery: true }, { model: 'gpt-6.1-sol' },
    { model: 'deepseek-unknown' }, { model: 'gemini-unknown' },
    { threadResult: { ...original(), thread: { id: 'fixture-thread', status: { type: 'active' } } } },
    { threadResult: { ...original(), thread: { id: 'fixture-thread' } } }, { threadResult: null }]) {
    const f = fixture(overrides);
    assert.equal(await refreshCodexApiThread(f.options), f.options.threadResult);
    assert.deepEqual(f.calls, []);
  }
});

test('pending or incompletely paginated native queues retain their current subscription', async () => {
  for (const queue of [{ data: [{ id: 'pending' }] }, { data: [], nextCursor: 'more' }]) {
    const calls = [], f = fixture({ rpc: async (method, params) => { calls.push({ method, params }); return queue; } });
    assert.equal(await refreshCodexApiThread(f.options), f.options.threadResult);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'thread/queue/list');
  }
});

test('invalid configured catalog or malformed queue cannot be treated as a successful refresh', async () => {
  const badPath = fixture({ catalogFile: 'relative.json' });
  await assert.rejects(refreshCodexApiThread(badPath.options), /catalog is unavailable/);
  assert.equal(badPath.calls.length, 0);
  const badQueue = fixture({ rpc: async () => ({}) });
  await assert.rejects(refreshCodexApiThread(badQueue.options), /queue inspection unavailable/);
});

test('proven pre-detach broker refusal skips refresh; generic rejection and lost ACK propagate', async () => {
  for (const accepted of [true, false]) {
    const calls = [], rejected = Object.assign(new Error('synthetic broker refusal'), {
      code: -32001, admission: accepted ? 'notAccepted' : 'uncertain',
    });
    const f = fixture({ rpc: async method => {
      calls.push(method);
      if (method === 'thread/queue/list') return { data: [] };
      throw rejected;
    } });
    if (accepted) assert.equal(await refreshCodexApiThread(f.options), f.options.threadResult);
    else await assert.rejects(refreshCodexApiThread(f.options), error => error === rejected);
    assert.deepEqual(calls, ['thread/queue/list', 'thread/unsubscribe']);
  }
  const lostAck = Error('synthetic transport closed'), calls = [];
  const f = fixture({ rpc: async method => {
    calls.push(method);
    if (method === 'thread/queue/list') return { data: [] };
    throw lostAck;
  } });
  await assert.rejects(refreshCodexApiThread(f.options), error => error === lostAck);
  assert.deepEqual(calls, ['thread/queue/list', 'thread/unsubscribe']);
});

test('every failure after detach propagates without retry or returning a stale snapshot', async () => {
  for (const status of ['invalid', 'unsubscribed']) {
    const calls = [], error = Object.assign(Error('synthetic lost resume acknowledgement'), { code: -32001, admission: 'notAccepted' });
    const f = fixture({ rpc: async method => {
      calls.push(method);
      if (method === 'thread/queue/list') return { data: [] };
      if (method === 'thread/unsubscribe') return { status };
      throw error;
    } });
    await assert.rejects(refreshCodexApiThread(f.options), status === 'invalid' ? /acknowledgement unavailable/ : value => value === error);
    assert.ok(calls.every(method => !['turn/start', 'thread/queue/add', 'thread/settings/update'].includes(method)));
    assert.equal(calls.filter(method => method === 'thread/resume').length, status === 'invalid' ? 0 : 1);
  }
});

test('changed thread identity or any execution setting fails before a new input can be submitted', async () => {
  for (const [key, value] of [['model', 'different'], ['modelProvider', 'different'], ['cwd', '/different'],
    ['reasoningEffort', 'high'], ['serviceTier', 'priority'], ['approvalPolicy', 'on-request'],
    ['approvalsReviewer', 'auto_review'], ['sandbox', { type: 'readOnly' }], ['thread', { id: 'different' }]]) {
    const f = fixture(); f.refreshed[key] = value;
    await assert.rejects(refreshCodexApiThread(f.options), /changed execution settings/);
    assert.deepEqual(f.calls.map(call => call.method), ['thread/queue/list', 'thread/unsubscribe', 'thread/resume']);
  }
});
