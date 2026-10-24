// Native ownership proof with synthetic history only; never requests a model turn.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat, realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const bridgePath = process.argv[3];
const WebSocket = bridgePath ? null : (await import('ws')).default;

const bin = process.argv[2];
if (!bin) throw new Error('An explicit Codex binary is required');
const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-writer-'));
const home = path.join(root, 'codex');
const cwd = path.join(root, 'workspace');
const socketPath = path.join(root, 'control.sock');
const id = randomUUID();
const timestamp = new Date().toISOString();
await mkdir(path.join(home, 'sessions/2026/10/09'), { recursive: true });
await mkdir(cwd);
await writeFile(path.join(home, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "read-only"\n');
await writeFile(path.join(home, 'sessions/2026/10/09', `rollout-${id}.jsonl`), [
  { timestamp, type: 'session_meta', payload: { id, timestamp, cwd, originator: 'code_ai_isolated_test', cli_version: '0.162.0', source: 'cli', model_provider: 'openai' } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic stored history. No model turn is requested.' }] } },
].map(x => JSON.stringify(x)).join('\n') + '\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root });
const child = spawn(bin, ['app-server', '--listen', `unix://${socketPath}`], { cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.resume();
let childError = false;
child.on('error', () => { childError = true; });
const sockets = [];
const adapters = [];
let initializationMetadata;

async function stdioClient() {
  const adapter = spawn(process.execPath, [bridgePath, socketPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  adapters.push(adapter);
  adapter.stderr.resume();
  let next = 0, buffer = '';
  const pending = new Map();
  adapter.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const call = pending.get(frame.id);
      if (!call) continue;
      pending.delete(frame.id); clearTimeout(call.timer);
      call.resolve(frame.error ? { ok: false, conflict: /writer|thread.store conflict/i.test(frame.error.message || ''), code: frame.error.code } : { ok: true, result: frame.result });
    }
  });
  const fail = () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Fixture adapter closed')); }
    pending.clear();
  };
  adapter.on('close', fail); adapter.on('error', fail); adapter.stdin.on('error', fail);
  const call = (method, params) => new Promise((resolve, reject) => {
    const rpcId = ++next;
    pending.set(rpcId, { resolve, reject, timer: setTimeout(() => { pending.delete(rpcId); reject(new Error('Fixture request timed out: ' + method)); }, 10_000) });
    adapter.stdin.write(JSON.stringify({ id: rpcId, method, params }) + '\n');
  });
  const initialized = await call('initialize', { clientInfo: { name: 'code-ai-shared-writer-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  if (!initialized.ok) throw new Error('Fixture initialization failed');
  adapter.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  return { call, close: () => adapter.stdin.end() };
}

async function client() {
  if (bridgePath) return stdioClient();
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5_000 });
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Fixture socket did not open'))); });
  let next = 0;
  const pending = new Map();
  ws.on('message', data => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    const call = pending.get(frame.id);
    if (!call) return;
    pending.delete(frame.id); clearTimeout(call.timer);
    call.resolve(frame.error ? { ok: false, conflict: /writer|thread.store conflict/i.test(frame.error.message || ''), code: frame.error.code } : { ok: true, result: frame.result });
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const rpcId = ++next;
    pending.set(rpcId, { resolve, timer: setTimeout(() => { pending.delete(rpcId); reject(new Error('Fixture request timed out: ' + method)); }, 10_000) });
    ws.send(JSON.stringify({ id: rpcId, method, params }));
  });
  const result = await call('initialize', { clientInfo: { name: 'code-ai-shared-writer-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  if (!result.ok) throw new Error('Fixture initialization failed');
  initializationMetadata = { ownerHomeReturned: typeof result.result?.codexHome === 'string',
    ownerHomeMatches: result.result?.codexHome === home,
    socketUidMatches: (await lstat(socketPath)).uid === process.getuid(),
    parentPrivate: ((await lstat(root)).mode & 0o077) === 0,
    targetParentPrivate: ((await lstat(path.dirname(await realpath(socketPath)))).mode & 0o077) === 0 };
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  return { call, close: () => ws.close() };
}

try {
  const deadline = Date.now() + 10_000;
  while (!await stat(socketPath).then(s => s.isSocket(), () => false)) {
    if (childError || child.exitCode !== null || Date.now() > deadline) throw new Error('Fixture server did not become ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const params = { threadId: id, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' };
  const a = await client();
  const first = await a.call('thread/resume', params);
  const b = await client();
  const second = await b.call('thread/resume', params);
  a.close();
  const afterDisconnect = await b.call('thread/resume', params);
  const c = await client();
  const reconnected = await c.call('thread/resume', params);
  console.log(JSON.stringify({ fixtureOnly: true, modelTurnsRequested: 0, liveCredentialsRead: false,
    firstResume: first.ok, secondResume: second.ok,
    sameThreadIdReturned: first.ok && second.ok && first.result.thread.id === second.result.thread.id,
    remainingClientAfterDisconnect: afterDisconnect.ok, reconnectedClient: reconnected.ok,
    oneNativeOwner: true, stdioAdapter: Boolean(bridgePath), listener: 'private Unix socket', initializationMetadata }));
} finally {
  for (const ws of sockets) ws.terminate();
  for (const adapter of adapters) adapter.kill('SIGTERM');
  // Kill only our own synthetic fixture. Never stop a live daemon or user application.
  const killFixture = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  killFixture('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null || childError) return resolve();
    const timer = setTimeout(() => { killFixture('SIGKILL'); resolve(); }, 2_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
