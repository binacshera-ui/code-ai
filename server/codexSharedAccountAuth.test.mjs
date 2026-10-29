import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { getSharedAccountCommand, runSharedAccountCommand } from './codexSharedAccountAuth.mjs';

test('shared account actions select the owner adapter; other profiles retain CLI login', () => {
  const previous = process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
  try {
    process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES = 'shared';
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const profile = { id: 'shared', codexHome: '/test-home' };
    const command = getSharedAccountCommand(profile, 'login', '/codex-cli', root);
    assert.equal(command.bin, process.execPath);
    assert.deepEqual(command.args.slice(1), ['--home', '/test-home', 'login']);
    assert.deepEqual(getSharedAccountCommand({ ...profile, id: 'other' }, 'login', '/codex-cli', root),
      { bin: '/codex-cli', args: ['login', '--device-auth'] });
    assert.deepEqual(getSharedAccountCommand({ ...profile, id: 'other' }, 'read', '/codex-cli', root),
      { bin: '/codex-cli', args: ['login', 'status'] });
    assert.equal(getSharedAccountCommand(profile,'login','/codex-cli','/missing-program').args[0],command.args[0], 'current runtime wins over a stale configured root');
  } finally {
    if (previous === undefined) delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
    else process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES = previous;
  }
});

async function fixture(t, handle, reportedHome, loadedThreads = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-account-test-'));
  const parent = path.join(home, 'code-ai-shared-owner');
  await mkdir(parent, { mode: 0o700 });
  const server = createServer(), sockets = new WebSocketServer({ server });
  const requests = [];
  sockets.on('connection', (ws) => ws.on('message', (bytes) => {
    const frame = JSON.parse(bytes.toString());
    if (frame.id === undefined) return;
    requests.push(frame);
    const reply = (result) => ws.send(JSON.stringify({ id: frame.id, result }));
    const notify = (params) => ws.send(JSON.stringify({ method: 'account/login/completed', params }));
    if (frame.method === 'initialize') reply({ codexHome: reportedHome || home });
    else if (frame.method === 'thread/loaded/list') reply({ data: loadedThreads, nextCursor: null });
    else handle(frame, reply, notify, ws);
  }));
  await new Promise((resolve) => server.listen(path.join(parent, 'owner.sock'), resolve));
  t.after(async () => { for (const ws of sockets.clients) ws.terminate(); await new Promise((r) => sockets.close(r));
    await new Promise((r) => server.close(r)); await rm(home, { recursive: true, force: true }); });
  return { home, requests };
}
const login = { type: 'chatgptDeviceCode', loginId: 'owned-login',
  verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' };

test('device login completes in the canonical owner, including a notification before the reply', async (t) => {
  const f = await fixture(t, (frame, reply, notify) => {
    if(frame.method==='account/read'){assert.equal(frame.params.refreshToken,false);reply({account:{type:'chatgpt'}});return;}
    assert.equal(frame.method, 'account/login/start');
    assert.deepEqual(frame.params, { type: 'chatgptDeviceCode' });
    notify({ loginId: 'another-login', success: false });
    notify({ loginId: login.loginId, success: true }); reply(login);
  });
  let prompt;
  await runSharedAccountCommand(f.home, 'login', { onPrompt: (value) => { prompt = value; } });
  assert.deepEqual(prompt, { verificationUrl: login.verificationUrl, userCode: login.userCode });
  assert.equal(f.requests.some((frame) => frame.method === 'account/login/cancel'), false);
});
test('successful login event without matching canonical account is not reported authenticated',async t=>{
 const f=await fixture(t,(frame,reply,notify)=>{if(frame.method==='account/login/start'){notify({loginId:login.loginId,success:true});reply(login);}else if(frame.method==='account/read')reply({account:null});else reply({});});
 await assert.rejects(runSharedAccountCommand(f.home,'login'),/account verification failed/);
 assert.equal(f.requests.at(-1).method,'account/login/cancel');
});

test('cancelling device login cancels its native login before disconnecting', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (frame, reply) => {
    if (frame.method === 'account/login/start') reply(login);
    else { assert.equal(frame.method, 'account/login/cancel'); assert.deepEqual(frame.params, { loginId: login.loginId }); reply({}); }
  });
  await assert.rejects(runSharedAccountCommand(f.home, 'login', {
    signal: controller.signal, onPrompt: () => controller.abort(),
  }), /cancelled/);
  assert.equal(f.requests.at(-1).method, 'account/login/cancel');
});

test('logout updates the persistent owner instead of only removing a cache file', async (t) => {
  const f = await fixture(t, (frame, reply) => { if(frame.method==='account/logout')reply({});else{assert.equal(frame.method,'account/read');reply({account:null});} });
  await runSharedAccountCommand(f.home, 'logout');
  assert.deepEqual(f.requests.map((frame) => frame.method), ['initialize', 'thread/loaded/list', 'account/logout', 'account/read']);
});

test('a mismatched canonical home is refused before changing account state', async (t) => {
  const f = await fixture(t, () => assert.fail('Account request must not be sent'), '/unrelated-home');
  await assert.rejects(runSharedAccountCommand(f.home, 'logout'), /owner mismatch/);
  assert.equal(f.requests.length, 1);
});

test('an interrupted owner connection reports failure without exposing native error context', async (t) => {
  const f = await fixture(t, (frame, reply, notify, ws) => { reply(login); setTimeout(() => ws.terminate(), 10); });
  await assert.rejects(runSharedAccountCommand(f.home, 'login'), /connection closed/);
});

test('logout ACK with an account still connected is not reported as disconnected',async t=>{
 const f=await fixture(t,(frame,reply)=>reply(frame.method==='account/read'?{account:{type:'chatgpt'}}:{}));
 await assert.rejects(runSharedAccountCommand(f.home,'logout'),/logout account verification failed/);
});

test('API login sends the selected credential to the same owner and verifies account mode without a device flow', async t => {
  let connected = false;
  const f = await fixture(t, (frame, reply) => {
    if (frame.method === 'account/read') return reply({ account: connected ? { type: 'apiKey' } : null });
    assert.equal(frame.method, 'account/login/start');
    assert.deepEqual(frame.params, { type: 'apiKey', apiKey: ('sk-' + 'synthetic-api-account-a') });
    connected = true;
    reply({ type: 'apiKey' }); // No loginId or account/login/completed event.
  });
  assert.deepEqual(await runSharedAccountCommand(f.home, 'api-key', { apiKey: ('sk-' + 'synthetic-api-account-a') }), { type: 'apiKey' });
  assert.deepEqual(f.requests.map(frame => frame.method), ['initialize', 'thread/loaded/list', 'account/read', 'account/login/start', 'account/read']);
});

test('API login requires explicit manual disconnection and never logs out an existing account', async t => {
  const f = await fixture(t, (frame, reply) => {
    assert.equal(frame.method, 'account/read'); reply({ account: { type: 'chatgpt' } });
  });
  await assert.rejects(runSharedAccountCommand(f.home, 'api-key', { apiKey: ('sk-' + 'synthetic-api-account-a') }), /Disconnect/);
  assert.equal(f.requests.some(frame => frame.method === 'account/login/start' || frame.method === 'account/logout'), false);
});

test('native account status is sanitized and independent from ChatGPT usage', async t => {
  const f = await fixture(t, (frame, reply) => reply({ account: { type: 'apiKey', unexpectedSecret: 'fixture-private' } }));
  const status = await runSharedAccountCommand(f.home, 'read');
  assert.deepEqual(status, { type: 'apiKey' });
  assert.equal(JSON.stringify(status).includes('fixture-private'), false);
});

test('a successful API login ACK cannot mask a mismatched account type', async t => {
  const f = await fixture(t, (frame, reply) => reply(frame.method === 'account/read' ? { account: null } : { type: 'apiKey' }));
  await assert.rejects(runSharedAccountCommand(f.home, 'api-key', { apiKey: ('sk-' + 'synthetic-api-account-a') }), /verification failed/);
});

test('API native rejection never exposes echoed credentials or HTTP error context', async t => {
  const secret = ('sk-' + 'synthetic-never-expose-me');
  const f = await fixture(t, (frame, reply, notify, ws) => {
    if (frame.method === 'account/read') return reply({ account: null });
    ws.send(JSON.stringify({ id: frame.id, error: { code: -1, message: `Rejected ${secret}` } }));
  });
  await assert.rejects(runSharedAccountCommand(f.home, 'api-key', { apiKey: secret }), error => !error.message.includes(secret));
});

test('manual auth refuses active native work without interrupting or replaying it', async t => {
  const f = await fixture(t, (frame, reply) => {
    assert.equal(frame.method, 'thread/read');
    assert.deepEqual(frame.params, { threadId: 'active-fixture', includeTurns: false });
    reply({ thread: { status: { type: 'active', activeFlags: [] } } });
  }, undefined, ['active-fixture']);
  for (const action of ['logout', 'api-key', 'login']) {
    await assert.rejects(runSharedAccountCommand(f.home, action, { apiKey: ('sk-' + 'synthetic-api-account-a') }), /active work/);
  }
  assert.equal(f.requests.some(frame => /^account\/(logout|login\/start)$/.test(frame.method)), false);
});
