import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { callSharedMode, createSharedModeBridge, nativeModeCall, modeError, modeFailure, modeServers, validateModeEndpoint } from './transport.mjs';
import { createModeContexts } from './contexts.mjs';
import { modeResult } from './results.mjs';

const uid = process.getuid(), gid = process.getgid();
const directory = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const call = (threadId, args = {}) => ({ name: 'probe', arguments: args, _meta: { threadId, itemId: 'synthetic-item' } });
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-mode-unit-'));
  const owned = path.join(root, 'owner'); await mkdir(owned, { mode: 0o700 });
  try { await run({ root, owned, socketPath: path.join(owned, 'modes.sock') }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function rpcFrontend(socketPath, catalogPath) {
  const child = spawn(process.execPath, [path.join(directory, 'mcp.mjs'), '--server', 'design_mode', '--socket', socketPath, '--catalog', catalogPath],
    { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let sequence = 0; const pending = new Map();
  const input = readline.createInterface({ input: child.stdout });
  input.on('line', line => { const frame = JSON.parse(line), waiter = pending.get(frame.id);
    if (waiter) { pending.delete(frame.id); clearTimeout(waiter.timer); waiter.resolve(frame); } });
  child.on('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Synthetic frontend exited')); } pending.clear(); });
  return { child, async close() { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); },
    request(method, params = {}) { return new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject, timer: setTimeout(() => reject(new Error('Synthetic frontend timed out')), 3000) });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }); } };
}

test('routing trusts only native metadata, never model-supplied identity arguments', () => {
  const routed = nativeModeCall('design_mode', call('thread-A', { nativeThreadId: 'thread-B', profileId: 'another-profile', sessionKey: 'thread-B' }));
  assert.equal(routed.nativeThreadId, 'thread-A'); assert.equal(routed.nativeItemId, 'synthetic-item');
  assert.equal(routed.toolName, 'probe'); assert.equal(routed.server, 'design_mode');
});
test('missing, malformed or argument-only metadata is denied before any bridge access', async () => {
  for (const params of [{ name: 'probe' }, { name: 'probe', arguments: { _meta: { threadId: 'thread-A' } } },
    { name: 'probe', _meta: { threadId: '../thread-A' } }, { name: 'probe', _meta: { threadId: 'thread-A' }, arguments: [] }]) {
    assert.throws(() => nativeModeCall('design_mode', params), { code: 'MODE_UNBOUND' });
    await assert.rejects(callSharedMode('/unavailable/never-accessed.sock', 'design_mode', params), { code: 'MODE_UNBOUND' });
  }
  assert.throws(() => nativeModeCall('unregistered_mode', call('thread-A')), { code: 'MODE_UNBOUND' });
});
test('errors contain only a bounded fixed error code, not arguments or error messages', () => {
  const serialized = JSON.stringify(modeFailure(new Error('synthetic private value')));
  assert.ok(!serialized.includes('synthetic private')); assert.ok(serialized.includes('MODE_TOOL_FAILED'));
  assert.equal(modeFailure(modeError('MODE_UNBOUND')).structuredContent.error_code, 'MODE_UNBOUND');
  assert.equal(modeFailure(modeError('unsafe error text')).structuredContent.error_code, 'MODE_TOOL_FAILED');
});
test('concurrent two-thread calls resolve independently and reject unknown children', () => fixture(async ({ socketPath }) => {
  const active = new Map([['thread-A', { target: 'fixture-A', enabled: true, revision: 1 }], ['thread-B', { target: 'fixture-B', enabled: true, revision: 1 }]]);
  const dispatched = [];
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async request => {
    const binding = active.get(request.nativeThreadId); if (!binding) throw modeError('MODE_UNBOUND');
    if (!binding.enabled) throw modeError('MODE_DISABLED');
    await new Promise(done => setTimeout(done, request.nativeThreadId === 'thread-A' ? 15 : 1));
    dispatched.push(binding.target); return result({ target: binding.target, revision: binding.revision });
  } });
  try {
    const [a, b] = await Promise.all([
      callSharedMode(socketPath, 'design_mode', call('thread-A', { claimedThreadId: 'thread-B' })),
      callSharedMode(socketPath, 'design_mode', call('thread-B', { claimedThreadId: 'thread-A' })),
    ]);
    assert.equal(a.structuredContent.target, 'fixture-A'); assert.equal(b.structuredContent.target, 'fixture-B');
    assert.deepEqual(dispatched.sort(), ['fixture-A', 'fixture-B']);
    const child = await callSharedMode(socketPath, 'design_mode', call('unknown-native-child'));
    assert.equal(child.structuredContent.error_code, 'MODE_UNBOUND'); assert.equal(dispatched.length, 2);
    active.get('thread-A').enabled = false;
    assert.equal((await callSharedMode(socketPath, 'design_mode', call('thread-A'))).structuredContent.error_code, 'MODE_DISABLED');
    active.delete('thread-B');
    assert.equal((await callSharedMode(socketPath, 'design_mode', call('thread-B'))).structuredContent.error_code, 'MODE_UNBOUND');
    assert.equal(dispatched.length, 2);
  } finally { await bridge.close(); }
}));
test('endpoint is same-user owner-only and reconnects at the same stable path after backend replacement', () => fixture(async ({ socketPath }) => {
  const first = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({ backend: 1 }) });
  await validateModeEndpoint(socketPath); assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await callSharedMode(socketPath, 'phone_mode', call('thread-A'))).structuredContent.backend, 1);
  await first.close(); await assert.rejects(callSharedMode(socketPath, 'phone_mode', call('thread-A')), { code: 'MODE_UNAVAILABLE' });
  const next = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({ backend: 2 }) });
  try { assert.equal((await callSharedMode(socketPath, 'phone_mode', call('thread-A'))).structuredContent.backend, 2); }
  finally { await next.close(); }
}));
test('unproven pre-existing endpoint is never deleted or replaced', () => fixture(async ({ socketPath }) => {
  await writeFile(socketPath, 'synthetic occupied endpoint', { mode: 0o600 });
  await assert.rejects(createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) }), { code: 'MODE_ENDPOINT_BUSY' });
  assert.equal(await readFile(socketPath, 'utf8'), 'synthetic occupied endpoint');
}));
test('live exact-custody endpoint is never taken over, and close is idempotent', () => fixture(async ({ socketPath }) => {
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) });
  await assert.rejects(createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) }), { code: 'MODE_ENDPOINT_BUSY' });
  assert.equal((await lstat(`${socketPath}.custody.json`)).mode & 0o777, 0o600);
  await Promise.all([bridge.close(), bridge.close()]);
  await assert.rejects(lstat(`${socketPath}.custody.json`), { code: 'ENOENT' });
}));
async function deadSyntheticOwner(socketPath) {
  const script = `import { createSharedModeBridge } from ${JSON.stringify(new URL('./transport.mjs', import.meta.url).href)};
    await createSharedModeBridge({ socketPath: ${JSON.stringify(socketPath)}, uid: process.getuid(), gid: process.getgid(),
      resolve: async () => ({ content: [{ type: 'text', text: 'Synthetic owner' }] }) });
    process.stdout.write('SYNTHETIC_OWNER_READY\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  try {
    const [bytes] = await once(child.stdout, 'data'); assert.ok(bytes.toString().includes('SYNTHETIC_OWNER_READY'));
    child.kill('SIGKILL'); await once(child, 'exit');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
}
test('proven dead synthetic bridge owner recovers only its exact private inode and PID incarnation', () => fixture(async ({ socketPath }) => {
  await deadSyntheticOwner(socketPath);
  const old = await lstat(socketPath); assert.ok(old.isSocket());
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({ recovered: true }) });
  try {
    assert.equal((await callSharedMode(socketPath, 'design_mode', call('thread-A'))).structuredContent.recovered, true);
    const custody = JSON.parse(await readFile(`${socketPath}.custody.json`, 'utf8'));
    assert.equal(custody.pid, process.pid); assert.equal(custody.ino, (await lstat(socketPath)).ino);
  } finally { await bridge.close(); }
}));
test('mismatched dead-owner custody never removes an unproven stale socket', () => fixture(async ({ socketPath }) => {
  await deadSyntheticOwner(socketPath);
  const marker = JSON.parse(await readFile(`${socketPath}.custody.json`, 'utf8'));
  marker.ino += 1; await writeFile(`${socketPath}.custody.json`, JSON.stringify(marker), { mode: 0o600 });
  const old = await lstat(socketPath);
  await assert.rejects(createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) }), { code: 'MODE_ENDPOINT_BUSY' });
  assert.equal((await lstat(socketPath)).ino, old.ino);
}));
test('public or symlinked endpoint parent and public socket permissions are rejected', () => fixture(async ({ root, owned, socketPath }) => {
  await chmod(owned, 0o755);
  await assert.rejects(createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) }), { code: 'MODE_ENDPOINT_INVALID' });
  await chmod(owned, 0o700);
  const link = path.join(root, 'owner-alias'); await symlink(owned, link);
  await assert.rejects(createSharedModeBridge({ socketPath: path.join(link, 'modes.sock'), uid, gid, resolve: async () => result({}) }), { code: 'MODE_ENDPOINT_INVALID' });
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({}) });
  try {
    await chmod(socketPath, 0o666);
    await assert.rejects(callSharedMode(socketPath, 'ux_mode', call('thread-A')), { code: 'MODE_UNAVAILABLE' });
    await chmod(socketPath, 0o600);
    await assert.rejects(validateModeEndpoint(socketPath, uid + 1), { code: 'MODE_ENDPOINT_INVALID' });
  } finally { await bridge.close(); }
}));
test('bridge close preserves an already accepted operation and drops idle connections', () => fixture(async ({ socketPath }) => {
  let release, started; const accepted = new Promise(done => { started = done; });
  const gate = new Promise(done => { release = done; });
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => { started(); await gate; return result({ completed: true }); } });
  const idle = net.createConnection(socketPath); await once(idle, 'connect'); idle.on('error', () => undefined);
  const request = callSharedMode(socketPath, 'browser_mode', call('thread-A')); await accepted;
  let closed = false; const closing = bridge.close().then(() => { closed = true; });
  await new Promise(done => setTimeout(done, 15)); assert.equal(closed, false);
  release(); assert.equal((await request).structuredContent.completed, true); await closing;
  idle.destroy(); assert.equal(closed, true);
}));
test('model payload bound is enforced before transport and response bound rejects oversized results', () => fixture(async ({ socketPath }) => {
  const bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result('x'.repeat(8 * 1024 * 1024)) });
  try {
    await assert.rejects(callSharedMode(socketPath, 'phone_mode', call('thread-A', { text: 'x'.repeat(8 * 1024 * 1024) })), { code: 'MODE_PAYLOAD_TOO_LARGE' });
    assert.equal((await callSharedMode(socketPath, 'phone_mode', call('thread-A'))).structuredContent.error_code, 'MODE_PAYLOAD_TOO_LARGE');
  } finally { await bridge.close(); }
}));
test('private context metadata supports source profiles, revocation, persistence and concurrent updates without secrets', () => fixture(async ({ owned }) => {
  const contexts = await createModeContexts(owned, uid, gid);
  await Promise.all([
    contexts.set('thread-A', { personal_chrome: { profileId: 'source-profile', sessionKey: 'source-thread-A' } }),
    contexts.set('thread-B', { phone_mode: { profileId: 'another-source', sessionKey: 'source-thread-B' }, design_mode: null }),
  ]);
  assert.deepEqual(contexts.get('thread-A', 'personal_chrome'), { profileId: 'source-profile', sessionKey: 'source-thread-A' });
  assert.equal(contexts.get('thread-B', 'design_mode'), null); assert.equal(contexts.get('thread-A', 'phone_mode'), undefined);
  const reloaded = await createModeContexts(owned, uid, gid);
  assert.deepEqual(reloaded.get('thread-B', 'phone_mode'), { profileId: 'another-source', sessionKey: 'source-thread-B' });
  const publicMetadata = await readFile(path.join(owned, 'mode-contexts.json'), 'utf8');
  assert.equal((await lstat(path.join(owned, 'mode-contexts.json'))).mode & 0o777, 0o600);
  assert.ok(!/token|password|controlUrl|arguments/.test(publicMetadata));
  assert.throws(() => contexts.set('thread-A', { phone_mode: { profileId: 'x', sessionKey: 'y', token: 'synthetic forbidden field' } }), { code: 'MODE_CONTEXT_INVALID' });
  assert.throws(() => contexts.set('thread-A', { another_mode: null }), { code: 'MODE_CONTEXT_INVALID' });
  await contexts.set('thread-A', { personal_chrome: null }); assert.equal(contexts.get('thread-A', 'personal_chrome'), null);
}));
test('context registry rejects public, symlinked and malformed files', () => fixture(async ({ owned, root }) => {
  const filename = path.join(owned, 'mode-contexts.json');
  await writeFile(filename, '{}', { mode: 0o600 });
  await assert.rejects(createModeContexts(owned, uid, gid), { code: 'MODE_CONTEXT_INVALID' });
  await chmod(filename, 0o644);
  await assert.rejects(createModeContexts(owned, uid, gid), { code: 'MODE_CONTEXT_INVALID' });
  await rm(filename); const target = path.join(root, 'synthetic.json'); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, filename);
  await assert.rejects(createModeContexts(owned, uid, gid), { code: 'MODE_CONTEXT_INVALID' });
}));
test('proven post-run metadata relocation is exact, concurrent and cannot change profile or target native thread', () => fixture(async ({ owned }) => {
  const contexts = await createModeContexts(owned, uid, gid);
  await contexts.set('thread-A', { phone_mode: { profileId: 'source-profile', sessionKey: 'draft-A' },
    personal_chrome: { profileId: 'source-profile', sessionKey: 'draft-A' } });
  const previous = { profileId: 'source-profile', sessionKey: 'draft-A' }, actual = { profileId: 'source-profile', sessionKey: 'thread-A' };
  assert.deepEqual(await Promise.all([
    contexts.relocate('thread-A', 'phone_mode', previous, actual),
    contexts.relocate('thread-A', 'personal_chrome', previous, actual),
  ]), [true, true]);
  assert.deepEqual(contexts.get('thread-A', 'phone_mode'), actual); assert.deepEqual(contexts.get('thread-A', 'personal_chrome'), actual);
  assert.equal(await contexts.relocate('thread-A', 'phone_mode', previous, actual), false);
  assert.throws(() => contexts.relocate('thread-A', 'phone_mode', actual, { profileId: 'another-profile', sessionKey: 'thread-A' }), { code: 'MODE_CONTEXT_INVALID' });
  assert.throws(() => contexts.relocate('thread-A', 'phone_mode', actual, { profileId: 'source-profile', sessionKey: 'thread-B' }), { code: 'MODE_CONTEXT_INVALID' });
}));
test('stdio frontend lists exact static catalog while backend is offline and reconnects without relaunch', () => fixture(async ({ owned, socketPath }) => {
  const tools = [{ name: 'probe', description: 'synthetic read-only', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];
  const catalogPath = path.join(owned, 'catalog.json'); await writeFile(catalogPath, JSON.stringify({ tools }), { mode: 0o600 });
  const frontend = rpcFrontend(socketPath, catalogPath); let bridge;
  try {
    assert.ok((await frontend.request('initialize', { protocolVersion: '2025-11-25' })).result.capabilities.tools);
    assert.deepEqual((await frontend.request('tools/list')).result.tools, tools);
    assert.equal((await frontend.request('tools/call', call('thread-A'))).result.structuredContent.error_code, 'MODE_UNAVAILABLE');
    assert.equal((await frontend.request('tools/call', { name: 'probe', arguments: { threadId: 'thread-A' } })).result.structuredContent.error_code, 'MODE_UNBOUND');
    assert.equal((await frontend.request('tools/call', { name: 'not_registered', _meta: { threadId: 'thread-A' } })).result.structuredContent.error_code, 'UNKNOWN_TOOL');
    bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async request => result({ actualThread: request.nativeThreadId }) });
    assert.equal((await frontend.request('tools/call', call('thread-A', { claimedThreadId: 'thread-B' }))).result.structuredContent.actualThread, 'thread-A');
    await bridge.close(); bridge = null;
    assert.equal((await frontend.request('tools/call', call('thread-A'))).result.structuredContent.error_code, 'MODE_UNAVAILABLE');
    bridge = await createSharedModeBridge({ socketPath, uid, gid, resolve: async () => result({ replacement: true }) });
    assert.equal((await frontend.request('tools/call', call('thread-A'))).result.structuredContent.replacement, true);
  } finally { await frontend.close(); if (bridge) await bridge.close(); }
}));
test('result conventions preserve Chrome and Phone image blocks and structured consultant data', () => {
  const chrome = modeResult('personal_chrome', { captured: true, imageDataUrl: 'data:image/png;base64,c3ludGhldGlj' });
  assert.equal(chrome.content[1].type, 'image'); assert.equal(chrome.content[1].mimeType, 'image/png');
  assert.ok(!chrome.content[0].text.includes('c3ludGhldGlj'));
  const phone = modeResult('phone_mode', { nested: { imageBase64: 'c3ludGhldGlj', mimeType: 'image/jpeg' } });
  assert.equal(phone.content[1].type, 'image'); assert.ok(phone.content[0].text.includes('image data omitted'));
  assert.ok(!phone.content[0].text.includes('c3ludGhldGlj'));
  for (const server of ['browser_mode', 'design_mode', 'ux_mode']) assert.deepEqual(modeResult(server, { fixture: true }).structuredContent, { fixture: true });
});
test('all retained mode catalogs are exported without mode credentials or third-party browser packages', async () => {
  const sourceRoot = path.dirname(directory);
  const frontends = {
    personal_chrome: ['personal-chrome/personal_chrome_mcp_server.mjs', process.execPath],
    phone_mode: ['phone-mode/phone_mode_mcp_server.mjs', process.execPath],
    design_mode: ['design-mode/design_mode_mcp_server.mjs', process.execPath],
    ux_mode: ['ux-mode/ux_mode_mcp_server.mjs', process.execPath],
    browser_mode: ['browser-mode/python/browser_mode_mcp_server.py', '/usr/bin/python3'],
  };
  for (const server of modeServers) {
    const [relative, command] = frontends[server];
    const { stdout, stderr } = await execute(command, [path.join(sourceRoot, relative), '--describe-tools'], {
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(stderr, ''); const catalog = JSON.parse(stdout);
    assert.ok(catalog.tools.length > 0); assert.ok(catalog.tools.every(tool => tool.name && tool.inputSchema));
    assert.equal(new Set(catalog.tools.map(tool => tool.name)).size, catalog.tools.length);
  }
});
