import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Explicit installed runner path enables qualification of an existing handoff
// contract without publishing or changing any host's service configuration.
const runner = process.env.CODE_AI_LIFECYCLE_FIXTURE_RUNNER;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error('Isolated handoff condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function client(socket, name) {
  const ws = new WebSocket(`ws+unix://${socket}:/`), pending = new Map(), events = [];
  let next = 0;
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()), call = !frame.method && pending.get(frame.id);
    if (!call) { events.push(frame); return; }
    pending.delete(frame.id); clearTimeout(call.timer);
    frame.error ? call.reject(Error('Isolated RPC refused ' + frame.error.code)) : call.resolve(frame.result);
  });
  ws.on('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('Isolated transport closed')); } pending.clear(); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('Isolated RPC timed out')); }, 5_000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await once(ws, 'open');
  await call('initialize', { clientInfo: { name, version: 'fixture' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  return { ws, call, events };
}

test('existing runner adopts the same owner while active parent/child questions reconnect without replay and orphan subscriptions expire',
  { skip: !runner, timeout: 25_000 }, async t => {
    assert.ok(path.isAbsolute(runner));
    const root = await mkdtemp(path.join(os.tmpdir(), 'coa-lifecycle-'));
    const home = path.join(root, 'codex'), ownerDirectory = path.join(root, 'owner');
    await mkdir(home, { mode: 0o700 }); await mkdir(ownerDirectory, { mode: 0o700 });
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'));
    const engine = path.join(root, 'native-fixture.cjs');
    const engineSource = await readFile(new URL('./fixtures/codexSubscriptionOwner.cjs', import.meta.url));
    await writeFile(engine, Buffer.concat([Buffer.from(`#!${process.execPath}\n`), engineSource.subarray(engineSource.indexOf(10) + 1)]));
    await chmod(engine, 0o700);
    const brokerModule = fileURLToPath(new URL('./codexSharedOwnerBroker.mjs', import.meta.url));
    const plan = { format: 'code-ai-native-owner-profile', version: 1, profileId: 'isolated-lifecycle',
      userHome: root, codexHome: home, ownerDirectory, nativeBinary: engine,
      nativeBinarySha256: digest(await readFile(engine)), nodeBinary: process.execPath,
      brokerModule, brokerModuleSha256: digest(await readFile(brokerModule)), runnerModule: runner,
      dispatcherModule: path.join(root, 'dispatcher.mjs'), adapterModule: path.join(root, 'adapter.mjs'),
      guiLauncherModule: path.join(root, 'gui.mjs'), desktopExecutable: '/usr/bin/true',
      frontendSocket: path.join(home, 'code-ai-shared-owner/owner.sock'),
      guiBooleanRequirements: { 'features.code_mode_host': true,
        'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true,
        'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled': true } };
    const planFile = path.join(ownerDirectory, 'profile.json');
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    const settings = { model: 'fixture-model', effort: 'medium', cwd: ownerDirectory,
      approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    await writeFile(path.join(ownerDirectory, 'broker-journal.json'), JSON.stringify({
      format: 'code-ai-native-owner-reservations', version: 1, records: [{ threadId: 'own',
        clientId: 'own-input', queuedId: 'own-queued', turnId: 'own-turn', phase: 'started',
        previous: settings, requested: settings, createdAt: Date.now(), turnComplete: false, collaborationMode: 'default' }] }), { mode: 0o600 });
    const processes = [], clients = [];
    let nativePid;
    const launch = async () => {
      const process = spawn(globalThis.process.execPath, [runner, planFile], {
        env: { PATH: globalThis.process.env.PATH }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = ''; process.stderr.on('data', bytes => { stderr += bytes; });
      processes.push(process);
      await waitFor(async () => {
        if (process.exitCode !== null) throw Error('Fixture runner failed: ' + stderr);
        const custody = await readFile(path.join(ownerDirectory, 'ownership.json'), 'utf8').then(JSON.parse, () => null);
        const ready = await readFile(path.join(ownerDirectory, 'ready.json'), 'utf8').then(JSON.parse, () => null);
        return custody?.frontend && custody.runnerPid !== lastRunner && ready?.brokerModuleSha256 === plan.brokerModuleSha256
          && await lstat(plan.frontendSocket).then(() => true, () => false);
      });
      return process;
    };
    let lastRunner = null;
    t.after(async () => {
      for (const client of clients) client.ws.terminate();
      for (const child of processes) if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'close'); child.kill('SIGTERM'); await exited;
      }
      if (nativePid) { try { process.kill(nativePid, 'SIGTERM'); } catch {} }
      await rm(root, { recursive: true, force: true });
    });
    const first = await launch();
    const custodyFile = path.join(ownerDirectory, 'ownership.json');
    const beforeBytes = await readFile(custodyFile), before = JSON.parse(beforeBytes);
    nativePid = before.nativePid; lastRunner = before.runnerPid;
    const engineInode = (await lstat(path.join(ownerDirectory, 'engine.sock'))).ino;
    const lockInode = (await lstat(path.join(ownerDirectory, 'owner.lock'))).ino;
    const control = await client(path.join(ownerDirectory, 'engine.sock'), 'fixture-control'); clients.push(control);
    const web = await client(plan.frontendSocket, 'code-ai'); clients.push(web);
    await web.call('thread/resume', { threadId: 'own', excludeTurns: true });
    await web.call('thread/resume', { threadId: 'child', excludeTurns: true });
    await control.call('fixture/subscribeAll');
    await waitFor(() => web.events.some(f => f.id === 'question-child'));
    assert.equal((await control.call('fixture/state')).submissions, 0);
    const firstExit = once(first, 'close');
    // Only this test's recorded adapter. Its synthetic native process remains.
    process.kill(before.runnerPid, 'SIGKILL'); await firstExit;
    assert.doesNotThrow(() => process.kill(nativePid, 0));
    await writeFile(path.join(ownerDirectory, 'broker-handoff.json'), JSON.stringify({
      format: 'code-ai-broker-handoff', version: 1, custodySha256: digest(beforeBytes),
      brokerModuleSha256: plan.brokerModuleSha256, runnerModuleSha256: digest(await readFile(runner)) }), { mode: 0o600 });
    await launch();
    const after = JSON.parse(await readFile(custodyFile, 'utf8'));
    assert.equal(after.nativePid, nativePid);
    assert.deepEqual(after.nativeIdentity, before.nativeIdentity);
    assert.equal((await lstat(path.join(ownerDirectory, 'engine.sock'))).ino, engineInode);
    assert.equal((await lstat(path.join(ownerDirectory, 'owner.lock'))).ino, lockInode);
    const rejoined = await client(plan.frontendSocket, 'code-ai'); clients.push(rejoined);
    await rejoined.call('thread/resume', { threadId: 'own', excludeTurns: true });
    await rejoined.call('thread/resume', { threadId: 'child', excludeTurns: true });
    await waitFor(() => rejoined.events.some(f => f.id === 'question-own') && rejoined.events.some(f => f.id === 'question-child'));
    for (const id of ['question-own', 'question-child']) rejoined.ws.send(JSON.stringify({ id, result: { answers: {} } }));
    await waitFor(async () => {
      const state = await control.call('fixture/state');
      return state.threads.orphan.status === 'notLoaded' && state.answers.length === 2;
    });
    await waitFor(async () => {
      const state = await control.call('fixture/state');
      return ['idle-child', 'terminal-child'].every(id => state.threads[id].subscribers.includes('code-ai-broker-recovery'));
    });
    await control.call('fixture/advancePastIdleGrace');
    const state = await control.call('fixture/state');
    assert.equal(state.pid, nativePid); assert.equal(state.submissions, 0);
    assert.equal(state.threads.own.status, 'active'); assert.equal(state.threads.child.status, 'active');
    assert.equal(state.threads['idle-child'].status, 'idle');
    assert.equal(state.threads['terminal-child'].status, 'idle');
    assert.equal(state.terminalAlive, true); assert.doesNotThrow(() => process.kill(state.terminalPid, 0));
    assert.equal(state.expiredGraceChecks, 1);
    for (const id of ['own', 'child', 'idle-child', 'terminal-child']) assert.ok(state.threads[id].subscribers.includes('code-ai-broker-recovery'));
    assert.equal(state.threads.orphan.subscribers.length, 0);
    assert.equal(state.historyPreserved, true);
    assert.deepEqual((await readFile(path.join(ownerDirectory, 'fixture-started-pids'), 'utf8')).trim().split('\n'), [String(nativePid)]);
    const journal = JSON.parse(await readFile(path.join(ownerDirectory, 'broker-journal.json'), 'utf8'));
    assert.equal(journal.records[0].phase, 'started'); assert.equal(journal.records[0].turnComplete, false);
  });
