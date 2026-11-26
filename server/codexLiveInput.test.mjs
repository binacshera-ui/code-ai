import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createCodexLiveInputService, CodexLiveInputError, codexLiveInputClientId,
  codexLiveInputPayloadHash, isCodexLiveInputError,
} from './codexLiveInput.mjs';
import { createCodexLiveInputStore } from './codexLiveInputStore.mjs';
import { CodexLiveInputNativeError } from './codexLiveInputNative.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const errorCode = code => error => isCodexLiveInputError(error) && error.code === code;
const allowed = new Set(['thread/read', 'thread/turns/list', 'thread/items/list', 'turn/steer']);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'li-service-'));
  const filename = root + '/live-inputs.sqlite';
  let store = await createCodexLiveInputStore({ filename });
  const f = {
    root, store, calls: [], connects: 0, closes: 0, handle: null, status: 'active', history: [],
    turns: [{ id: 'turn-one', status: 'inProgress' }],
    request: { profileId: 'main', sessionId: 'thread-one', clientRequestId: 'request-one',
      input: [{ type: 'text', text: 'Neutral additional user request' }],
      contextText: 'Neutral additional user request', connectionOptions: { codexHome: root + '/home' } },
  };
  const dispatch = async (method, params) => {
    switch (method) {
      case 'thread/read': return { thread: { id: params.threadId, status: { type: f.status } } };
      case 'thread/turns/list': return { data: f.turns };
      case 'thread/items/list': return { data: f.history, nextCursor: null };
      case 'turn/steer': return { turnId: params.expectedTurnId };
      default: throw new Error('No execution queue, cancellation, settings or new turn is allowed');
    }
  };
  f.connect = async options => {
    f.connects++;
    assert.deepEqual(options, f.request.connectionOptions);
    return {
      async rpc(method, params) {
        assert.equal(allowed.has(method), true, 'only inspection and CAS steer are allowed');
        f.calls.push({ method, params: structuredClone(params) });
        return f.handle ? f.handle(method, params, dispatch) : dispatch(method, params);
      },
      close() { f.closes++; },
    };
  };
  f.makeService = (options = {}) => createCodexLiveInputService({ store, connect: f.connect, ...options });
  f.service = f.makeService();
  f.reserve = request => store.reserve({ profileId: request.profileId, sessionId: request.sessionId,
    clientRequestId: request.clientRequestId, payloadHash: codexLiveInputPayloadHash(request), turnId: 'turn-one' }).row;
  f.nativeItem = () => ({ item: { type: 'userMessage', clientId: codexLiveInputClientId(f.request.clientRequestId),
    content: [{ type: 'text', text: 'Neutral additional user request' }] } });
  f.steers = () => f.calls.filter(call => call.method === 'turn/steer');
  f.reopen = async () => {
    store.close(); store = await createCodexLiveInputStore({ filename }); f.store = store; f.service = f.makeService();
  };
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return f;
}

for (const status of ['idle', 'notLoaded']) test(status + ' is a normal-send decision without a receipt, steer or queue action', async t => {
  const f = await fixture(t); f.status = status;
  assert.equal(await f.service.append(f.request), null);
  assert.equal(f.store.get('main', 'request-one'), null);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read']); assert.equal(f.closes, 1);
});

test('active input stays in the same turn with real user input, images and untrusted tool-output context', async t => {
  const f = await fixture(t);
  f.request.input.push({ type: 'localImage', path: '/neutral/attachment.png', detail: 'original' });
  f.request.contextText += '\nAttached neutral image: /neutral/attachment.png';
  const receipt = await f.service.append(f.request);
  assert.deepEqual({ ...receipt, id: undefined }, { id: undefined, profileId: 'main', sessionId: 'thread-one',
    clientRequestId: 'request-one', turnId: 'turn-one', status: 'delivered', kind: 'active-turn' });
  assert.notEqual(receipt.id, receipt.clientRequestId);
  const nativeId = codexLiveInputClientId(f.request.clientRequestId);
  assert.deepEqual(f.steers(), [{ method: 'turn/steer', params: {
    threadId: 'thread-one', expectedTurnId: 'turn-one', clientUserMessageId: nativeId,
    input: f.request.input,
    additionalContext: { [nativeId]: { kind: 'untrusted', name: 'code_ai_live_input', value: f.request.contextText } },
  } }]);
  assert.deepEqual(f.calls.map(call => call.method), ['thread/read', 'thread/turns/list', 'turn/steer']);
  assert.equal(f.store.get('main', 'request-one').status, 'delivered'); assert.equal(f.closes, 1);
});

test('delivered retry after service/store restart returns one durable receipt without any native connect or retransmission', async t => {
  const f = await fixture(t), first = await f.service.append(f.request);
  await f.reopen();
  const second = await f.service.append(f.request);
  assert.deepEqual(second, first); assert.equal(f.connects, 1); assert.equal(f.steers().length, 1);
});

for (const field of ['input', 'contextText', 'sessionId', 'codexHome']) test('stable request ID conflicts with changed ' + field + ' rather than sending again', async t => {
  const f = await fixture(t); await f.service.append(f.request);
  const changed = structuredClone(f.request);
  if (field === 'input') changed.input[0].text += ' changed';
  if (field === 'contextText') changed.contextText += ' changed';
  if (field === 'sessionId') changed.sessionId = 'another-thread';
  if (field === 'codexHome') changed.connectionOptions.codexHome += '-another';
  await assert.rejects(f.service.append(changed), errorCode('LIVE_INPUT_CONFLICT'));
  assert.equal(f.connects, 1); assert.equal(f.steers().length, 1);
});

test('concurrent same-ID submission reserves exactly one native delivery, then recovers via the durable receipt', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred();
  f.handle = async (method, params, normal) => {
    if (method !== 'turn/steer') return normal(method, params);
    started.resolve(); await finish.promise; return { turnId: params.expectedTurnId };
  };
  const first = f.service.append(f.request); await started.promise;
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  finish.resolve(); const receipt = await first;
  assert.deepEqual(await f.service.append(f.request), receipt);
  assert.equal(f.steers().length, 1); assert.equal(f.store.get('main', 'request-one').status, 'delivered');
});

test('crash before dispatch leaves pending intent unknown after restart, never sends it or opens a new turn', async t => {
  const f = await fixture(t), pending = f.reserve(f.request); await f.reopen();
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  assert.equal(f.store.get('main', 'request-one').id, pending.id);
  assert.equal(f.store.get('main', 'request-one').status, 'unconfirmed');
  assert.deepEqual(f.calls.map(call => call.method), ['thread/items/list']);
});

test('crash after dispatch reconciles the original native clientId in its original turn after restart', async t => {
  const f = await fixture(t), pending = f.reserve(f.request); f.history.push(f.nativeItem()); await f.reopen();
  const receipt = await f.service.append(f.request);
  assert.equal(receipt.id, pending.id); assert.equal(receipt.turnId, 'turn-one');
  assert.deepEqual(f.calls.map(call => call.method), ['thread/items/list']);
  assert.equal(f.calls[0].params.turnId, 'turn-one');
});

test('lost ACK with native history proves delivery without sending a second input', async t => {
  const f = await fixture(t);
  f.handle = (method, params, normal) => {
    if (method !== 'turn/steer') return normal(method, params);
    f.history.push(f.nativeItem()); throw new CodexLiveInputNativeError({ code: 'NATIVE_ACK_TIMEOUT' });
  };
  const receipt = await f.service.append(f.request);
  assert.equal(receipt.status, 'delivered'); assert.equal(f.steers().length, 1);
  assert.equal(f.calls.at(-1).method, 'thread/items/list');
});

for (const historyState of ['absent', 'unavailable', 'malformed', 'wrong-client', 'loop', 'bounded']) test('lost ACK with ' + historyState + ' history stays unknown and never retries dispatch', async t => {
  const f = await fixture(t);
  f.handle = (method, params, normal) => {
    if (method === 'turn/steer') throw new CodexLiveInputNativeError({ code: 'NATIVE_ACK_TIMEOUT' });
    if (method !== 'thread/items/list') return normal(method, params);
    if (historyState === 'unavailable') throw new Error('PRIVATE_NATIVE_HISTORY_FAILURE');
    if (historyState === 'malformed') return { data: null };
    if (historyState === 'wrong-client') return { data: [{ item: { type: 'userMessage', clientId: 'another-user-input' } }] };
    if (historyState === 'loop') return { data: [], nextCursor: 'same-cursor' };
    if (historyState === 'bounded') return { data: [], nextCursor: 'page-' + f.calls.length };
    return { data: [] };
  };
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  await assert.rejects(f.service.append(f.request), error => {
    assert.doesNotMatch(error.message, /PRIVATE_NATIVE/); return errorCode('LIVE_INPUT_UNCONFIRMED')(error);
  });
  assert.equal(f.steers().length, 1); assert.equal(f.store.get('main', 'request-one').status, 'unconfirmed');
});

test('reconciliation paginates only the saved turn and can recover after an earlier failed history check', async t => {
  const f = await fixture(t); f.reserve(f.request);
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  f.handle = (method, params, normal) => method === 'thread/items/list'
    ? params.cursor ? { data: [f.nativeItem()], nextCursor: null } : { data: [], nextCursor: 'page-two' }
    : normal(method, params);
  assert.equal((await f.service.append(f.request)).status, 'delivered');
  assert.equal(f.steers().length, 0);
  for (const call of f.calls) {
    assert.equal(call.method, 'thread/items/list'); assert.equal(call.params.turnId, 'turn-one');
    assert.deepEqual(call.params.deferOutput, { commandExecution: true, mcpToolCall: true });
  }
});

for (const code of [-32600, -32602]) test('native CAS rejection ' + code + ' persists no-delivery, never starts a turn or falls back to queue', async t => {
  const f = await fixture(t);
  f.handle = (method, params, normal) => {
    if (method === 'turn/steer') throw new CodexLiveInputNativeError({ code, rejected: true });
    return normal(method, params);
  };
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_TURN_ENDED'));
  assert.equal(f.store.get('main', 'request-one').status, 'not-delivered');
  await f.reopen(); await assert.rejects(f.service.append(f.request), errorCode('LIVE_TURN_ENDED'));
  assert.equal(f.connects, 1); assert.equal(f.steers().length, 1);
});

test('explicit broker non-admission is rejected durably instead of being retried or queued', async t => {
  const f = await fixture(t);
  f.handle = (method, params, normal) => {
    if (method === 'turn/steer') throw new CodexLiveInputNativeError({ code: -32003, rejected: true, admission: 'notAccepted' });
    return normal(method, params);
  };
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_REJECTED'));
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_REJECTED'));
  assert.equal(f.steers().length, 1); assert.equal(f.connects, 1);
});

test('active snapshot followed by authoritative idle can return normal-send without a reserved delivery', async t => {
  const f = await fixture(t); f.turns = [];
  let reads = 0;
  f.handle = (method, params, normal) => {
    if (method === 'thread/read' && ++reads === 2) f.status = 'idle';
    return normal(method, params);
  };
  assert.equal(await f.service.append(f.request), null); assert.equal(f.steers().length, 0);
  assert.equal(f.store.get('main', 'request-one'), null);
});

for (const malformed of ['unknown-status', 'unknown-active-turn', 'multiple-active-turns', 'wrong-thread', 'bad-turn-id']) test(malformed + ' is unavailable, never silently treated as idle', async t => {
  const f = await fixture(t);
  if (malformed === 'unknown-status') f.status = 'systemError';
  if (malformed === 'unknown-active-turn') f.turns = [];
  if (malformed === 'multiple-active-turns') f.turns.push({ id: 'turn-two', status: 'inProgress' });
  if (malformed === 'bad-turn-id') f.turns[0].id = 'bad turn id';
  if (malformed === 'wrong-thread') f.handle = (method, params, normal) => method === 'thread/read'
    ? { thread: { id: 'other-thread', status: { type: 'active' } } } : normal(method, params);
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNAVAILABLE'));
  assert.equal(f.steers().length, 0); assert.equal(f.store.get('main', 'request-one'), null);
});

test('concurrent reservation during idle read never falls through to normal send', async t => {
  const f = await fixture(t); f.status = 'idle';
  f.handle = (method, params, normal) => {
    if (method === 'thread/read') f.reserve(f.request);
    return normal(method, params);
  };
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  assert.equal(f.steers().length, 0);
});

for (const ack of [undefined, {}, { turnId: 'another-turn' }]) test('malformed/mismatched ACK is reconciled, not reported as a delivery to another turn', async t => {
  const f = await fixture(t);
  f.handle = (method, params, normal) => method === 'turn/steer' ? ack : normal(method, params);
  await assert.rejects(f.service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  assert.equal(f.steers().length, 1); assert.equal(f.store.get('main', 'request-one').turnId, 'turn-one');
});

test('receipt persistence failure after native acceptance is unknown, then history recovers without retransmission', async t => {
  const f = await fixture(t); let failed = false;
  const store = { ...f.store, markDelivered(...args) {
    if (!failed) { failed = true; throw new Error('PRIVATE_SQLITE_FAILURE'); }
    return f.store.markDelivered(...args);
  } };
  f.handle = (method, params, normal) => {
    if (method === 'turn/steer') f.history.push(f.nativeItem());
    return normal(method, params);
  };
  const service = f.makeService({ store });
  await assert.rejects(service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  assert.equal((await service.append(f.request)).status, 'delivered'); assert.equal(f.steers().length, 1);
});

test('unavailable transport differentiates fresh unsent request from existing unknown attempt', async t => {
  const f = await fixture(t), service = f.makeService({ connect: async () => { throw new Error('PRIVATE_SOCKET_PATH'); } });
  await assert.rejects(service.append(f.request), errorCode('LIVE_INPUT_UNAVAILABLE'));
  f.reserve(f.request);
  await assert.rejects(service.append(f.request), errorCode('LIVE_INPUT_UNCONFIRMED'));
  assert.equal(f.calls.length, 0);
});

test('persistence read failure is sanitized and cannot cause a native request', async t => {
  const f = await fixture(t), service = f.makeService({ store: { ...f.store, get() { throw new Error('PRIVATE_SQLITE_PATH'); } } });
  await assert.rejects(service.append(f.request), error => {
    assert.doesNotMatch(error.message, /PRIVATE_SQLITE_PATH/); return errorCode('LIVE_INPUT_UNAVAILABLE')(error);
  });
  assert.equal(f.connects, 0);
});

test('input mutation during awaited I/O cannot change the reserved envelope or native contents', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(), original = structuredClone(f.request);
  f.handle = async (method, params, normal) => {
    if (method === 'thread/read') { started.resolve(); await finish.promise; }
    return normal(method, params);
  };
  const sending = f.service.append(f.request); await started.promise;
  f.request.input[0].text = 'mutated after submit'; f.request.contextText = 'mutated context';
  finish.resolve(); await sending;
  assert.deepEqual(f.steers()[0].params.input, original.input);
  assert.equal(Object.values(f.steers()[0].params.additionalContext)[0].value, original.contextText);
  assert.equal(f.store.get('main', 'request-one').payloadHash, codexLiveInputPayloadHash(original));
});

test('connection cleanup failure cannot overwrite a known native delivery', async t => {
  const f = await fixture(t), service = f.makeService({ connect: async options => {
    const connection = await f.connect(options); return { ...connection, close() { throw new Error('PRIVATE_CLOSE_FAILURE'); } };
  } });
  assert.equal((await service.append(f.request)).status, 'delivered');
  assert.equal((await service.append(f.request)).status, 'delivered'); assert.equal(f.steers().length, 1);
});

test('200-character client IDs and alternate valid native media/skill inputs are accepted', async t => {
  const f = await fixture(t); f.request.clientRequestId = 'r'.repeat(200);
  f.request.input = [{type:'image',fileId:'file-neutral'}, {type:'audio',url:'https://neutral.invalid/a'},
    {type:'localAudio',path:'/neutral/a.wav'}, {type:'skill',name:'neutral',path:'/neutral/SKILL.md'},
    {type:'mention',name:'neutral',path:'app://neutral'}];
  assert.equal((await f.service.append(f.request)).status, 'delivered'); assert.equal(f.steers().length, 1);
});

test('malformed, cyclic, oversized-ID and empty input is rejected before any persistence or native I/O', async t => {
  const f = await fixture(t), cyclic = {type:'text',text:'neutral'}; cyclic.loop = cyclic;
  for (const patch of [{input:[]}, {input:[{type:'text',text:'  '}]}, {input:[{type:'localImage',url:'not-a-path'}]},
    {input:[{type:'audio',path:'not-a-url'}]}, {input:[cyclic]}, {clientRequestId:'r'.repeat(201)},
    {contextText: null}, {connectionOptions:{codexHome:''}}]) {
    await assert.rejects(f.service.append({...f.request,...patch}), error => {
      assert.ok(error instanceof CodexLiveInputError); assert.equal(error.statusCode, 400); return error.code === 'LIVE_INPUT_INVALID';
    });
  }
  assert.equal(f.connects, 0); assert.equal(f.store.get('main', 'request-one'), null);
});
