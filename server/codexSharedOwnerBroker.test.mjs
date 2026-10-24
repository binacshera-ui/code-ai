import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexSharedOwnerBroker, BrokerRefusal, validateBrokerJournal,
  createReservationJournal, isRestorableNativePermissionProfile } from './codexSharedOwnerBroker.mjs';

const previous = () => ({ model: 'mock-desktop', effort: 'medium', cwd: '/synthetic/desktop',
  approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
const requested = () => ({ model: 'mock-web', effort: 'high', cwd: '/synthetic/web',
  approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
const params = () => ({ threadId: 'fixture-thread', clientUserMessageId: 'fixture-web',
  input: [{ type: 'text', text: 'Synthetic prompt never included in metadata.' }],
  codeAiTurnSettings: requested() });

function fixture(options = {}) {
  const writes = [], calls = [], queue = [], history = [];
  let settings = previous(), queueError = null;
  const broker = new CodexSharedOwnerBroker({ save: async records => writes.push(structuredClone(records)), ...options });
  broker.ownerModes.set('fixture-thread', 'default');
  const channel = {
    clientName: 'code-ai',
    async call(method, input) {
      calls.push({ method, params: structuredClone(input) });
      if (method === 'thread/resume') return { model: settings.model, reasoningEffort: settings.effort,
        cwd: settings.cwd, approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy,
        runtimeWorkspaceRoots: [settings.cwd], thread: { id: input.threadId } };
      if (method === 'thread/read') return { thread: { id: input.threadId, turns: history } };
      if (method === 'thread/settings/update') {
        settings = { model: input.model ?? settings.model, effort: input.effort ?? settings.effort,
          cwd: input.cwd ?? settings.cwd, approvalPolicy: input.approvalPolicy ?? settings.approvalPolicy,
          sandboxPolicy: input.sandboxPolicy ?? settings.sandboxPolicy };
        return {};
      }
      if (method === 'thread/queue/list') return { data: queue, nextCursor: null };
      if (method === 'thread/queue/add') {
        if (queueError) throw queueError;
        const item = { id: `queued-${queue.length + 1}`, clientUserMessageId: input.clientUserMessageId };
        queue.push(item); return { queuedSubmission: item };
      }
      if (method === 'thread/queue/delete') {
        const index = queue.findIndex(item => item.id === input.queuedSubmissionId);
        if (index < 0) return { deleted: false };
        queue.splice(index, 1); return { deleted: true };
      }
      return {};
    },
  };
  return { broker, channel, writes, calls, queue, history, settings: () => settings,
    setEffort: effort => { settings.effort = effort; }, setQueueError: error => { queueError = error; } };
}

async function enqueue(f) { return f.broker.handle(f.channel, { method: 'thread/queue/add', params: params() }); }

test('resumed browser thread with identical settings uses native snapshot mode without a settings event', async () => {
  const f = fixture(); f.broker.ownerModes.clear();
  const nativeCall = f.channel.call.bind(f.channel);
  f.channel.call = async (method, input) => {
    const result = await nativeCall(method, input);
    return method === 'thread/resume' ? { ...result, collaborationMode: { mode: 'default', settings: {} } } : result;
  };
  const result = await f.broker.handle(f.channel, { method: 'thread/queue/add', params: {
    ...params(), codeAiTurnSettings: previous(),
  } });
  assert.equal(result.queuedSubmission.clientUserMessageId, 'fixture-web');
  assert.equal(f.queue.length, 1);
  assert.deepEqual(f.settings(), previous());
  assert.equal(f.broker.ownerModes.get('fixture-thread'), 'default');
});

test('resume snapshot replaces stale mode proof and a plan thread cannot accept default input', async () => {
  const f = fixture();
  const nativeCall = f.channel.call.bind(f.channel);
  f.channel.call = async (method, input) => {
    const result = await nativeCall(method, input);
    return method === 'thread/resume' ? { ...result, collaborationMode: { mode: 'plan', settings: {} } } : result;
  };
  await f.broker.handle(f.channel, { method: 'thread/resume', params: { threadId: 'fixture-thread', excludeTurns: true } });
  assert.equal(f.broker.ownerModes.get('fixture-thread'), 'plan');
  await assert.rejects(enqueue(f), error => error instanceof BrokerRefusal && error.reason === 'native-collaboration-mode-mismatch');
  assert.equal(f.queue.length, 0);
  assert.deepEqual(f.settings(), previous());
});

test('unrecognized explicit native mode clears old proof while an omitted legacy field preserves it', () => {
  const f = fixture();
  f.broker.observeOwnerMode('fixture-thread', {});
  assert.equal(f.broker.ownerModes.get('fixture-thread'), 'default');
  for (const mode of [null, { mode: 'unknown' }]) {
    f.broker.ownerModes.set('fixture-thread', 'default');
    f.broker.observeOwnerMode('fixture-thread', { collaborationMode: mode });
    assert.equal(f.broker.ownerModes.has('fixture-thread'), false);
  }
});
async function dispatch(f) {
  f.queue.length = 0;
  await f.broker.observe(f.channel, { method: 'item/started', params: {
    threadId: 'fixture-thread', turnId: 'fixture-own-turn',
    item: { type: 'userMessage', clientId: 'fixture-web' },
  } });
}

test('pin requested native settings through the entire own turn; restore only after its completion', async () => {
  const f = fixture();
  const result = await enqueue(f);
  assert.equal(result.queuedSubmission.clientUserMessageId, 'fixture-web');
  assert.deepEqual(f.settings(), requested());
  const submitted = f.calls.find(call => call.method === 'thread/queue/add');
  assert.equal(Object.hasOwn(submitted.params, 'codeAiTurnSettings'), false);
  assert.equal(f.writes.find(records => records[0]?.phase === 'enqueuing')[0].queuedId, null);
  assert.equal(JSON.stringify(f.writes).includes('Synthetic prompt'), false);
  await f.broker.observe(f.channel, { method: 'item/started', params: {
    threadId: 'fixture-thread', turnId: 'desktop-turn', item: { type: 'userMessage', clientId: 'desktop' },
  } });
  assert.deepEqual(f.settings(), requested());
  await dispatch(f);
  assert.deepEqual(f.settings(), requested());
  assert.equal(f.broker.records.get('fixture-thread').phase, 'started');
  await f.broker.observe(f.channel, { method: 'turn/completed', params: {
    threadId: 'fixture-thread', turn: { id: 'desktop-turn', status: 'completed' },
  } });
  assert.deepEqual(f.settings(), requested());
  await f.broker.observe(f.channel, { method: 'turn/completed', params: {
    threadId: 'fixture-thread', turn: { id: 'fixture-own-turn', status: 'completed' },
  } });
  assert.deepEqual(f.settings(), previous());
  assert.equal(f.broker.records.get('fixture-thread').phase, 'released');
});

test('foreign queue/settings/start cannot interleave while our next-turn config is reserved', async () => {
  const f = fixture(); await enqueue(f);
  for (const method of ['thread/queue/add', 'turn/start', 'thread/settings/update', 'thread/queue/start',
    'thread/archive', 'thread/unsubscribe', 'config/mcpServer/reload', 'config/batchWrite']) {
    await assert.rejects(f.broker.handle(f.channel, { method, params: {
      threadId: 'fixture-thread', input: [], model: 'foreign',
    } }), error => error instanceof BrokerRefusal && error.delivery === 'notAccepted');
  }
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
});

test('question answers do not take a reservation mutex; cancellation of another turn is forwarded without guessing', async () => {
  const f = fixture(); await enqueue(f);
  await f.broker.handle(f.channel, { method: 'turn/interrupt', params: {
    threadId: 'fixture-thread', turnId: 'explicit-desktop-turn',
  } });
  assert.deepEqual(f.calls.at(-1), { method: 'turn/interrupt', params: {
    threadId: 'fixture-thread', turnId: 'explicit-desktop-turn',
  } });
  assert.deepEqual(f.settings(), requested());
});

test('active turn settings cannot be restored or changed; next-turn settings are writable after completion', async () => {
  const f = fixture(); await enqueue(f); await dispatch(f);
  await assert.rejects(f.broker.handle(f.channel, { method: 'turn/settings/update', params: {
    threadId: 'fixture-thread', turnId: 'fixture-own-turn', model: 'foreign',
  } }), BrokerRefusal);
  await assert.rejects(f.broker.handle(f.channel, { method: 'thread/settings/update', params: {
    threadId: 'fixture-thread', model: 'next-desktop',
  } }), BrokerRefusal);
  await assert.rejects(f.broker.release(f.channel, f.broker.records.get('fixture-thread')), /Active turn settings/);
  assert.deepEqual(f.settings(), requested());
  assert.equal(f.broker.keepConnection(f.channel), true);
  await f.broker.observe(f.channel, { method: 'turn/completed', params: {
    threadId: 'fixture-thread', turn: { id: 'fixture-own-turn', status: 'completed' },
  } });
  assert.equal(f.broker.keepConnection(f.channel), false);
  assert.deepEqual(f.settings(), previous());
  await f.broker.handle(f.channel, { method: 'thread/settings/update', params: {
    threadId: 'fixture-thread', model: 'next-desktop',
  } });
  assert.equal(f.settings().model, 'next-desktop');
});

test('cancel confirmed pending native input restores original defaults; false delete never assumes nondelivery', async () => {
  const f = fixture(); const result = await enqueue(f);
  await f.broker.handle(f.channel, { method: 'thread/queue/delete', params: {
    threadId: 'fixture-thread', queuedSubmissionId: 'wrong-id',
  } });
  assert.deepEqual(f.settings(), requested());
  await f.broker.handle(f.channel, { method: 'thread/queue/delete', params: {
    threadId: 'fixture-thread', queuedSubmissionId: result.queuedSubmission.id,
  } });
  assert.deepEqual(f.settings(), previous());
  assert.equal(f.broker.records.get('fixture-thread').turnComplete, true);
});

test('definite native enqueue rejection restores defaults; unknown ACK preserves custody and never replays', async () => {
  const definite = fixture();
  const rejection = new Error('Synthetic rejection'); rejection.nativeRejected = true; rejection.code = -32602;
  definite.setQueueError(rejection);
  await assert.rejects(enqueue(definite), error => error instanceof BrokerRefusal && error.delivery === 'notAccepted');
  assert.deepEqual(definite.settings(), previous());
  const uncertain = fixture(); uncertain.setQueueError(new Error('Synthetic transport loss'));
  await assert.rejects(enqueue(uncertain), /custody unresolved/);
  assert.deepEqual(uncertain.settings(), requested());
  assert.equal(uncertain.broker.records.get('fixture-thread').phase, 'uncertain');
  await assert.rejects(enqueue(uncertain), BrokerRefusal);
  assert.equal(uncertain.calls.filter(call => call.method === 'thread/queue/add').length, 1);
});

test('foreign pending queue refuses before settings mutation or input submission', async () => {
  const f = fixture(); f.queue.push({ id: 'foreign', clientUserMessageId: 'desktop' });
  await assert.rejects(enqueue(f), error => error.reason === 'foreign-queue-pending');
  assert.equal(f.calls.some(call => call.method === 'thread/settings/update'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  assert.equal(f.writes.length, 0);
});

test('null prior native effort is not replaced when the API cannot restore it', async () => {
  const f = fixture(); f.setEffort(null);
  await assert.rejects(enqueue(f), error => error.reason === 'unrestorable-native-effort');
  assert.equal(f.calls.some(call => call.method === 'thread/settings/update'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
});

test('explicit Plan/Default mismatch and unknown loaded mode refuse before queue custody and restore five settings', async () => {
  for (const mode of ['plan', undefined]) {
    const f = fixture();
    if (mode) f.broker.ownerModes.set('fixture-thread', mode);
    else f.broker.ownerModes.delete('fixture-thread');
    await assert.rejects(enqueue(f), error => error instanceof BrokerRefusal
      && error.reason.startsWith('native-collaboration-mode-'));
    assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
    assert.deepEqual(f.settings(), previous());
  }
});

test('fresh native thread constructor defaults allow Default admission without guessing loaded thread mode', async () => {
  const f = fixture(); f.broker.ownerModes.delete('fixture-thread');
  const native = f.channel.call.bind(f.channel);
  f.channel.call = async (method, value) => method === 'thread/start'
    ? { thread: { id: 'fixture-thread' } } : native(method, value);
  await f.broker.handle(f.channel, { method: 'thread/start', params: {} });
  await enqueue(f);
  assert.equal(f.queue.length, 1);
});

test('named permission profiles and multiple workspace roots are refused before prompt/config delivery', async () => {
  for (const override of [
    { activePermissionProfile: { id: 'company-profile', extends: ':workspace' } },
    { runtimeWorkspaceRoots: ['/synthetic/one', '/synthetic/two'] },
  ]) {
    const f = fixture(), original = f.channel.call.bind(f.channel);
    f.channel.call = async (method, value) => {
      const result = await original(method, value);
      return method === 'thread/resume' ? { ...result, ...override } : result;
    };
    await assert.rejects(enqueue(f), error => error instanceof BrokerRefusal && error.reason.startsWith('unrestorable-'));
    assert.equal(f.calls.some(call => call.method === 'thread/settings/update'), false);
    assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  }
});

test('native built-in spelling variants are admitted only for their matching sandbox kind', async () => {
  for (const [id,type] of [[':read-only','readOnly'],[':workspace','workspaceWrite'],[':workspace-write','workspaceWrite'],
    [':full-access','dangerFullAccess'],[':danger-full-access','dangerFullAccess']]) {
    assert.equal(isRestorableNativePermissionProfile({id,extends:null},{type}),true);
    assert.equal(isRestorableNativePermissionProfile({id,extends:'named-parent'},{type}),false);
    assert.equal(isRestorableNativePermissionProfile({id,extends:null},{type:'unknown'}),false);
  }
  for(const id of ['named-profile','__proto__','constructor',null])assert.equal(isRestorableNativePermissionProfile({id,extends:null},{type:'dangerFullAccess'}),false);
  assert.equal(isRestorableNativePermissionProfile(null,{type:'dangerFullAccess'}),true);
  const f=fixture(),original=f.channel.call.bind(f.channel);
  f.channel.call=async(method,value)=>{
    const result=await original(method,value);
    return method==='thread/resume'?{...result,activePermissionProfile:{id:':read-only',extends:null}}:result;
  };
  await enqueue(f);await dispatch(f);assert.deepEqual(f.settings(),requested());
  await f.broker.observe(f.channel,{method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-own-turn',status:'completed'}}});
  assert.deepEqual(f.settings(),previous());
});

test('Ubuntu GUI built-in full access with unchanged cwd and two workspace roots preserves defaults',async()=>{
  const f=fixture(),original=f.channel.call.bind(f.channel);let sandbox={type:'dangerFullAccess'};
  f.channel.call=async(method,value)=>{
    const result=await original(method,value);
    if(method==='thread/settings/update')sandbox=value.sandboxPolicy;
    return method==='thread/resume'?{...result,sandbox,activePermissionProfile:{id:':danger-full-access',extends:null},
      runtimeWorkspaceRoots:['/synthetic/desktop','/synthetic/other'],thread:{id:value.threadId,environments:[{}]}}:result;
  };
  const p=params();p.codeAiTurnSettings.cwd='/synthetic/desktop';
  await f.broker.pinAndEnqueue(f.channel,p);await dispatch(f);
  assert.equal(f.queue.length,0);assert.equal(f.broker.records.get('fixture-thread').previous.sandboxPolicy.type,'dangerFullAccess');
  assert.equal(f.settings().cwd,'/synthetic/desktop');
});

test('a preceding desktop settings write settles before reservation captures its original baseline', async () => {
  const f = fixture(), original = f.channel.call.bind(f.channel);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.channel.call = async (method, value) => {
    if (method === 'thread/settings/update' && value.model === 'latest-desktop') {
      entered(); await blocked;
    }
    return original(method, value);
  };
  const update = f.broker.handle(f.channel, { method: 'thread/settings/update', params: {
    threadId: 'fixture-thread', model: 'latest-desktop',
  } });
  await started;
  const admission = enqueue(f);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  release(); await update; await admission;
  assert.equal(f.broker.records.get('fixture-thread').previous.model, 'latest-desktop');
  await dispatch(f);
  assert.equal(f.settings().model, 'mock-web');
  await f.broker.observe(f.channel,{method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-own-turn',status:'completed'}}});
  assert.equal(f.settings().model, 'latest-desktop');
});

test('unresolved preceding native settings/global config writes disable further pinning, never overtake them', async () => {
  for (const method of ['thread/settings/update', 'config/batchWrite']) {
    const f = fixture();
    f.channel.call = async () => { throw new Error('Synthetic lost applied-state confirmation'); };
    await assert.rejects(f.broker.handle(f.channel, { method, params: { threadId: 'fixture-thread' } }));
    assert.equal(f.broker.storageHealthy, false);
    await assert.rejects(enqueue(f), BrokerRefusal);
  }
});

test('unknown fields and unsupported public policies fail before installed native effects', async () => {
  for (const mutate of [
    value => { value.codeAiTurnSettings.secret = 'synthetic-not-a-secret'; },
    value => { value.codeAiTurnSettings.approvalPolicy = 'unsupported'; },
    value => { value.codeAiTurnSettings.sandboxPolicy = { type: 'readOnly', config: {} }; },
    value => { value.codeAiTurnSettings.cwd = 'relative'; },
    value => { value.codeAiTurnSettings.effort = 'invented'; },
  ]) {
    const f = fixture(), value = params(); mutate(value);
    await assert.rejects(f.broker.pinAndEnqueue(f.channel, value), BrokerRefusal);
    assert.equal(f.calls.length, 0);
  }
});

test('optional immutable owner baseline mismatch does not silently widen policy', async () => {
  const f = fixture(), value = params();
  value.codeAiExpectedOwnerSettings = { cwd: '/wrong/cwd', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  await assert.rejects(f.broker.pinAndEnqueue(f.channel, value), error => error.reason === 'owner-policy-baseline-mismatch');
  assert.equal(f.calls.some(call => call.method === 'thread/settings/update'), false);
});

test('recovery preserves active turn permissions without replay, then restores after proven completion', async () => {
  const f = fixture(); await enqueue(f);
  const records = structuredClone([...f.broker.records.values()]);
  const recovered = new CodexSharedOwnerBroker({ records });
  await recovered.recover(f.channel);
  assert.equal(recovered.records.get('fixture-thread').phase, 'queued');
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  f.history.push({ id: 'fixture-own-turn', status: 'inProgress', items: [
    { type: 'userMessage', clientId: 'fixture-web' },
  ] });
  f.queue.length = 0;
  await recovered.recover(f.channel);
  assert.equal(recovered.records.get('fixture-thread').phase, 'started');
  assert.deepEqual(f.settings(), requested());
  assert.equal(recovered.keepConnection(f.channel), true);
  f.history[0].status = 'completed';
  await recovered.recover(f.channel);
  assert.equal(recovered.records.get('fixture-thread').phase, 'released');
  assert.deepEqual(f.settings(), previous());
});

test('released active input recovers exact native status without bulk history, settings writes or replay', async () => {
  const f=fixture();await enqueue(f);await dispatch(f);
  // Historical journal from the old early-restore implementation.
  f.broker.records.get('fixture-thread').phase='released';
  const recovered=new CodexSharedOwnerBroker({records:structuredClone([...f.broker.records.values()])});
  const native=f.channel.call.bind(f.channel);f.calls.length=0;
  f.channel.call=async(method,params)=>{
    if(method==='thread/read'||method==='thread/items/list')assert.fail('Released status must not load tool-output bodies');
    if(method==='thread/turns/list')return{data:[{id:'fixture-own-turn',status:'inProgress'}],nextCursor:null};
    return native(method,params);
  };
  await recovered.recover(f.channel);
  assert.equal(recovered.records.get('fixture-thread').turnComplete,false);
  assert.equal(recovered.keepConnection(f.channel),true);
  assert.equal(f.calls.some(x=>['thread/queue/add','thread/settings/update'].includes(x.method)),false);
});

test('snapshot absence does not release an uncertain queue; no replay, cancellation, or synthetic completion', async () => {
  const f = fixture(); f.setQueueError(new Error('Synthetic unknown delivery'));
  await assert.rejects(enqueue(f));
  const recovered = new CodexSharedOwnerBroker({ records: structuredClone([...f.broker.records.values()]) });
  await recovered.recover(f.channel);
  assert.equal(recovered.records.get('fixture-thread').phase, 'uncertain');
  assert.equal(recovered.records.get('fixture-thread').turnComplete, false);
  assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), false);
});

test('an enqueue ACK arriving after own start cannot revert the release fence to queued', async () => {
  const f = fixture();
  const native = f.channel.call.bind(f.channel);
  f.channel.call = async (method, value) => {
    const result = await native(method, value);
    if (method === 'thread/queue/add') {
      void f.broker.observe(f.channel, { method: 'item/started', params: {
        threadId: 'fixture-thread', turnId: 'fixture-own-turn',
        item: { type: 'userMessage', clientId: 'fixture-web' },
      } });
    }
    return result;
  };
  await enqueue(f);
  await f.broker.serialize('fixture-thread', async () => {});
  assert.equal(f.broker.records.get('fixture-thread').phase, 'started');
  assert.deepEqual(f.settings(), requested());
});

test('journal failure refuses new prompt before any queue write; it is not treated as a qualification pass', async () => {
  const f = fixture({ save: async () => { throw new Error('Synthetic disk failure'); } });
  await assert.rejects(enqueue(f), /journal unavailable/);
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);
  assert.equal(f.broker.storageHealthy, false);
  await assert.rejects(enqueue(f), BrokerRefusal);
});

test('metadata journal is private, durable, and excludes prompts/unknown config fields', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-broker-journal-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'journal.json');
  const journal = await createReservationJournal(filename);
  const f = fixture({ save: journal.save }); await enqueue(f);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(validateBrokerJournal(value).length, 1);
  assert.equal(JSON.stringify(value).includes('Synthetic prompt'), false);
  value.records[0].prompt = 'Not permitted';
  assert.throws(() => validateBrokerJournal(value), /Invalid reservation metadata/);
  const unsafe = path.join(root, 'unsafe'); await mkdir(unsafe); await chmod(unsafe, 0o755);
  await assert.rejects(createReservationJournal(path.join(unsafe, 'journal.json')), /Private journal directory required/);
});
