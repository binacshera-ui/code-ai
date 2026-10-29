import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  createCodexDeploymentHttpTracker,
  createCodexDeploymentDrain,
  isCodexDeploymentDrainError,
  isProtectedCodexDeploymentHttpRequest,
} from './codexDeploymentDrain.mjs';

const PASSIVE_PROCESS_FIXTURE = `
import http from 'node:http';
const { createCodexDeploymentDrain, createCodexDeploymentHttpTracker, createCodexDeploymentPassiveHttpAdmission } = await import(process.argv[1]);
const authority = createCodexDeploymentDrain({ queueRoot: process.argv[2], executionEnabled: false });
const client = createCodexDeploymentPassiveHttpAdmission(authority, {
  peerId: process.env.CODE_AI_HTTP_PEER_ID?.trim() || 'uploads', reconnectMs: Number(process.argv[4]) });
const tracker = createCodexDeploymentHttpTracker(client);
const holds = new Map();
const layer = { handle: async (req, res) => {
  const key = String(req.headers['x-fixture-id'] || 'immediate');
  process.send({ event: 'handler_started', key });
  if (req.url.includes('/hold')) await new Promise(resolve => holds.set(key, resolve));
  process.send({ event: 'handler_settled', key });
  if (!res.destroyed) res.end('fixture-complete');
} };
const callback = { handle: (req, _res, next) => {
  if (!req.url.includes('/callback')) { next(); return; }
  const key = String(req.headers['x-fixture-id']);
  process.send({ event: 'callback_started', key });
  holds.set(key, () => { process.send({ event: 'callback_settled', key }); next(); });
} };
tracker.wrapHandlers({ stack: [{ route: { stack: [callback, layer] } }] });
const server = http.createServer((req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  req.originalUrl = req.url;
  req.path = req.url.split('?')[0];
  const key = String(req.headers['x-fixture-id'] || 'immediate');
  res.once('close', () => process.send({ event: 'response_closed', key }));
  tracker.middleware(req, res, () => {
    const running = callback.handle(req, res, () => layer.handle(req, res, () => {}));
    if (running?.then) void running.catch(() => process.send({ event: 'fixture_error' }));
  });
});
server.listen(0, '127.0.0.1', async () => {
  await client.start();
  process.send({ event: 'ready', port: server.address().port, pid: process.pid });
});
process.on('message', async input => {
  if (input.action === 'settle') { holds.get(input.key)?.(); holds.delete(input.key); }
  else if (input.action === 'disconnect') { client.stop(); process.send({ event: 'disconnected' }); }
  else if (input.action === 'status') process.send({ event: 'peer_status', ...client.getPeerStatus() });
});
`;

async function passiveFixture(t, owner, peerId = 'uploads', reconnectMs = 50) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', PASSIVE_PROCESS_FIXTURE,
    new URL('./codexDeploymentDrain.mjs', import.meta.url).href, path.dirname(path.dirname(owner.controllerFile)), peerId, String(reconnectMs)],
  { env: { ...process.env, CODE_AI_HTTP_PEER_ID: peerId }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const events = [];
  const listeners = new Set();
  const wait = (predicate, timeoutMs = 5_000) => {
    const previous = events.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('Synthetic peer condition did not settle.')); }, timeoutMs);
      const listener = event => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(event);
      };
      listeners.add(listener);
    });
  };
  child.on('message', event => { events.push(event); for (const listener of listeners) listener(event); });
  const exited = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  const ready = await wait(event => event.event === 'ready');
  return { child, ready, events, wait, exited, url: `http://127.0.0.1:${ready.port}` };
}

async function eventually(predicate, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic process condition did not settle.');
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ai-drain-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 10_000;
  const authority = createCodexDeploymentDrain({ queueRoot: directory, clock: () => now, ...options });
  const ownerToken = randomUUID();
  const acquire = (extra = {}) => authority.leaseOperation({
    action: 'acquire', runtimeEpoch: authority.runtimeEpoch, ownerToken,
    releaseId: 'fixture-qualified-release', ttlMs: 30_000, ...extra,
  });
  const operate = (action, extra = {}) => {
    const current = authority.status();
    return authority.leaseOperation({
      action, runtimeEpoch: authority.runtimeEpoch, ownerToken,
      generation: current.generation, ttlMs: 30_000, ...extra,
    });
  };
  return { directory, authority, acquire, operate, setNow(value) { now = value; } };
}

function registerReadyParticipants(authority) {
  for (const name of ['queue', 'agent', 'terminal', 'native-codex', 'http-writes']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
}

function request(socketPath, value) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let raw = '';
    client.setTimeout(2_000, () => client.destroy(new Error('fixture timeout')));
    client.once('error', reject);
    client.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    client.once('end', () => { try { resolve(JSON.parse(raw)); } catch (error) { reject(error); } });
    client.once('connect', () => client.end(`${JSON.stringify(value)}\n`));
  });
}

test('unfenced idle observations and incomplete coverage cannot authorize deployment', (t) => {
  const { authority, acquire } = fixture(t);
  assert.equal(authority.status().drained, false);
  acquire();
  assert.equal(authority.status().admissionClosed, true);
  assert.equal(authority.status().coverageReady, false);
  assert.equal(authority.status().drained, false);
  assert.throws(() => authority.leaseOperation({
    action: 'seal', runtimeEpoch: authority.runtimeEpoch,
    ownerToken: authority.status().ownerToken, generation: authority.status().generation,
    ttlMs: 30_000,
  }), { reason: 'runtime_not_drained' });
});

test('lease atomically prevents new queue/direct admission but lets reserved work finish', (t) => {
  const { authority, acquire } = fixture(t);
  registerReadyParticipants(authority);
  const queue = authority.acquireAdmission('queue');
  acquire();
  assert.throws(() => authority.acquireAdmission('queue'), (error) => isCodexDeploymentDrainError(error));
  assert.throws(() => authority.acquireAdmission('agent'), { reason: 'maintenance_active' });
  const agent = authority.acquireAdmission('agent', queue);
  assert.equal(authority.status().activeAdmissions, 2);
  agent.release();
  assert.equal(authority.status().drained, false);
  queue.release();
  assert.equal(authority.status().drained, true);
  assert.equal(authority.status().httpIngressDrainProven, false);
});

test('released, fabricated and foreign tickets cannot bypass maintenance admission', (t) => {
  const { authority, acquire } = fixture(t);
  const ticket = authority.acquireAdmission('queue');
  ticket.release();
  acquire();
  assert.throws(() => authority.acquireAdmission('agent', ticket), { reason: 'invalid_continuation_ticket' });
  assert.throws(() => authority.acquireAdmission('agent', { release() {} }), { reason: 'invalid_continuation_ticket' });
  const other = fixture(t).authority;
  const foreign = other.acquireAdmission('queue');
  assert.throws(() => authority.acquireAdmission('agent', foreign), { reason: 'invalid_continuation_ticket' });
  foreign.release();
});

test('reattaching already admitted native work is tracked during drain and forbidden after seal', (t) => {
  const { authority, acquire, operate } = fixture(t);
  registerReadyParticipants(authority);
  acquire();
  const recovery = authority.acquireRecoveryAdmission('native-reconcile');
  assert.equal(authority.status().admissionsByKind['recovery-native-reconcile'], 1);
  assert.equal(authority.status().drained, false);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  recovery.release();
  operate('seal');
  assert.throws(() => authority.acquireRecoveryAdmission('native-reconcile'), { reason: 'maintenance_sealed' });
  const passive = fixture(t, { executionEnabled: false });
  assert.throws(() => passive.authority.acquireRecoveryAdmission('native-reconcile'), { reason: 'execution_disabled' });
  fs.writeFileSync(authority.leaseFile, '{invalid', { mode: 0o600 });
  assert.throws(() => authority.acquireRecoveryAdmission('native-reconcile'), { reason: 'lease_unreadable' });
});

test('tick, post-provider promises and durable writes each block the drain proof', (t) => {
  const { authority, acquire } = fixture(t);
  const queue = { ready: true, active: 0, inFlight: 1, persisting: false };
  authority.registerParticipant('queue', () => queue);
  for (const name of ['agent', 'terminal', 'native-codex', 'http-writes']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
  acquire();
  assert.equal(authority.status().drained, false);
  queue.inFlight = 0;
  queue.persisting = true;
  assert.equal(authority.status().drained, false);
  queue.persisting = false;
  queue.active = 1;
  assert.equal(authority.status().drained, false);
  queue.active = 0;
  assert.equal(authority.status().drained, true);
});

test('renewal is bounded, ownership/generation fenced, and expired maintenance resumes admission', (t) => {
  const { authority, acquire, operate, setNow } = fixture(t);
  registerReadyParticipants(authority);
  const first = acquire();
  assert.throws(() => operate('renew', { ttlMs: 120_001 }), { reason: 'invalid_lease_duration' });
  assert.throws(() => operate('renew', { ttlMs: 4_999 }), { reason: 'invalid_lease_duration' });
  assert.throws(() => operate('renew', { ownerToken: randomUUID() }), { reason: 'lease_owner_mismatch' });
  assert.throws(() => operate('renew', { generation: randomUUID() }), { reason: 'lease_owner_mismatch' });
  assert.throws(() => operate('renew', { runtimeEpoch: randomUUID() }), { reason: 'runtime_epoch_mismatch' });
  setNow(20_000);
  assert.equal(operate('renew').expiresAt, 50_000);
  setNow(50_000);
  assert.equal(authority.status().maintenanceActive, false);
  assert.throws(() => operate('renew'), { reason: 'lease_not_active' });
  const work = authority.acquireAdmission('queue');
  work.release();
  const successor = acquire();
  assert.notEqual(successor.generation, first.generation);
});

test('malformed, insecure and symlinked lease files fail closed without echoing their content', (t) => {
  const { authority, acquire } = fixture(t);
  acquire();
  fs.writeFileSync(authority.leaseFile, 'fixture-sensitive-content:not-json', { mode: 0o600 });
  assert.throws(() => authority.acquireAdmission('queue'), { reason: 'lease_unreadable' });
  const failed = authority.status();
  assert.equal(failed.admissionClosed, true);
  assert.equal(failed.drained, false);
  assert.equal(JSON.stringify(failed).includes('fixture-sensitive-content'), false);
  assert.throws(() => acquire(), { reason: 'lease_unreadable' });
  fs.chmodSync(authority.leaseFile, 0o644);
  assert.throws(() => authority.acquireAdmission('agent'), { reason: 'lease_unreadable' });
  fs.unlinkSync(authority.leaseFile);
  fs.symlinkSync('/not-a-real-fixture-target', authority.leaseFile);
  assert.throws(() => authority.acquireAdmission('agent'), { reason: 'lease_unreadable' });
});

test('lease survives runtime replacement and releases only via the successor epoch', (t) => {
  const { authority, acquire, operate, directory } = fixture(t);
  registerReadyParticipants(authority);
  acquire();
  const sealed = operate('seal');
  assert.equal(sealed.phase, 'sealed');
  const successor = createCodexDeploymentDrain({ queueRoot: directory, clock: () => 10_001 });
  registerReadyParticipants(successor);
  assert.throws(() => successor.acquireAdmission('queue'), { reason: 'maintenance_active' });
  assert.throws(() => successor.leaseOperation({
    action: 'release', runtimeEpoch: authority.runtimeEpoch,
    ownerToken: sealed.ownerToken, generation: sealed.generation,
  }), { reason: 'runtime_epoch_mismatch' });
  successor.leaseOperation({
    action: 'release', runtimeEpoch: successor.runtimeEpoch,
    ownerToken: sealed.ownerToken, generation: sealed.generation,
  });
  const resumed = successor.acquireAdmission('queue');
  resumed.release();
});

test('invalid/failed participant reports do not leak data or become an idle proof', (t) => {
  const { authority, acquire } = fixture(t);
  authority.registerParticipant('queue', () => ({ ready: true, active: -1, secret: 'fixture-hidden' }));
  authority.registerParticipant('agent', () => { throw new Error('fixture-hidden'); });
  authority.registerParticipant('terminal', () => ({ ready: true, active: 0, rawPrompt: 'fixture-hidden' }));
  authority.registerParticipant('native-codex', () => ({ ready: false, active: 0, reason: 'unqualified_native_handoff' }));
  authority.registerParticipant('http-writes', () => ({ ready: true, active: 0 }));
  acquire();
  const result = authority.status();
  assert.equal(result.drained, false);
  assert.equal(result.coverageReady, false);
  assert.equal(JSON.stringify(result).includes('fixture-hidden'), false);
});

test('passive HTTP instances cannot launch providers outside the singleton fence', (t) => {
  const { authority } = fixture(t, { executionEnabled: false });
  assert.throws(() => authority.acquireAdmission('agent'), { reason: 'execution_disabled' });
});

test('private UNIX controller returns bounded metadata and never a public listener', async (t) => {
  const { authority, acquire } = fixture(t);
  registerReadyParticipants(authority);
  const controller = await authority.startController();
  t.after(() => authority.stopController());
  assert.equal(fs.statSync(path.dirname(controller.socketPath)).mode & 0o077, 0);
  assert.equal(fs.statSync(controller.socketPath).mode & 0o077, 0);
  const pointer = JSON.parse(fs.readFileSync(controller.controllerFile, 'utf8'));
  assert.equal(pointer.runtimeEpoch, authority.runtimeEpoch);
  const observed = await request(controller.socketPath, { action: 'status' });
  assert.equal(observed.ok, true);
  assert.equal(observed.result.drained, false);
  acquire();
  assert.equal((await request(controller.socketPath, { action: 'status' })).result.drained, true);
  const rejected = await request(controller.socketPath, { action: 'bad-fixture-hidden', request: 'fixture-hidden' });
  assert.equal(rejected.ok, false);
  assert.equal(JSON.stringify(rejected).includes('fixture-hidden'), false);
  await authority.stopController();
  assert.equal(authority.status().maintenanceActive, true);
});

test('private controller acquire/renew/seal/release follows real fenced protocol', async (t) => {
  const { authority } = fixture(t);
  registerReadyParticipants(authority);
  const controller = await authority.startController();
  t.after(() => authority.stopController());
  const acquire = await request(controller.socketPath, {
    action: 'acquire', runtimeEpoch: authority.runtimeEpoch,
    ownerToken: randomUUID(), releaseId: 'fixture-release', ttlMs: 30_000,
  });
  assert.equal(acquire.ok, true);
  assert.throws(() => authority.acquireAdmission('agent'), { reason: 'maintenance_active' });
  const mutation = {
    runtimeEpoch: acquire.result.runtimeEpoch, ownerToken: acquire.result.ownerToken,
    generation: acquire.result.generation, ttlMs: 30_000,
  };
  assert.equal((await request(controller.socketPath, { action: 'renew', ...mutation })).ok, true);
  const sealed = await request(controller.socketPath, { action: 'seal', ...mutation });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.result.httpIngressDrainProven, true);
  assert.throws(() => authority.acquireHttpAdmission(), { reason: 'maintenance_sealed' });
  assert.equal((await request(controller.socketPath, { action: 'release', ...mutation })).ok, true);
  const work = authority.acquireAdmission('agent');
  work.release();
});

test('controller startup refuses another live runtime without removing its private socket', async (t) => {
  const { authority, directory } = fixture(t);
  const first = await authority.startController();
  t.after(() => authority.stopController());
  const conflicting = createCodexDeploymentDrain({ queueRoot: directory });
  await assert.rejects(conflicting.startController(), { reason: 'another_runtime_not_excluded' });
  assert.equal(fs.existsSync(first.socketPath), true);
  assert.equal((await request(first.socketPath, { action: 'status' })).ok, true);
  await authority.stopController();
  assert.equal(fs.existsSync(first.controllerFile), false);
});

test('source queue preserves queued/scheduled work and reserves tickets at launch', () => {
  const source = fs.readFileSync(new URL('./codexQueue.ts', import.meta.url), 'utf8');
  const launch = source.slice(source.indexOf('function launchQueueItem('), source.indexOf('async function rebindQueueItemsToSession('));
  assert.ok(launch.indexOf("acquireCodexDeploymentAdmission('queue')") < launch.indexOf('processQueueItem(item, deploymentAdmission)'));
  // Boolean checks deliberately avoid dumping whole source files on failure.
  assert.ok(/if \(isCodexDeploymentDrainError\(error\)\) return;/.test(launch), 'launch handles typed admission denial');
  assert.ok(!/cancelAgentRun\(/.test(launch), 'maintenance does not cancel current work');
  assert.ok(/registerCodexDeploymentDrainParticipant\('queue'/.test(source), 'queue participant registered');
  assert.ok(/pendingPersistWrites > 0/.test(source), 'durable writes tracked');
  assert.ok(/Number\(workerTickInFlight\) \+ Number\(stopPolicyRefreshPromise !== null\)/.test(source), 'worker and stop-policy promises tracked');
  assert.ok(/deploymentAdmission,[\s\S]{0,1200}runId: item\.id/.test(source), 'queue passes actual admission ticket to provider');
  assert.ok(/if \(isCodexDeploymentDrainSealed\(\)\) return;\s+await refreshQueueState\(\);/.test(source), 'sealed queue avoids housekeeping writes');
});

function mockHttp(method = 'POST', requestPath = '/api/codex/queue/items') {
  const req = new EventEmitter();
  Object.assign(req, { method, path: requestPath, originalUrl: requestPath });
  const res = new EventEmitter();
  Object.assign(res, { headers: {}, headersSent: false, destroyed: false, writableEnded: false });
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; res.writableEnded = true; res.emit('finish'); return res; };
  return { req, res };
}

test('HTTP mutations accepted during drain settle before seal, then retry without executing handlers', async (t) => {
  const { authority, acquire, operate } = fixture(t);
  for (const name of ['queue', 'agent', 'terminal', 'native-codex']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
  const tracker = createCodexDeploymentHttpTracker(authority);
  let complete;
  let calls = 0;
  const pending = new Promise((resolve) => { complete = resolve; });
  const layer = { handle: async (_req, res) => { calls += 1; await pending; res.json({ persisted: true }); } };
  tracker.wrapHandlers({ stack: [{ route: { stack: [layer] } }] });
  acquire();
  const first = mockHttp();
  tracker.middleware(first.req, first.res, () => {});
  const running = layer.handle(first.req, first.res, () => {});
  assert.equal(tracker.getActiveCount(), 1);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  complete();
  await running;
  assert.equal(tracker.getActiveCount(), 0);
  assert.equal(operate('seal').httpIngressDrainProven, true);
  const second = mockHttp();
  let reachedNext = false;
  tracker.middleware(second.req, second.res, () => { reachedNext = true; });
  assert.equal(reachedNext, false);
  assert.equal(second.res.statusCode, 503);
  assert.equal(second.res.body.retryable, true);
  assert.equal(second.res.headers['Retry-After'], '2');
  assert.equal(calls, 1);
});

test('aborted sockets remain tracked until the real async handler and persistence settle', async (t) => {
  const { authority, acquire, operate } = fixture(t);
  for (const name of ['queue', 'agent', 'terminal', 'native-codex']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
  const tracker = createCodexDeploymentHttpTracker(authority);
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const layer = { handle: async () => { await pending; } };
  tracker.wrapHandlers({ stack: [{ route: { stack: [layer] } }] });
  const request = mockHttp('GET');
  tracker.middleware(request.req, request.res, () => {});
  // Express removes the mount prefix from req.path. originalUrl retains it.
  request.req.path = '/queue/items';
  const running = layer.handle(request.req, request.res, () => {});
  acquire();
  request.req.emit('aborted');
  request.res.destroyed = true;
  request.res.emit('close');
  assert.equal(authority.status().drained, false);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  complete();
  await running;
  assert.equal(authority.status().drained, true);
  assert.equal(operate('seal').httpIngressDrainProven, true);
});

test('callback upload middleware holds through abort until next confirms actual completion', t => {
  const { authority, acquire, operate } = fixture(t);
  for (const name of ['queue', 'agent', 'terminal', 'native-codex']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
  const tracker = createCodexDeploymentHttpTracker(authority);
  let complete;
  const layer = { handle: (_req, _res, next) => { complete = next; } };
  tracker.wrapHandlers({ stack: [{ route: { stack: [layer] } }] });
  const request = mockHttp('POST');
  tracker.middleware(request.req, request.res, () => {});
  layer.handle(request.req, request.res, () => {});
  acquire();
  request.req.emit('aborted');
  request.res.destroyed = true;
  request.res.emit('close');
  assert.equal(authority.status().drained, false);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  complete();
  assert.equal(authority.status().drained, true);
});

test('late middleware callbacks cannot invoke a route after a closed request was sealed', (t) => {
  const { authority, acquire, operate } = fixture(t);
  for (const name of ['queue', 'agent', 'terminal', 'native-codex']) {
    authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  }
  const tracker = createCodexDeploymentHttpTracker(authority);
  let calls = 0;
  const layer = { handle: () => { calls += 1; } };
  tracker.wrapHandlers({ stack: [{ route: { stack: [layer] } }] });
  const request = mockHttp('GET');
  tracker.middleware(request.req, request.res, () => {});
  request.req.emit('aborted');
  request.res.destroyed = true;
  acquire();
  assert.equal(operate('seal').httpIngressDrainProven, true);
  request.req.path = '/queue/items';
  layer.handle(request.req, request.res, () => {});
  assert.equal(calls, 0);
});

test('finite GET queue readers are fenced but readiness, static files and read-only streams stay available', () => {
  assert.equal(isProtectedCodexDeploymentHttpRequest('GET', '/api/codex/queue/items'), true);
  assert.equal(isProtectedCodexDeploymentHttpRequest('HEAD', '/api/codex/queue/items'), true);
  assert.equal(isProtectedCodexDeploymentHttpRequest('POST', '/api/codex/queue/items'), true);
  assert.equal(isProtectedCodexDeploymentHttpRequest('GET', '/assets/client.js'), false);
  assert.equal(isProtectedCodexDeploymentHttpRequest('GET', '/api/codex/remote-agent/health'), false);
  assert.equal(isProtectedCodexDeploymentHttpRequest('GET', '/api/codex/sessions/fixture/events'), false);
  assert.equal(isProtectedCodexDeploymentHttpRequest('GET', '/api/codex/session-browser-viewer/stream'), false);
});

test('actual passive process holds aggregate seal through upload abort until its async handler settles', async t => {
  const { authority, acquire, operate } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  assert.equal(authority.status().coverageReady, false, 'unseen required ingress cannot manufacture a seal');
  const peer = await passiveFixture(t, authority);
  assert.notEqual(peer.ready.pid, process.pid, 'actual separate passive process');
  assert.equal(authority.status().coverageReady, true);
  const abort = new AbortController();
  const upload = fetch(peer.url + '/api/fixture/hold', { method: 'POST', headers: { 'x-fixture-id': 'aborted-upload' }, signal: abort.signal }).catch(() => null);
  await peer.wait(event => event.event === 'handler_started' && event.key === 'aborted-upload');
  acquire();
  assert.equal(authority.status().admissionsByKind['http-peer-uploads'], 1);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  abort.abort();
  await upload;
  await peer.wait(event => event.event === 'response_closed' && event.key === 'aborted-upload');
  assert.equal(authority.status().drained, false, 'socket abort is not completion of passive persistence');
  peer.child.send({ action: 'settle', key: 'aborted-upload' });
  await peer.wait(event => event.event === 'handler_settled' && event.key === 'aborted-upload');
  await eventually(() => authority.status().drained);
  assert.equal(operate('seal').httpIngressDrainProven, true);
  const refused = await fetch(peer.url + '/api/fixture/send', { method: 'POST', headers: { 'x-fixture-id': 'sealed-upload' } });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('Retry-After'), '2');
  assert.equal((await refused.json()).code, 'CODE_AI_DEPLOYMENT_DRAIN');
  assert.equal(peer.events.some(event => event.event === 'handler_started' && event.key === 'sealed-upload'), false);
});

test('live passive disconnect remains fail-closed regardless of time; only proven process death settles its work', async t => {
  const { authority, acquire, operate, setNow } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  const peer = await passiveFixture(t, authority);
  const abort = new AbortController();
  const upload = fetch(peer.url + '/api/fixture/hold', { method: 'POST', headers: { 'x-fixture-id': 'disconnected-upload' }, signal: abort.signal }).catch(() => null);
  await peer.wait(event => event.event === 'handler_started' && event.key === 'disconnected-upload');
  peer.child.send({ action: 'disconnect' });
  await peer.wait(event => event.event === 'disconnected');
  await eventually(() => authority.status().participants['http-peers'].reason === 'http_peer_disconnected');
  const refused = await fetch(peer.url + '/api/fixture/send', { method: 'POST' });
  assert.equal(refused.status, 503);
  setNow(1_000_000_000);
  acquire();
  assert.equal(authority.status().coverageReady, false);
  assert.equal(authority.status().admissionsByKind['http-peer-uploads'], 1);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  peer.child.kill('SIGTERM');
  await peer.exited;
  abort.abort();
  await upload;
  assert.equal(authority.status().participants['http-peers'].active, 0);
  assert.equal(authority.status().coverageReady, true, 'OS death excludes work; no age-based ticket expiry');
  assert.equal(operate('seal').httpIngressDrainProven, true);
});

test('owner disconnect fails passive admission; successor reconstructs active inventory before seal', async t => {
  const { directory, authority, acquire } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  const peer = await passiveFixture(t, authority);
  const upload = fetch(peer.url + '/api/fixture/hold', { method: 'POST', headers: { 'x-fixture-id': 'owner-restart-upload' } });
  await peer.wait(event => event.event === 'handler_started' && event.key === 'owner-restart-upload');
  const lease = acquire();
  await authority.stopController();
  assert.equal((await fetch(peer.url + '/api/fixture/send', { method: 'POST' })).status, 503);
  const successor = createCodexDeploymentDrain({ queueRoot: directory, clock: () => 10_000, requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(successor);
  assert.equal(successor.status().coverageReady, false, 'new epoch cannot overlook existing passive work');
  await successor.startController();
  t.after(() => successor.stopController());
  await eventually(() => successor.status().coverageReady);
  assert.notEqual(successor.runtimeEpoch, authority.runtimeEpoch);
  assert.equal(successor.status().generation, lease.generation);
  assert.equal(successor.status().admissionsByKind['http-peer-uploads'], 1);
  assert.throws(() => successor.leaseOperation({ action: 'seal', runtimeEpoch: successor.runtimeEpoch,
    ownerToken: lease.ownerToken, generation: lease.generation, ttlMs: 30_000 }), { reason: 'runtime_not_drained' });
  peer.child.send({ action: 'settle', key: 'owner-restart-upload' });
  assert.equal((await upload).status, 200);
  await eventually(() => successor.status().drained);
  assert.equal(successor.leaseOperation({ action: 'seal', runtimeEpoch: successor.runtimeEpoch,
    ownerToken: lease.ownerToken, generation: lease.generation, ttlMs: 30_000 }).httpIngressDrainProven, true);
});

test('additional connected ingress is counted regardless of its role, and fake namespace identity is refused', async t => {
  const { authority, acquire, operate } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  const started = await authority.startController();
  t.after(() => authority.stopController());
  const refused = await request(started.socketPath, { action: 'http-register', rpcId: randomUUID(),
    peerId: 'uploads', peerEpoch: randomUUID(), pid: process.pid, startTime: '0', pidNamespace: '0', activeRequestIds: [] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'http_peer_process_identity_mismatch');
  assert.equal(authority.status().coverageReady, false);
  await passiveFixture(t, authority);
  const extra = await passiveFixture(t, authority, 'additional-ingress');
  const upload = fetch(extra.url + '/api/fixture/hold', { method: 'POST', headers: { 'x-fixture-id': 'extra-upload' } });
  await extra.wait(event => event.event === 'handler_started' && event.key === 'extra-upload');
  acquire();
  assert.equal(authority.status().admissionsByKind['http-peer-additional-ingress'], 1);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  extra.child.send({ action: 'settle', key: 'extra-upload' });
  assert.equal((await upload).status, 200);
  await eventually(() => authority.status().drained);
  assert.equal(operate('seal').httpIngressDrainProven, true);
});

test('uploads and account-auth passive peers admit protected reads without conflicting identities', async t => {
  const { authority } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  const uploads = await passiveFixture(t, authority);
  const account = await passiveFixture(t, authority, 'account-auth');
  const responses = await Promise.all([uploads, account].map(peer => fetch(peer.url + '/api/codex/account-auth')));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  await Promise.all(responses.map(response => response.text()));
  assert.equal(authority.status().coverageReady, true);
  for (const peer of [uploads, account]) {
    peer.child.send({ action: 'status' });
    const status = await peer.wait(event => event.event === 'peer_status');
    assert.equal(status.connected, true);
  }
});

test('actual passive callback upload I/O remains admitted after abort until next settles it', async t => {
  const { authority, acquire, operate } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  const peer = await passiveFixture(t, authority);
  const abort = new AbortController();
  const upload = fetch(peer.url + '/api/fixture/callback', { method: 'POST',
    headers: { 'x-fixture-id': 'callback-upload' }, signal: abort.signal }).catch(() => null);
  await peer.wait(event => event.event === 'callback_started' && event.key === 'callback-upload');
  acquire();
  abort.abort();
  await upload;
  await peer.wait(event => event.event === 'response_closed' && event.key === 'callback-upload');
  assert.equal(authority.status().admissionsByKind['http-peer-uploads'], 1);
  assert.throws(() => operate('seal'), { reason: 'runtime_not_drained' });
  peer.child.send({ action: 'settle', key: 'callback-upload' });
  await peer.wait(event => event.event === 'callback_settled' && event.key === 'callback-upload');
  await eventually(() => authority.status().drained);
  assert.equal(operate('seal').httpIngressDrainProven, true);
});

test('real reconnect registration ACK race flushes fully settled inventory rather than stranding tickets', async t => {
  const { directory, authority, acquire } = fixture(t, { requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(authority);
  await authority.startController();
  t.after(() => authority.stopController());
  const peer = await passiveFixture(t, authority, 'uploads', 1_000);
  const upload = fetch(peer.url + '/api/fixture/hold', { method: 'POST', headers: { 'x-fixture-id': 'registration-race' } });
  await peer.wait(event => event.event === 'handler_started' && event.key === 'registration-race');
  acquire();
  await authority.stopController();
  const successor = createCodexDeploymentDrain({ queueRoot: directory, clock: () => 10_000, requiredHttpPeers: ['uploads'] });
  registerReadyParticipants(successor);
  const started = await successor.startController();
  t.after(() => successor.stopController());
  const proxyPath = path.join(path.dirname(started.socketPath), 'fixture-ack-delay.sock');
  const sockets = new Set();
  let allowAcknowledgement;
  let registered;
  const registrationSeen = new Promise(resolve => { registered = resolve; });
  const proxy = net.createServer(downstream => {
    const upstream = net.createConnection(started.socketPath);
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.pipe(upstream);
    let buffer = '';
    upstream.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        if (JSON.parse(frame).result?.registered) {
          allowAcknowledgement = () => downstream.write(frame);
          registered();
        } else downstream.write(frame);
      }
    });
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
  });
  await new Promise(resolve => proxy.listen(proxyPath, resolve));
  fs.chmodSync(proxyPath, 0o600);
  const pointer = JSON.parse(fs.readFileSync(successor.controllerFile, 'utf8'));
  fs.writeFileSync(successor.controllerFile, JSON.stringify({ ...pointer, socketPath: proxyPath }), { mode: 0o600 });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  await registrationSeen;
  assert.equal(successor.status().admissionsByKind['http-peer-uploads'], 1);
  peer.child.send({ action: 'settle', key: 'registration-race' });
  assert.equal((await upload).status, 200);
  peer.child.send({ action: 'status' });
  await peer.wait(event => event.event === 'peer_status' && event.active === 0 && !event.connected);
  assert.equal(successor.status().drained, false, 'owner still conservatively holds its acknowledged inventory');
  allowAcknowledgement();
  await eventually(() => successor.status().drained);
  assert.equal(successor.status().activeAdmissions, 0);
});
