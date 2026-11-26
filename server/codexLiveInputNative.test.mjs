import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectCodexLiveInput, CodexLiveInputNativeError } from './codexLiveInputNative.mjs';

async function frontend(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'li-native-'));
  const directory = home + '/code-ai-shared-owner'; await fs.mkdir(directory, { mode: 0o700 });
  const socket = directory + '/owner.sock', calls = [];
  const server = http.createServer(), wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.on('message', data => {
    const frame = JSON.parse(data.toString()); calls.push(frame);
    if (!frame.id) return;
    if (frame.method === 'initialize') {
      const result = { userAgent: 'code-ai/' + (options.version || '0.171.0') + ' (Fixture)', codexHome: home,
        codeAiSharedOwner: { version: 1, turnSettings: true, historyReads: 'canonical-v1' }, ...options.initialize };
      ws.send(JSON.stringify({ id: frame.id, result })); return;
    }
    const response = options.reply?.(frame);
    if (response === false) return;
    ws.send(JSON.stringify({ id: frame.id, ...(response || { result: { ok: true } }) }));
  }));
  await new Promise(resolve => server.listen(socket, resolve)); await fs.chmod(socket, 0o600);
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); await fs.rm(home, { recursive: true, force: true }); });
  return { home, socket, calls };
}

test('connects only the validated product frontend and exposes reads/CAS steer, never starts or cancels work', async t => {
  const f = await frontend(t), connection = await connectCodexLiveInput({ codexHome: f.home });
  t.after(() => connection.close());
  await connection.rpc('thread/read', { threadId: 'thread-one', includeTurns: false });
  await connection.rpc('turn/steer', { threadId: 'thread-one', expectedTurnId: 'turn-one', input: [{ type: 'text', text: 'neutral message' }] });
  for (const method of ['turn/start', 'turn/interrupt', 'thread/queue/add', 'thread/settings/update', 'thread/resume']) {
    await assert.rejects(connection.rpc(method, {}), error => error.code === 'NATIVE_METHOD_NOT_ALLOWED');
  }
  await assert.rejects(connection.rpc('turn/steer', { threadId: 'thread-one', input: [{type:'text',text:'neutral'}] }), error => error.code === 'NATIVE_CAS_REQUIRED');
  assert.deepEqual(f.calls.filter(f => f.id).map(f => f.method), ['initialize', 'thread/read', 'turn/steer']);
  assert.equal(f.calls[0].params.clientInfo.name, 'code-ai');
  assert.equal(f.calls[0].params.capabilities.experimentalApi, true);
});

for (const [name, options] of [
  ['old version', { version: '0.170.0' }],
  ['not the product broker', { initialize: { codeAiSharedOwner: undefined } }],
  ['no canonical history', { initialize: { codeAiSharedOwner: { version: 1, turnSettings: true } } }],
  ['wrong home', { initialize: { codexHome: '/does-not-exist-private-home' } }],
]) test('rejects ' + name + ' before any delivery or settings call', async t => {
  const f = await frontend(t, options);
  await assert.rejects(connectCodexLiveInput({ codexHome: f.home }), error => error instanceof CodexLiveInputNativeError);
  assert.deepEqual(f.calls.map(f => f.method), ['initialize']);
});

test('native rejection and ACK timeout are sanitized and never retried', async t => {
  const f = await frontend(t, { reply(frame) {
    if (frame.method === 'turn/steer') return { error: { code: -32600, message: 'PRIVATE_FOLLOWUP_NATIVE_ERROR', data: { codeAiAdmission: 'uncertain' } } };
    return false;
  } });
  const connection = await connectCodexLiveInput({ codexHome: f.home, requestTimeoutMs: 100 }); t.after(() => connection.close());
  await assert.rejects(connection.rpc('turn/steer', { threadId: 'thread-one', expectedTurnId: 'turn-one', input: [{ type: 'text', text: 'PRIVATE_FOLLOWUP' }] }), error => {
    assert.equal(error.nativeRejected, true); assert.equal(error.code, -32600);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_FOLLOWUP/); return true;
  });
  await assert.rejects(connection.rpc('thread/read', { threadId: 'thread-one' }), error => error.code === 'NATIVE_ACK_TIMEOUT');
  assert.equal(f.calls.filter(f => f.method === 'turn/steer').length, 1);
});

test('missing or public product socket directory does not fall back to a backend socket', async t => {
  const f = await frontend(t); await fs.chmod(path.dirname(f.socket), 0o755);
  await assert.rejects(connectCodexLiveInput({ codexHome: f.home }), error => error instanceof CodexLiveInputNativeError);
  assert.equal(f.calls.length, 0);
});
