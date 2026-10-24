import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const bin = process.argv[2];
if (!bin) throw new Error('An explicit Codex binary is required');
const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-writer-contract-'));
const home = root + '/codex';
const cwd = root + '/workspace';
await mkdir(home + '/sessions/2026/10/09', { recursive: true });
await mkdir(cwd);
const id = randomUUID();
const timestamp = new Date().toISOString();
await writeFile(home + '/config.toml', 'approval_policy = "never"\nsandbox_mode = "read-only"\n');
await writeFile(home + '/sessions/2026/10/09/rollout-' + id + '.jsonl', [
  { timestamp, type: 'session_meta', payload: { id, timestamp, cwd, originator: 'code_ai_isolated_test', cli_version: '0.162.0', source: 'cli', model_provider: 'openai' } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic stored history. No model turn is requested.' }] } },
].map(x => JSON.stringify(x)).join('\n') + '\n');
const children = [];
function client(extra = []) {
  // No real credential store or live config is inherited by the fixture.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
  Object.assign(env, { CODEX_HOME: home, HOME: root });
  const child = spawn(bin, ['app-server', '--listen', 'stdio://', ...extra], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.resume();
  const pending = new Map();
  let next = 0;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.method && frame.id !== undefined) {
          child.stdin.write(JSON.stringify({ id: frame.id, result: { decision: 'decline' } }) + '\n');
        } else if (pending.has(frame.id)) {
          const call = pending.get(frame.id); pending.delete(frame.id); clearTimeout(call.timer);
          call.resolve(frame.error ? { ok: false, conflict: /writer|thread.store conflict/i.test(frame.error.message || ''), code: frame.error.code } : { ok: true, result: frame.result });
        }
      } catch {}
    }
  });
  child.on('error', () => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Fixture process failed')); }
    pending.clear();
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const rpcId = ++next;
    pending.set(rpcId, { resolve, reject, timer: setTimeout(() => { pending.delete(rpcId); reject(new Error('Fixture request timed out: ' + method)); }, 15_000) });
    child.stdin.write(JSON.stringify({ id: rpcId, method, params }) + '\n');
  });
  return { call, child, initialize: async () => {
    const result = await call('initialize', { clientInfo: { name: 'code-ai-writer-test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    if (!result.ok) throw new Error('Fixture initialization failed');
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  } };
}
try {
  const a = client(); await a.initialize();
  const first = await a.call('thread/resume', { threadId: id, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
  const b = client(); await b.initialize();
  const second = await b.call('thread/resume', { threadId: id, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
  console.log(JSON.stringify({ fixtureOnly: true, modelTurnsRequested: 0, liveCredentialsRead: false,
    firstResume: first.ok, firstConflict: first.conflict || false,
    separateProcessResume: second.ok, separateProcessConflict: second.conflict || false,
    sameThreadIdReturned: first.ok && second.ok && first.result.thread.id === second.result.thread.id }));
} finally {
  // These processes belong to this synthetic fixture, never to a user session.
  for (const child of children) child.stdin.end();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 1500);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  })));
}
