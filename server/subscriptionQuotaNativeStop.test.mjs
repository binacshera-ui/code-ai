import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, chmod, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { stopNativeSubscriptionTurns, readNativeQuotaTurnModel, connectNativeQuotaOwner } from './subscriptionQuotaNativeStop.mjs';

const profile = { id: 'fixture', provider: 'codex', codexHome: '/fixture/not-a-live-home' };
const blocked = async () => true;

function owner(threads, { terminalOnInterrupt = true, deleteResult = true } = {}) {
  const calls = [], states = new Map(threads.map(thread => [thread.id, thread.status || 'inProgress']));
  let closed = false;
  return {
    calls, get closed() { return closed; }, states,
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: threads.map(thread => thread.id) };
      const thread = threads.find(thread => thread.id === params.threadId);
      if (!thread) throw Error('Unknown synthetic thread');
      if (method === 'thread/read') return { thread: { id: thread.id, model: thread.model,
        modelProvider: 'code_ai', path: `/fixture/${thread.id}.jsonl`, status: { type: thread.idle ? 'idle' : 'active' } } };
      if (method === 'thread/queue/list') return { data: thread.queue || [] };
      if (method === 'thread/queue/delete') return { deleted: deleteResult };
      if (method === 'thread/turns/list') return { data: [{ id: thread.turnId || 'turn-' + thread.id, status: states.get(thread.id) }] };
      if (method === 'turn/interrupt') { if (terminalOnInterrupt) states.set(thread.id, 'interrupted'); return {}; }
      throw Error('Unexpected mutation: ' + method);
    },
    close() { closed = true; },
  };
}

test('native stop covers independent loaded parent/child turns and pending queues without histories or resumes', async () => {
  const instance = owner([
    { id: 'parent', model: 'gpt-6.1-sol', queue: [{ id: 'queued-one', input: [{ text: 'private-prompt-not-returned' }] }] },
    { id: 'child', model: 'gpt-6.1-sol' },
  ]);
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: blocked, connect: async () => instance, readTurnModel: async () => 'gpt-6.1-sol', confirmationMs: 0,
  });
  assert.equal(report.threadsSeen, 2);
  assert.deepEqual(report.confirmedTurns.map(turn => turn.threadId), ['parent', 'child']);
  assert.equal(report.deletedQueuedInputs.length, 1);
  assert.equal(report.pendingTurns.length, 0);
  assert.ok(!JSON.stringify(report).includes('private-prompt'));
  assert.ok(instance.closed);
  assert.ok(instance.calls.every(call => !['thread/resume', 'turn/start', 'thread/queue/add', 'thread/delete'].includes(call.method)));
});

test('current future Gemini settings do not exempt a running GPT turn, and exact Gemini turns remain untouched', async () => {
  const instance = owner([
    { id: 'gpt-actual', model: 'gemini-4-neon', queue: [{ id: 'future-gemini' }] },
    { id: 'gemini-actual', model: 'gpt-6.1-sol' },
  ]);
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: blocked, connect: async () => instance,
    readTurnModel: async filename => filename.includes('gpt-actual') ? 'gpt-6.1-sol' : 'gemini-4-neon', confirmationMs: 0,
  });
  assert.deepEqual(report.attemptedTurns.map(turn => turn.threadId), ['gpt-actual']);
  assert.deepEqual(report.apiTurnsSkipped.map(turn => turn.threadId), ['gemini-actual']);
  assert.equal(instance.calls.filter(call => call.method === 'thread/queue/delete').length, 0);
});

test('unknown billing evidence stays pending; neither configured GPT nor guessed recency may authorize interruption', async () => {
  const instance = owner([{ id: 'unknown', model: 'gpt-6.1-sol' }]);
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: blocked, connect: async () => instance, readTurnModel: async () => null, confirmationMs: 0,
  });
  assert.equal(report.attemptedTurns.length, 0);
  assert.deepEqual(report.pendingTurns, [{ threadId: 'unknown', turnId: 'turn-unknown', reason: 'billing-model-unavailable' }]);
  assert.ok(!instance.calls.some(call => call.method === 'turn/interrupt'));
});

test('successful interrupt acknowledgement cannot manufacture a terminal result; queue dispatch races stay pending', async () => {
  const instance = owner([{ id: 'active', model: 'gpt-6.1-sol', queue: [{ id: 'already-dispatched' }] }], {
    terminalOnInterrupt: false, deleteResult: false,
  });
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: blocked, connect: async () => instance, readTurnModel: async () => 'gpt-6.1-sol', confirmationMs: 0,
  });
  assert.equal(report.attemptedTurns.length, 1);
  assert.equal(report.confirmedTurns.length, 0);
  assert.equal(report.pendingTurns[0].reason, 'terminal-status-unconfirmed');
  assert.equal(report.pendingQueuedInputs.length, 1);
  assert.equal(report.deletedQueuedInputs.length, 0);
});

test('a concurrent user release prevents all subsequent native mutations', async () => {
  const instance = owner([{ id: 'active', model: 'gpt-6.1-sol', queue: [{ id: 'next' }] }]);
  let checks = 0;
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: async () => ++checks === 1, connect: async () => instance,
    readTurnModel: async () => 'gpt-6.1-sol', confirmationMs: 0,
  });
  assert.equal(report.deletedQueuedInputs.length, 0);
  assert.equal(report.attemptedTurns.length, 0);
  assert.ok(!instance.calls.some(call => ['turn/interrupt', 'thread/queue/delete'].includes(call.method)));
  assert.ok(instance.closed);
});

test('native connection errors are sanitized and disabled/non-Codex policies make no connection', async () => {
  let connections = 0;
  const connect = async () => { connections++; throw Error('/private/path account-secret'); };
  const disabled = await stopNativeSubscriptionTurns(profile, { isBlocked: async () => false, connect });
  assert.equal(disabled.errors.length, 0);
  await stopNativeSubscriptionTurns({ ...profile, provider: 'gemini' }, { isBlocked: blocked, connect });
  assert.equal(connections, 0);
  const failed = await stopNativeSubscriptionTurns(profile, { isBlocked: blocked, connect });
  assert.equal(failed.errors[0].code, 'NATIVE_QUOTA_STOP_UNAVAILABLE');
  assert.ok(!JSON.stringify(failed).includes('account-secret'));
});

test('loaded thread pagination includes later pages and repeated cursors fail truthfully', async () => {
  const instance = owner([{ id: 'first', model: 'gpt-6.1-sol' }, { id: 'last', model: 'gpt-6.1-sol' }]);
  const original = instance.rpc;
  instance.rpc = async (method, params) => method === 'thread/loaded/list'
    ? params.cursor ? { data: ['last'], nextCursor: null } : { data: ['first'], nextCursor: 'next' }
    : original(method, params);
  const report = await stopNativeSubscriptionTurns(profile, {
    isBlocked: blocked, connect: async () => instance, readTurnModel: async () => 'gpt-6.1-sol', confirmationMs: 0,
  });
  assert.equal(report.confirmedTurns.length, 2);
  instance.rpc = async () => ({ data: [], nextCursor: 'repeat' });
  const cyclic = await stopNativeSubscriptionTurns(profile, { isBlocked: blocked, connect: async () => instance });
  assert.equal(cyclic.errors[0].stage, 'owner-inspection');
});

test('rollout model evidence is exact-turn scoped and observes later model changes without reading tool content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-rollout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'rollout.jsonl');
  const context = (turn, model) => JSON.stringify({ type: 'turn_context', payload: { turn_id: turn, model } }) + '\n';
  await writeFile(filename, context('old-turn', 'gemini-4-neon') + context('active-turn', 'gpt-6.1-sol')
    + JSON.stringify({ type: 'response_item', payload: { content: 'private-'.repeat(100000) } }) + '\n');
  assert.equal(await readNativeQuotaTurnModel(filename, 'active-turn'), 'gpt-6.1-sol');
  assert.equal(await readNativeQuotaTurnModel(filename, 'missing-turn'), null);
  await appendFile(filename, context('active-turn', 'gemini-4-carbon'));
  assert.equal(await readNativeQuotaTurnModel(filename, 'active-turn'), 'gemini-4-carbon');
  await writeFile(filename, context('replacement-turn', 'gpt-6.1-sol'));
  assert.equal(await readNativeQuotaTurnModel(filename, 'active-turn'), null);
  assert.equal(await readNativeQuotaTurnModel(filename, 'replacement-turn'), 'gpt-6.1-sol');
});

test('a metadata line split across reads is not mistaken for evidence until fully persisted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-rollout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'rollout.jsonl');
  const line = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'active', model: 'gpt-6.1-sol' } });
  await writeFile(filename, line.slice(0, 20));
  assert.equal(await readNativeQuotaTurnModel(filename, 'active'), null);
  await appendFile(filename, line.slice(20) + '\n');
  assert.equal(await readNativeQuotaTurnModel(filename, 'active'), 'gpt-6.1-sol');
});

test('default connector verifies the canonical owner identity through a disposable local socket', async t => {
  if (process.platform === 'win32') { t.skip('Unix socket contract'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-owner-'));
  const home = path.join(root, 'home');
  const directory = path.join(home, 'code-ai-shared-owner');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const socket = path.join(directory, 'owner.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const methods = [];
  wss.on('connection', client => client.on('message', bytes => {
    const value = JSON.parse(bytes.toString()); methods.push(value.method);
    if (value.id !== undefined) client.send(JSON.stringify({ id: value.id,
      result: value.method === 'initialize' ? { codexHome: home } : { data: [] } }));
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { for (const client of wss.clients) client.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const connection = await connectNativeQuotaOwner({ codexHome: await realpath(home) });
  assert.deepEqual(await connection.rpc('thread/loaded/list', {}), { data: [] });
  connection.close();
  assert.ok(methods.includes('initialize'));
  assert.ok(!methods.includes('thread/resume'));
});
