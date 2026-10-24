import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const bridgePath = fileURLToPath(new URL('./codex-shared-stdio.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-stdio-test-'));
  const home = path.join(root, 'home');
  const wrongHome = path.join(root, 'wrong-home');
  await mkdir(home); await mkdir(wrongHome);
  const socketPath = path.join(root, 'owner.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let advertisedHome = home;
  let modelStarts = 0;
  let initializationBurst = false;
  wss.on('connection', ws => {
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.method === 'initialize') {
        if (initializationBurst) ws.send(JSON.stringify({ method: 'account/updated', params: {} }));
        ws.send(JSON.stringify({ id: frame.id, result: { codexHome: advertisedHome } }));
        if (initializationBurst) ws.send(JSON.stringify({ method: 'account/updated', params: {} }));
      }
      else if (frame.method === 'thread/resume') ws.send(JSON.stringify({ id: frame.id, result: { thread: { id: frame.params.threadId } } }));
      else if (frame.method === 'turn/start') modelStarts++;
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const children = [];
  const start = (overrides = {}) => {
    const child = spawn(process.execPath, [bridgePath, socketPath], { env: { PATH: process.env.PATH, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], ...overrides });
    children.push(child);
    let stderr = '', buffer = '', next = 0;
    const pending = new Map();
    const closed = once(child, 'close');
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const call = pending.get(frame.id);
        if (call) { pending.delete(frame.id); clearTimeout(call.timer); call.resolve(frame); }
      }
    });
    child.on('close', () => {
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Adapter closed')); }
      pending.clear();
    });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('Adapter test timeout')); }, 3_000) });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    return { child, request, closed, stderr: () => stderr };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : once(child, 'close')));
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, wrongHome, socketPath, start, modelStarts: () => modelStarts,
    setHome: value => { advertisedHome = value; }, enableInitializationBurst: () => { initializationBurst = true; } };
}

test('two stdio clients rejoin the same native owner; closing one never shuts it down', async t => {
  const f = await fixture(t);
  const a = f.start(), b = f.start();
  await Promise.all([a.request('initialize', {}), b.request('initialize', {})]);
  assert.deepEqual((await a.request('thread/resume', { threadId: 'one-thread' })).result.thread,
    (await b.request('thread/resume', { threadId: 'one-thread' })).result.thread);
  a.child.stdin.end();
  assert.equal((await a.closed)[0], 0);
  assert.equal((await b.request('thread/resume', { threadId: 'one-thread' })).result.thread.id, 'one-thread');
  b.child.stdin.end();
  assert.equal((await b.closed)[0], 0);
  assert.equal(f.modelStarts(), 0);
});

test('wrong CODEX_HOME fails closed before queued requests are forwarded', async t => {
  const f = await fixture(t);
  f.setHome(f.wrongHome);
  const client = f.start();
  const init = assert.rejects(client.request('initialize', {}), /Adapter closed/);
  const turn = assert.rejects(client.request('turn/start', {}), /Adapter closed/);
  await Promise.all([init, turn]);
  assert.equal((await client.closed)[0], 1);
  assert.equal(f.modelStarts(), 0);
  assert.equal(client.stderr(), 'CODE_AI_SHARED_TRANSPORT_UNAVAILABLE\n');
});

test('non-private socket directory is rejected without changing its mode', async t => {
  const f = await fixture(t);
  await chmod(f.root, 0o755);
  const client = f.start();
  assert.equal((await client.closed)[0], 1);
  assert.equal(client.stderr(), 'CODE_AI_SHARED_TRANSPORT_UNAVAILABLE\n');
  assert.equal(f.modelStarts(), 0);
});

test('a missing shared endpoint never falls back to a second native writer', async t => {
  const f = await fixture(t);
  // Use a nonexistent dedicated socket, not a listener on a different profile.
  const child = spawn(process.execPath, [bridgePath, path.join(f.root, 'absent.sock')],
    { env: { PATH: process.env.PATH, CODEX_HOME: f.home }, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  assert.equal((await once(child, 'close'))[0], 1);
  assert.equal(stderr, 'CODE_AI_SHARED_TRANSPORT_UNAVAILABLE\n');
  assert.equal(f.modelStarts(), 0);
});

test('malformed stdin is rejected without echoing private input', async t => {
  const f = await fixture(t);
  const client = f.start();
  await client.request('initialize', {});
  client.child.stdin.write('private-not-json\n');
  assert.equal((await client.closed)[0], 1);
  assert.equal(client.stderr(), 'CODE_AI_SHARED_TRANSPORT_UNAVAILABLE\n');
});

test('native initialize notification bursts cannot race asynchronous profile validation', async t => {
  const f = await fixture(t);
  f.enableInitializationBurst();
  const client = f.start();
  await client.request('initialize', {});
  assert.equal((await client.request('thread/resume', { threadId: 'same-thread' })).result.thread.id, 'same-thread');
  client.child.stdin.end();
  assert.equal((await client.closed)[0], 0);
  assert.equal(client.stderr(), '');
});
