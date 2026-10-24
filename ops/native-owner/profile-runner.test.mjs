import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const runner = fileURLToPath(new URL('./profile-runner.mjs', import.meta.url));
const modules = fileURLToPath(new URL('../../node_modules', import.meta.url));
const digest = source => createHash('sha256').update(source).digest('hex');

async function fixture(t, { nativeAlias = false, foreignAlias = false, initializeCloseDelayMs = 0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coa-or-'));
  const home = path.join(root, 'codex'), ownerDirectory = path.join(root, 'owner');
  await mkdir(home, { mode: 0o700 }); await mkdir(ownerDirectory, { mode: 0o700 }); await symlink(modules, path.join(root, 'node_modules'));
  const nativeBinary = path.join(root, 'native-fixture'), brokerModule = path.join(root, 'broker-fixture.mjs');
  const nativeTarget = nativeAlias ? (foreignAlias ? path.join(ownerDirectory, 'foreign.sock')
    : path.join(root, `codex-daemon-${process.getuid()}`, digest(root))) : null;
  if (nativeAlias) await mkdir(path.dirname(nativeTarget), { recursive: true, mode: 0o700 });
  const engineSource = `#!${process.execPath}\nconst{createServer}=require('node:http');const{WebSocketServer}=require('ws');const fs=require('node:fs');const path=require('node:path');const socket=process.argv.find(x=>x.startsWith('unix://')).slice(7);const target=${JSON.stringify(nativeTarget)};fs.writeFileSync(path.join(path.dirname(socket),'fixture-engine-started'),String(process.pid));const s=createServer();const w=new WebSocketServer({server:s});w.on('connection',c=>c.on('message',b=>{const f=JSON.parse(b);if(f.method==='initialize'){c.send(JSON.stringify({id:f.id,result:{codexHome:process.env.SYNTHETIC_WRONG_HOME||process.env.CODEX_HOME}}));if(${initializeCloseDelayMs})Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${initializeCloseDelayMs});}}));s.listen(target||socket,()=>{if(target)fs.symlinkSync(target,socket);});process.on('SIGTERM',()=>{for(const c of w.clients)c.terminate();w.close(()=>s.close(()=>process.exit(0)));});\n`;
  const brokerSource = `import{createServer}from'node:http';import{WebSocketServer}from'ws';export async function startCodexSharedOwnerBroker({socketPath,codexHome}){const s=createServer();const w=new WebSocketServer({server:s});w.on('connection',c=>c.on('message',b=>{const f=JSON.parse(b);if(f.method==='initialize')c.send(JSON.stringify({id:f.id,result:{codexHome}}));}));await new Promise(r=>s.listen(socketPath,r));return{close:async()=>{for(const c of w.clients)c.terminate();await new Promise(r=>w.close(r));await new Promise(r=>s.close(r));}}}\n`;
  await writeFile(nativeBinary, engineSource, { mode: 0o700 }); await writeFile(brokerModule, brokerSource);
  await chmod(nativeBinary, 0o700);
  const plan = { format: 'code-ai-native-owner-profile', version: 1, profileId: 'synthetic',
    userHome: root, codexHome: home, ownerDirectory, nativeBinary, nativeBinarySha256: digest(engineSource),
    nodeBinary: process.execPath, brokerModule, brokerModuleSha256: digest(brokerSource),
    dispatcherModule: path.join(root, 'dispatcher.mjs'), adapterModule: path.join(root, 'adapter.mjs'),
    runnerModule: runner, guiLauncherModule: path.join(root, 'gui-launcher.mjs'),
    frontendSocket: path.join(home, 'code-ai-shared-owner/owner.sock'), desktopExecutable: '/usr/bin/true',
    guiBooleanRequirements: { 'features.code_mode_host': true,
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true,
      'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled': true },
  };
  const planPath = path.join(ownerDirectory, 'profile.json'); const children = [];
  const start = async (overrides = {}, env = {}) => {
    await writeFile(planPath, JSON.stringify({ ...plan, ...overrides }), { mode: 0o600 });
    const child = spawn(process.execPath, [runner, planPath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ...env } }); children.push(child);
    let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    return { child, closed: once(child, 'close'), stdout: () => stdout, stderr: () => stderr };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : once(child, 'close')));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, ownerDirectory, nativeTarget, plan, start };
}

async function waitReady(f, c, timeoutMs = 5_000) {
  const readyPath = path.join(f.ownerDirectory, 'ready.json'); const deadline = Date.now() + timeoutMs;
  while (!await lstat(readyPath).then(() => true, () => false)) {
    if (c.child.exitCode !== null || Date.now() > deadline) assert.fail('Synthetic owner readiness timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return JSON.parse(await readFile(readyPath, 'utf8'));
}

test('pinned broker handoff reuses the live writer and preserves engine and lock inodes', async t => {
  const f = await fixture(t, { nativeAlias: true }), first = await f.start();
  const ready = await waitReady(f, first);
  const custodyPath = path.join(f.ownerDirectory, 'ownership.json');
  const bytes = await readFile(custodyPath), before = JSON.parse(bytes);
  const lock = await lstat(path.join(f.ownerDirectory, 'owner.lock'));
  const engine = await lstat(path.join(f.ownerDirectory, 'engine.sock'));
  // Kill only this fixture's adapter/lock holder, not its engine or process group.
  process.kill(before.runnerPid, 'SIGKILL'); await first.closed;
  t.after(() => { try { process.kill(ready.nativePid, 'SIGTERM'); } catch {} });
  await rm(path.join(f.ownerDirectory, 'ready.json'));
  const source = await readFile(f.plan.brokerModule, 'utf8') + '\n// Pinned fixture successor.\n';
  await writeFile(f.plan.brokerModule, source);
  const ticketPath = path.join(f.ownerDirectory, 'broker-handoff.json');
  await writeFile(ticketPath, JSON.stringify({ format: 'code-ai-broker-handoff', version: 1,
    custodySha256: digest(bytes), brokerModuleSha256: digest(source), runnerModuleSha256: digest(await readFile(runner)) }), { mode: 0o600 });
  const next = await f.start({ brokerModuleSha256: digest(source) });
  const afterReady = await waitReady(f, next);
  const after = JSON.parse(await readFile(custodyPath));
  assert.equal(afterReady.nativePid, ready.nativePid);
  assert.deepEqual(after.nativeIdentity, before.nativeIdentity);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).ino, engine.ino);
  assert.equal(await lstat(ticketPath).then(() => true, () => false), false);
  assert.equal(next.stderr(), '');
});

test('unqualified handoff ticket fails closed and leaves the existing native writer alive', async t => {
  const f = await fixture(t), first = await f.start(); const ready = await waitReady(f, first);
  const bytes = await readFile(path.join(f.ownerDirectory, 'ownership.json'));
  const before = JSON.parse(bytes);
  process.kill(before.runnerPid, 'SIGKILL'); await first.closed;
  t.after(() => { try { process.kill(ready.nativePid, 'SIGTERM'); } catch {} });
  await rm(path.join(f.ownerDirectory, 'ready.json'));
  const engine = await lstat(path.join(f.ownerDirectory, 'engine.sock'));
  await writeFile(path.join(f.ownerDirectory, 'broker-handoff.json'), JSON.stringify({ format: 'code-ai-broker-handoff', version: 1,
    custodySha256: '0'.repeat(64), brokerModuleSha256: f.plan.brokerModuleSha256, runnerModuleSha256: digest(await readFile(runner)) }), { mode: 0o600 });
  const next = await f.start(); assert.equal((await next.closed)[0], 1);
  assert.doesNotThrow(() => process.kill(ready.nativePid, 0));
  assert.equal((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).ino, engine.ino);
  assert.deepEqual(await readFile(path.join(f.ownerDirectory, 'ownership.json')), bytes);
});

test('profile runner publishes readiness only after both exact-home native endpoints initialize', async t => {
  const f = await fixture(t), c = await f.start(); const readyPath = path.join(f.ownerDirectory, 'ready.json');
  const ready = await waitReady(f, c);
  assert.equal(ready.profileVerified, true); assert.equal(ready.unixOnly, true); assert.equal(ready.profileId, 'synthetic');
  assert.equal((await lstat(readyPath)).mode & 0o077, 0);
  assert.equal(c.stdout(), 'CODE_AI_NATIVE_OWNER_READY\n'); assert.equal(c.stderr(), '');
  c.child.kill('SIGTERM'); assert.equal((await c.closed)[0], 0);
  assert.equal(await lstat(readyPath).then(() => true, () => false), false);
});

test('existing canonical native endpoint is preserved and prevents another owner startup', async t => {
  const f = await fixture(t); await mkdir(path.dirname(f.plan.frontendSocket), { mode: 0o700 });
  await writeFile(f.plan.frontendSocket, 'synthetic-existing-endpoint'); const c = await f.start();
  assert.equal((await c.closed)[0], 1);
  assert.equal(await readFile(f.plan.frontendSocket, 'utf8'), 'synthetic-existing-endpoint');
  assert.equal(await lstat(path.join(f.ownerDirectory, 'fixture-engine-started')).then(() => true, () => false), false);
  assert.equal(c.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('changed native program pin prevents startup before any new process', async t => {
  const f = await fixture(t), c = await f.start({ nativeBinarySha256: '0'.repeat(64) });
  assert.equal((await c.closed)[0], 1);
  assert.equal(await lstat(path.join(f.ownerDirectory, 'fixture-engine-started')).then(() => true, () => false), false);
  assert.equal(c.stdout(), ''); assert.equal(c.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('mismatched backend profile cannot open canonical frontend or mark readiness', async t => {
  const f = await fixture(t); const wrong = path.join(f.root, 'different-home'); await mkdir(wrong);
  const c = await f.start({}, { SYNTHETIC_WRONG_HOME: wrong }); assert.equal((await c.closed)[0], 1);
  assert.equal(await lstat(path.join(f.ownerDirectory, 'fixture-engine-started')).then(() => true, () => false), true);
  assert.equal(await lstat(f.plan.frontendSocket).then(() => true, () => false), false);
  assert.equal(await lstat(path.join(f.ownerDirectory, 'ready.json')).then(() => true, () => false), false);
  assert.equal(c.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('persistent OS flock rejects another runner without stealing sockets or native process', async t => {
  const f = await fixture(t), first = await f.start(); const ready = await waitReady(f, first);
  const socket = await lstat(f.plan.frontendSocket), lock = await lstat(path.join(f.ownerDirectory, 'owner.lock'));
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal((await lstat(f.plan.frontendSocket)).ino, socket.ino);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal(JSON.parse(await readFile(path.join(f.ownerDirectory, 'ready.json'), 'utf8')).nativePid, ready.nativePid);
  assert.equal(other.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('recorded dead-owner socket inodes recover after fixture-only process crash', async t => {
  const f = await fixture(t), first = await f.start(); const ready = await waitReady(f, first);
  const lock = await lstat(path.join(f.ownerDirectory, 'owner.lock'));
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(path.join(f.ownerDirectory, 'ready.json'));
  const recovered = await f.start(); const next = await waitReady(f, recovered);
  assert.notEqual(next.nativePid, ready.nativePid);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal(recovered.stderr(), '');
});

test('changed recorded endpoint is preserved, never cleaned from matching filename alone', async t => {
  const f = await fixture(t), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(f.plan.frontendSocket); await writeFile(f.plan.frontendSocket, 'synthetic-replacement-preserve');
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal(await readFile(f.plan.frontendSocket, 'utf8'), 'synthetic-replacement-preserve');
  assert.equal(other.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('dedicated product socket does not change the legitimate native canonical endpoint', async t => {
  const f = await fixture(t), original = path.join(f.home, 'app-server-control/app-server-control.sock');
  await mkdir(path.dirname(original), { mode: 0o700 }); await writeFile(original, 'synthetic-original-native-preserve');
  const c = await f.start(); await waitReady(f, c);
  assert.equal(await readFile(original, 'utf8'), 'synthetic-original-native-preserve');
  assert.equal(c.stderr(), '');
});

test('recorded socket with a live replacement listener is never removed', async t => {
  const f = await fixture(t), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(f.plan.frontendSocket);
  const server = createServer(), sockets = new WebSocketServer({ server });
  server.listen(f.plan.frontendSocket); await once(server, 'listening');
  t.after(async () => {
    for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const stat = await lstat(f.plan.frontendSocket), custodyPath = path.join(f.ownerDirectory, 'ownership.json');
  const record = JSON.parse(await readFile(custodyPath, 'utf8'));
  record.frontend = { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) };
  await writeFile(custodyPath, JSON.stringify(record));
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal((await lstat(f.plan.frontendSocket)).ino, stat.ino);
  assert.equal(other.stderr(), 'CODE_AI_NATIVE_OWNER_UNAVAILABLE\n');
});

test('normal stopped owner can advance qualified program pins when no socket cleanup is needed', async t => {
  const f = await fixture(t), first = await f.start(); await waitReady(f, first);
  first.child.kill('SIGTERM'); assert.equal((await first.closed)[0], 0);
  const source = await readFile(f.plan.brokerModule, 'utf8') + '\n// Synthetic qualified successor.\n';
  await writeFile(f.plan.brokerModule, source);
  const next = await f.start({ brokerModuleSha256: digest(source) }); await waitReady(f, next);
  assert.equal(next.stderr(), '');
});

test('prior-boot owner custody can recover stale sockets even when numeric PIDs were reused', async t => {
  const f = await fixture(t), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(path.join(f.ownerDirectory, 'ready.json'));
  const custodyPath = path.join(f.ownerDirectory, 'ownership.json'); const record = JSON.parse(await readFile(custodyPath, 'utf8'));
  record.bootId = '00000000-0000-0000-0000-000000000000'; record.runnerPid = process.pid; record.nativePid = process.pid;
  await writeFile(custodyPath, JSON.stringify(record));
  const next = await f.start(); await waitReady(f, next);
  assert.equal(next.stderr(), '');
});

test('owned native alias records exact alias, target and actual listener process generation', async t => {
  const f = await fixture(t, { nativeAlias: true }), c = await f.start(); await waitReady(f, c);
  const record = JSON.parse(await readFile(path.join(f.ownerDirectory, 'ownership.json'), 'utf8'));
  assert.equal(record.version, 2); assert.equal(record.backend.kind, 'native-alias');
  assert.equal(record.backend.ino, String((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).ino));
  assert.equal(record.backend.target.ino, String((await lstat(f.nativeTarget)).ino));
  assert.equal(record.backend.target.uid, String(process.getuid()));
  assert.match(record.nativeIdentity.startTime, /^[0-9]+$/); assert.match(record.nativeIdentity.cgroupSha256, /^[a-f0-9]{64}$/);
  assert.equal(record.nativeIdentity.networkNamespace, record.runnerIdentity.networkNamespace);
  assert.equal(c.stderr(), '');
});

test('native listener custody distinguishes an accepted stream sharing its pathname', async t => {
  const f = await fixture(t, { nativeAlias: true, initializeCloseDelayMs: 1_000 }), c = await f.start();
  await waitReady(f, c);
  const rows = (await readFile('/proc/net/unix', 'utf8')).split('\n').map(line => line.trim().split(/\s+/))
    .filter(fields => fields[7] === f.nativeTarget);
  assert.equal(rows.filter(fields => fields[3] === '00010000' && fields[4] === '0001').length, 1);
  assert.ok(rows.some(fields => fields[3] === '00000000' && fields[5] === '03'));
  const record = JSON.parse(await readFile(path.join(f.ownerDirectory, 'ownership.json'), 'utf8'));
  assert.equal(record.nativePid, JSON.parse(await readFile(path.join(f.ownerDirectory, 'ready.json'), 'utf8')).nativePid);
  assert.equal(c.stderr(), '');
});

test('recorded dangling native alias recovers without deleting its lock inode', async t => {
  const f = await fixture(t, { nativeAlias: true }), first = await f.start(); const initial = await waitReady(f, first);
  const lock = await lstat(path.join(f.ownerDirectory, 'owner.lock'));
  first.child.kill('SIGTERM'); assert.equal((await first.closed)[0], 0);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).isSymbolicLink(), true);
  assert.equal(await lstat(f.nativeTarget).then(() => true, () => false), false);
  const recovered = await f.start(); const next = await waitReady(f, recovered);
  assert.notEqual(next.nativePid, initial.nativePid);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal(recovered.stderr(), '');
});

test('changed native alias target inode is preserved and refuses recovery', async t => {
  const f = await fixture(t, { nativeAlias: true }), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(f.nativeTarget); await writeFile(f.nativeTarget, 'synthetic-foreign-target-preserve');
  const alias = await lstat(path.join(f.ownerDirectory, 'engine.sock'));
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).ino, alias.ino);
  assert.equal(await readFile(f.nativeTarget, 'utf8'), 'synthetic-foreign-target-preserve');
});

test('live native target concealed by an absent alias cannot reopen another owner', async t => {
  const f = await fixture(t, { nativeAlias: true }), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  await rm(path.join(f.ownerDirectory, 'engine.sock')); await rm(f.nativeTarget);
  const server = createServer(), sockets = new WebSocketServer({ server });
  server.listen(f.nativeTarget); await once(server, 'listening');
  t.after(async () => { for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  const target = await lstat(f.nativeTarget);
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal((await lstat(f.nativeTarget)).ino, target.ino);
  assert.equal(await lstat(path.join(f.ownerDirectory, 'engine.sock')).then(() => true, () => false), false);
});

test('unproven legacy process custody cannot clean a recorded native alias', async t => {
  const f = await fixture(t, { nativeAlias: true }), first = await f.start(); await waitReady(f, first);
  process.kill(-first.child.pid, 'SIGKILL'); await first.closed;
  const filename = path.join(f.ownerDirectory, 'ownership.json');
  const record = JSON.parse(await readFile(filename, 'utf8')); record.version = 1;
  await writeFile(filename, JSON.stringify(record));
  const alias = await lstat(path.join(f.ownerDirectory, 'engine.sock'));
  const other = await f.start(); assert.equal((await other.closed)[0], 1);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'engine.sock'))).ino, alias.ino);
});

test('non-native or foreign alias is rejected before recording any owner custody', async t => {
  const f = await fixture(t, { nativeAlias: true, foreignAlias: true }), c = await f.start();
  assert.equal((await c.closed)[0], 1);
  assert.equal(await lstat(path.join(f.ownerDirectory, 'ownership.json')).then(() => true, () => false), false);
  assert.equal(await lstat(f.plan.frontendSocket).then(() => true, () => false), false);
});

test('actual pinned native runner qualifies alias custody and lifecycle without model work', {
  skip: !process.env.CODE_AI_TEST_NATIVE_BIN,
}, async t => {
  const f = await fixture(t), nativeBinary = process.env.CODE_AI_TEST_NATIVE_BIN;
  const expected = process.env.CODE_AI_TEST_NATIVE_SHA256;
  assert.ok(path.isAbsolute(nativeBinary)); assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(digest(await readFile(nativeBinary)), expected);
  const original = path.join(f.home, 'app-server-control/app-server-control.sock');
  await mkdir(path.dirname(original), { mode: 0o700 }); await writeFile(original, 'synthetic-original-native-preserve');
  const first = await f.start({ nativeBinary, nativeBinarySha256: expected }); await waitReady(f, first, 25_000);
  const filename = path.join(f.ownerDirectory, 'ownership.json');
  const initial = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(initial.backend.kind, 'native-alias');
  assert.equal(initial.nativeIdentity.executable, nativeBinary);
  assert.equal(initial.nativeIdentity.cgroupSha256, initial.runnerIdentity.cgroupSha256);
  const lock = await lstat(path.join(f.ownerDirectory, 'owner.lock'));
  first.child.kill('SIGTERM'); assert.equal((await first.closed)[0], 0);
  // Native versions may remove their own target on normal exit. The runner must
  // neither replace that target nor require a surviving inode to recover its alias.
  const stoppedTarget = await lstat(initial.backend.target.path).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (stoppedTarget) assert.equal(stoppedTarget.ino.toString(), initial.backend.target.ino);
  const recovered = await f.start({ nativeBinary, nativeBinarySha256: expected }); await waitReady(f, recovered, 25_000);
  const next = JSON.parse(await readFile(filename, 'utf8'));
  assert.notEqual(next.nativeIdentity.startTime, initial.nativeIdentity.startTime);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal(await readFile(original, 'utf8'), 'synthetic-original-native-preserve');
  assert.equal(first.stderr(), ''); assert.equal(recovered.stderr(), '');
  // Reproduce an owned service cgroup being forcibly stopped: only this detached
  // fixture process group is killed. Native owns its hidden target; do not unlink it.
  process.kill(-recovered.child.pid, 'SIGKILL'); await recovered.closed;
  const killedTarget = await lstat(next.backend.target.path).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (killedTarget) assert.equal(killedTarget.ino.toString(), next.backend.target.ino);
  await rm(path.join(f.ownerDirectory, 'ready.json'));
  const afterCrash = await f.start({ nativeBinary, nativeBinarySha256: expected });
  await waitReady(f, afterCrash, 25_000);
  const final = JSON.parse(await readFile(filename, 'utf8'));
  assert.notEqual(final.nativeIdentity.startTime, next.nativeIdentity.startTime);
  assert.equal((await lstat(path.join(f.ownerDirectory, 'owner.lock'))).ino, lock.ino);
  assert.equal(await readFile(original, 'utf8'), 'synthetic-original-native-preserve');
  assert.equal(afterCrash.stderr(), '');
});
