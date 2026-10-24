import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { configMatchesOverrides, parseAppServerArguments } from './codex-shared-cli.mjs';

const cli = fileURLToPath(new URL('./codex-shared-cli.mjs', import.meta.url));
const flags = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled',
  '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false',
  '-c', 'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=false'];
const config = {
  features: { code_mode_host: true },
  plugins: {
    'codex-app-tools@openai-bundled': { mcp_servers: { codex_app: { enabled: false } } },
    'code-review@openai-bundled': { mcp_servers: { 'code-review': { enabled: false } } },
  },
};

test('exact observed GUI startup flags are retained as boolean requirements', () => {
  const parsed = parseAppServerArguments(flags);
  assert.equal(parsed.overrides.size, 3);
  assert.equal(configMatchesOverrides(config, parsed.overrides), true);
  assert.equal(configMatchesOverrides({ ...config, features: { code_mode_host: false } }, parsed.overrides), false);
  assert.equal(configMatchesOverrides({}, parsed.overrides), false);
});

test('CLI version and schema/version helpers delegate; server transport is never inferred', () => {
  assert.equal(parseAppServerArguments(['--version']), null);
  assert.equal(parseAppServerArguments(['app-server', 'generate-ts', '--out', '/tmp/fixture']), null);
  assert.equal(parseAppServerArguments(['app-server', 'daemon', 'version']), null);
  assert.equal(parseAppServerArguments(['app-server', '--listen', 'stdio://']).overrides.size, 0);
  assert.throws(() => parseAppServerArguments(['app-server', '--listen', 'unix://']), /Unsupported/);
  assert.throws(() => parseAppServerArguments(['app-server', 'daemon', 'start']), /Unsupported/);
});

test('app-server text inside another command or a configuration value delegates unchanged', () => {
  assert.equal(parseAppServerArguments(['exec', 'app-server']), null);
  assert.equal(parseAppServerArguments(['exec', '--', 'app-server']), null);
  assert.equal(parseAppServerArguments(['-c', 'app-server', '--version']), null);
  assert.equal(parseAppServerArguments(['-c', 'features.code_mode_host=true', 'exec', 'app-server']), null);
  assert.equal(parseAppServerArguments(['--model', 'app-server', 'exec', 'fixture-prompt']), null);
  assert.equal(parseAppServerArguments(['--enable', 'some-feature', 'exec', 'app-server']), null);
  assert.throws(() => parseAppServerArguments(['--enable', 'some-feature', 'app-server']), /Unsupported/);
  assert.throws(() => parseAppServerArguments(['--model', 'some-model', 'app-server']), /Unsupported/);
  assert.equal(parseAppServerArguments(['--config', 'features.code_mode_host=true', 'app-server']).overrides.size, 1);
});

test('unknown, duplicate and nonboolean configuration is refused rather than dropped', () => {
  for (const extra of [
    ['-c', 'some_private_key="do-not-echo"'],
    ['-c', 'model="mock-model"'],
    ['-c', 'features.code_mode_host="true"'],
    ['-c', 'features.code_mode_host=true'],
    ['--code-mode-host', 'wss://private.example'],
  ]) assert.throws(() => parseAppServerArguments([...flags, ...extra]), /Unsupported/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-cli-test-'));
  const home = path.join(root, 'codex'); await mkdir(home);
  const socket = path.join(root, 'owner.sock');
  const server = createServer(); const wss = new WebSocketServer({ server });
  let advertisedHome = home, advertisedConfig = structuredClone(config), ownerRequests = [], turns = 0;
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw.toString()); ownerRequests.push(frame.method);
    if (frame.method === 'initialize') ws.send(JSON.stringify({ id: frame.id, result: { codexHome: advertisedHome } }));
    else if (frame.method === 'config/read') ws.send(JSON.stringify({ id: frame.id, result: { config: advertisedConfig } }));
    else if (frame.method === 'thread/resume') ws.send(JSON.stringify({ id: frame.id, result: { thread: { id: frame.params.threadId } } }));
    else if (frame.method === 'turn/start') turns++;
  }));
  server.listen(socket); await once(server, 'listening');
  const children = [];
  const start = (args = flags, env = {}) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, CODEX_HOME: home, CODE_AI_CODEX_NATIVE_BIN: process.execPath,
      CODE_AI_CODEX_SHARED_SOCKET: socket, ...env,
    } });
    children.push(child);
    let stdout = '', stderr = '', buffer = ''; const responses = [];
    child.stdout.on('data', bytes => {
      stdout += bytes; buffer += bytes;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { responses.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.on('error', () => {});
    return { child, closed: once(child, 'close'), stdout: () => stdout, stderr: () => stderr, responses };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : once(child, 'close')));
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, start, ownerRequests, turns: () => turns,
    changeHome: value => { advertisedHome = value; }, changeConfig: value => { advertisedConfig = value; } };
}

test('version uses original native executable without opening an owner connection', async t => {
  const f = await fixture(t), c = f.start(['--version']);
  assert.equal((await c.closed)[0], 0);
  assert.equal(c.stdout().trim(), process.version);
  assert.equal(c.stderr(), ''); assert.equal(f.ownerRequests.length, 0);
});

test('GUI server is a shared client and EOF does not stop the native owner', async t => {
  const f = await fixture(t), c = f.start();
  c.child.stdin.write(JSON.stringify({ id: 81, method: 'initialize', params: {} }) + '\n');
  c.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  c.child.stdin.write(JSON.stringify({ id: 82, method: 'thread/resume', params: { threadId: 'fixture-only' } }) + '\n');
  const deadline = Date.now() + 5_000;
  while (!c.responses.some(x => x.id === 82)) {
    if (Date.now() > deadline) assert.fail('Fixture response timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(c.responses.find(x => x.id === 82).result.thread.id, 'fixture-only');
  c.child.stdin.end(); assert.equal((await c.closed)[0], 0);
  const other = f.start(['--version']); assert.equal((await other.closed)[0], 0);
  assert.equal(c.stderr(), ''); assert.equal(f.turns(), 0);
  assert.equal(f.ownerRequests.filter(x => x === 'initialize').length, 2);
  assert.equal(f.ownerRequests.filter(x => x === 'config/read').length, 1);
});

test('owner setting mismatch fails without passing GUI input or printing config', async t => {
  const f = await fixture(t);
  f.changeConfig({ ...config, features: { code_mode_host: false }, privateCredential: 'never-print-fixture' });
  const c = f.start();
  c.child.stdin.write(JSON.stringify({ id: 2, method: 'turn/start', params: { privateInput: 'never-print-fixture' } }) + '\n');
  assert.equal((await c.closed)[0], 1);
  assert.equal(c.stdout(), ''); assert.equal(c.stderr(), 'CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\n');
  assert.equal(f.turns(), 0);
});

test('unknown GUI config does not even connect and diagnostics remain fixed', async t => {
  const f = await fixture(t), c = f.start([...flags, '-c', 'credential="never-print-fixture"']);
  assert.equal((await c.closed)[0], 1); assert.equal(f.ownerRequests.length, 0);
  assert.equal(c.stderr(), 'CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\n'); assert.equal(c.stdout(), '');
});

test('nonprivate endpoint is refused without changing permissions or invoking native fallback', async t => {
  const f = await fixture(t); await chmod(f.root, 0o755); const c = f.start();
  assert.equal((await c.closed)[0], 1); assert.equal(f.ownerRequests.length, 0);
  assert.equal(c.stdout(), ''); assert.equal(c.stderr(), 'CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\n');
});

test('owner home mismatch is rejected before reading configuration or starting work', async t => {
  const f = await fixture(t); const wrong = path.join(f.root, 'other'); await mkdir(wrong); f.changeHome(wrong);
  const c = f.start(); assert.equal((await c.closed)[0], 1);
  assert.equal(f.ownerRequests.includes('config/read'), false); assert.equal(f.turns(), 0);
  assert.equal(c.stderr(), 'CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\n');
});
