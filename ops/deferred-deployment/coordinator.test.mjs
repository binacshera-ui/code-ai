import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createCodexDeploymentDrain } from '../../server/codexDeploymentDrain.mjs';
import { runDeploymentCycle, validateDeploymentRequest } from './coordinator.mjs';
import { requestController, readControllerPointer } from './controller-client.mjs';
import { renderDeferredDeploymentUnits } from './systemd/render-units.mjs';

const sha = character => character.repeat(64);
const participantNames = ['queue', 'agent', 'terminal', 'native-codex', 'http-writes'];

function syntheticError(reason) { return Object.assign(new Error('Synthetic controlled failure.'), { reason }); }

function fixture(t, hostIds = ['main']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ai-coordinator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  const request = {
    format: 'code-ai-deferred-deployment-request', version: 1,
    deploymentId: randomUUID(), adapterSha256: sha('a'),
    candidate: {
      buildId: randomUUID(), importRoot: '/mnt/synthetic-qualified-build',
      artifactTreeSha256: sha('b'), attestationSha256: sha('c'),
      sourceFreezeSha256: sha('d'), serverSha256: sha('e'), manifestSha256: sha('f'),
    },
    hosts: hostIds.map(id => ({ id, baseline: { release: 'baseline-qualified', serverSha256: sha('1') }, candidateRelease: 'candidate-qualified' })),
  };
  const stateFile = path.join(directory, 'coordinator', 'state.json');
  const hosts = new Map();
  const calls = [];
  const newAuthority = host => {
    host.authority = createCodexDeploymentDrain({ queueRoot: host.queueRoot, clock: () => now });
    for (const name of participantNames) host.authority.registerParticipant(name, () => ({ ready: true, active: 0 }));
  };
  for (const entry of request.hosts) {
    const host = { id: entry.id, queueRoot: path.join(directory, entry.id), reachable: true, gateSupported: true,
      identity: { ...entry.baseline }, healthReady: true, operationSettled: true, queue: [], scheduled: [] };
    newAuthority(host);
    hosts.set(entry.id, host);
  }
  const requireFreshSeal = (host, receipt) => {
    const status = host.authority.status();
    assert.equal(status.maintenanceActive, true);
    assert.equal(status.drained, true);
    assert.equal(status.httpIngressDrainProven, true);
    assert.equal(status.sealId, receipt.sealId);
    assert.equal(status.generation, receipt.generation);
    assert.equal(status.runtimeEpoch, receipt.runtimeEpoch);
  };
  const adapter = {
    async verifyCandidate(value) {
      calls.push('verifyCandidate');
      return { ...value.candidate, verified: true, fullApplication: true, productionReady: true,
        cumulative: true, acceptancePassed: true, requiredFiles: ['dist/server.js', 'dist/public/index.html'] };
    },
    async inspectHost(entry) {
      calls.push(`inspect:${entry.id}`);
      const host = hosts.get(entry.id);
      return { reachable: host.reachable, gateSupported: host.gateSupported, releaseIdentity: host.identity };
    },
    async control(entry, input) {
      calls.push(`control:${input.action}:${entry.id}`);
      return hosts.get(entry.id).authority.leaseOperation(input);
    },
    async activate(entry, value, options, context) {
      calls.push(`activate:${entry.id}`);
      assert.equal(context.operationId, options.operationId);
      assert.equal(context.signal.aborted, false);
      const durable = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(durable.hosts[entry.id].phase, 'switching');
      assert.equal(durable.hosts[entry.id].operationId, options.operationId);
      const host = hosts.get(entry.id);
      requireFreshSeal(host, options.seal);
      assert.deepEqual(host.identity, options.expectedBaseline);
      host.identity = { release: entry.candidateRelease, serverSha256: value.candidate.serverSha256 };
      newAuthority(host);
      if (host.crashAfterActivation) throw syntheticError('synthetic_transport_lost');
      return { operationId: options.operationId, releaseIdentity: host.identity };
    },
    async reconcile(entry) {
      calls.push(`reconcile:${entry.id}`);
      const host = hosts.get(entry.id);
      return { state: host.operationSettled ? (host.identity.release === entry.candidateRelease ? 'candidate' : 'baseline') : 'indeterminate',
        operationSettled: host.operationSettled, releaseIdentity: host.identity,
        readiness: host.identity.release === entry.baseline.release || host.healthReady };
    },
    async readiness(entry) {
      calls.push(`readiness:${entry.id}`);
      const host = hosts.get(entry.id);
      return { ready: host.healthReady, releaseIdentity: host.identity };
    },
    async rollback(entry, value, options) {
      calls.push(`rollback:${entry.id}`);
      const host = hosts.get(entry.id);
      requireFreshSeal(host, options.seal);
      host.identity = { ...options.baseline };
      newAuthority(host);
      return { releaseIdentity: host.identity };
    },
  };
  const cycle = extra => runDeploymentCycle({ request, stateFile, adapter, clock: () => now, ...extra });
  return { directory, request, stateFile, hosts, calls, adapter, cycle, newAuthority,
    now: () => now, advance(ms) { now += ms; } };
}

test('real fence waits for current work, renews across ticks and retains incoming queue/schedule entries', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  const running = host.authority.acquireAdmission('agent');
  const first = await f.cycle();
  assert.equal(first.state, 'waiting');
  assert.equal(first.hosts.main.phase, 'draining');
  const generation = host.authority.status().generation;
  const expiry = host.authority.status().expiresAt;
  const posting = host.authority.acquireHttpAdmission();
  host.queue.push({ id: 'new-message', status: 'queued' });
  host.scheduled.push({ id: 'future-job', status: 'scheduled', scheduledAt: f.now() + 360_000 });
  posting.release();
  assert.throws(() => host.authority.acquireAdmission('agent'), { reason: 'maintenance_active' });
  f.advance(15_000);
  assert.equal((await f.cycle()).state, 'waiting');
  assert.equal(host.authority.status().generation, generation);
  assert.equal(host.authority.status().expiresAt, expiry + 15_000);
  running.release();
  const accepted = await f.cycle();
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.hosts.main.attempts, 1);
  assert.equal(host.authority.status().maintenanceActive, false);
  assert.deepEqual(host.queue, [{ id: 'new-message', status: 'queued' }]);
  assert.equal(host.scheduled[0].status, 'scheduled');
  assert.equal(f.calls.filter(call => call === 'activate:main').length, 1);
});

test('expired coordinator lease resumes admission but replacement waits for that late work', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  const original = host.authority.acquireAdmission('agent');
  await f.cycle();
  const oldGeneration = host.authority.status().generation;
  f.advance(120_001);
  const late = host.authority.acquireAdmission('agent');
  original.release();
  assert.equal((await f.cycle()).state, 'waiting');
  assert.notEqual(host.authority.status().generation, oldGeneration);
  assert.equal(f.calls.includes('activate:main'), false);
  late.release();
  assert.equal((await f.cycle()).state, 'accepted');
});

test('a request admitted between idle observation and seal blocks cutover without cancelling it', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  const inspect = f.adapter.inspectHost;
  let count = 0;
  let late;
  f.adapter.inspectHost = async (...args) => {
    const result = await inspect(...args);
    if (++count === 2) late = host.authority.acquireHttpAdmission();
    return result;
  };
  const waiting = await f.cycle();
  assert.equal(waiting.hosts.main.reason, 'runtime_not_drained');
  assert.equal(waiting.hosts.main.phase, 'draining');
  assert.equal(f.calls.includes('activate:main'), false);
  late.release();
  assert.equal((await f.cycle()).state, 'accepted');
});

test('changed attestation/artifact binding unfences normal drains and never switches a successor', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  const work = host.authority.acquireAdmission('agent');
  await f.cycle();
  const verify = f.adapter.verifyCandidate;
  f.adapter.verifyCandidate = async (...args) => ({ ...await verify(...args), artifactTreeSha256: sha('9') });
  const rejected = await f.cycle();
  assert.equal(rejected.state, 'blocked');
  assert.equal(rejected.reason, 'candidate_binding_changed');
  assert.equal(host.authority.status().maintenanceActive, false);
  assert.equal(host.authority.status().activeAdmissions, 1);
  assert.equal(f.calls.includes('activate:main'), false);
  work.release();
});

test('another accepted baseline appearing while waiting invalidates old request lineage', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  const work = host.authority.acquireAdmission('agent');
  await f.cycle();
  host.identity = { release: 'successor-accepted', serverSha256: sha('2') };
  const result = await f.cycle();
  assert.equal(result.hosts.main.phase, 'blocked_baseline');
  assert.equal(host.authority.status().maintenanceActive, false);
  assert.equal(f.calls.includes('activate:main'), false);
  work.release();
});

test('crash after applied activation reconciles durable operation, never activates twice', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  host.crashAfterActivation = true;
  const first = await f.cycle();
  assert.equal(first.state, 'reconciling');
  assert.equal(first.hosts.main.phase, 'switching');
  const saved = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert.ok(saved.hosts.main.operationId);
  assert.equal((await f.cycle()).state, 'accepted');
  assert.equal(f.calls.filter(call => call === 'activate:main').length, 1);
  const count = f.calls.length;
  assert.equal((await f.cycle()).state, 'accepted');
  assert.equal(f.calls.length, count);
});

test('unknown outstanding operation and lost gate cannot be mistaken for a retryable baseline', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  host.crashAfterActivation = true;
  await f.cycle();
  host.operationSettled = false;
  const uncertain = await f.cycle();
  assert.equal(uncertain.state, 'reconciling');
  assert.equal(uncertain.hosts.main.reason, 'activation_outcome_unproven');
  host.gateSupported = false;
  const noGate = await f.cycle();
  assert.equal(noGate.hosts.main.phase, 'switching');
  assert.equal(f.calls.filter(call => call === 'activate:main').length, 1);
});

test('failed readiness rolls back under fresh seal, verifies baseline and then resumes admission', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  host.healthReady = false;
  const result = await f.cycle();
  assert.equal(result.state, 'blocked');
  assert.equal(result.hosts.main.phase, 'rolled_back');
  assert.equal(result.hosts.main.accepted, false);
  assert.deepEqual(host.identity, f.request.hosts[0].baseline);
  assert.equal(host.authority.status().maintenanceActive, false);
  assert.equal(f.calls.filter(call => call === 'rollback:main').length, 1);
  await f.cycle();
  assert.equal(f.calls.filter(call => call === 'activate:main').length, 1);
});

test('recovery after expired lease waits for candidate jobs before rollback, preserving them', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  host.crashAfterActivation = true;
  host.healthReady = false;
  await f.cycle();
  f.advance(120_001);
  const work = host.authority.acquireAdmission('agent');
  const waiting = await f.cycle();
  assert.equal(waiting.hosts.main.phase, 'rollback_pending');
  assert.equal(waiting.hosts.main.reason, 'rollback_waiting_for_drain');
  assert.equal(f.calls.includes('rollback:main'), false);
  assert.equal(host.authority.status().activeAdmissions, 1);
  work.release();
  const rolledBack = await f.cycle();
  assert.equal(rolledBack.hosts.main.phase, 'rolled_back');
  assert.equal(f.calls.filter(call => call === 'rollback:main').length, 1);
});

test('unreachable Windows remains pending and bootstrap-unsupported runtime causes no maintenance effects', async t => {
  const f = fixture(t, ['main', 'personal-windows-me']);
  f.hosts.get('main').gateSupported = false;
  f.hosts.get('personal-windows-me').reachable = false;
  const result = await f.cycle();
  assert.equal(result.hosts.main.phase, 'blocked_bootstrap');
  assert.equal(result.hosts['personal-windows-me'].phase, 'pending_host');
  assert.equal(result.hosts['personal-windows-me'].accepted, false);
  assert.equal(f.calls.some(call => call.startsWith('control:') || call.startsWith('activate:')), false);
});

test('foreign owner/generation is neither stolen nor released', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  host.authority.leaseOperation({ action: 'acquire', runtimeEpoch: host.authority.runtimeEpoch,
    ownerToken: randomUUID(), releaseId: 'another-operator-release', ttlMs: 120_000 });
  const before = host.authority.status();
  const result = await f.cycle();
  assert.equal(result.hosts.main.reason, 'foreign_maintenance_lease');
  assert.equal(host.authority.status().generation, before.generation);
  assert.equal(f.calls.some(call => call.startsWith('control:release:') || call.startsWith('activate:')), false);
});

test('partial application or missing acceptance cannot acquire maintenance even with verified flag', async t => {
  const f = fixture(t);
  const verify = f.adapter.verifyCandidate;
  f.adapter.verifyCandidate = async (...args) => ({ ...await verify(...args), requiredFiles: ['dist/server.js'] });
  const result = await f.cycle();
  assert.equal(result.reason, 'full_candidate_not_qualified');
  assert.equal(f.calls.some(call => call.startsWith('control:') || call.startsWith('activate:')), false);
});

test('durable state rejects mutated request and corrupted private evidence without effects', async t => {
  const f = fixture(t);
  f.hosts.get('main').reachable = false;
  await f.cycle();
  f.request.hosts[0].candidateRelease = 'changed-candidate';
  await assert.rejects(f.cycle(), { reason: 'durable_request_binding_changed' });
  f.request.hosts[0].candidateRelease = 'candidate-qualified';
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.hosts.main.operationId = 'not-a-public-uuid';
  fs.writeFileSync(f.stateFile, JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(f.cycle(), { reason: 'durable_state_invalid' });
  assert.equal(f.calls.some(call => call.startsWith('control:') || call.startsWith('activate:')), false);
});

test('short cycle aborts slow read-only adapter and persists only bounded non-sensitive metadata', async t => {
  const f = fixture(t);
  f.adapter.inspectHost = async (_host, _request, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(syntheticError('cycle_deadline')), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const result = await f.cycle({ cycleMs: 20 });
    assert.equal(result.hosts.main.reason, 'cycle_deadline');
    assert.equal(result.hosts.main.accepted, false);
    assert.equal(f.calls.includes('activate:main'), false);
  } finally { clearTimeout(keepAlive); }
});

test('public request has fixed host allowlist and rejects unrecognized credential/config fields', t => {
  const f = fixture(t);
  assert.equal(validateDeploymentRequest(f.request), f.request);
  assert.throws(() => validateDeploymentRequest({ ...f.request, credential: 'synthetic-disallowed' }), { reason: 'invalid_public_request' });
  const changed = { ...f.request, hosts: [{ ...f.request.hosts[0], id: 'arbitrary-command-host' }] };
  assert.throws(() => validateDeploymentRequest(changed), { reason: 'invalid_host_binding' });
});

test('private UNIX client performs actual epoch-fenced controller protocol and rejects unsafe pointer', async t => {
  const f = fixture(t);
  const host = f.hosts.get('main');
  await host.authority.startController();
  t.after(() => host.authority.stopController());
  const pointer = readControllerPointer(host.authority.controllerFile);
  const observed = await requestController(host.authority.controllerFile, { action: 'status' });
  assert.equal(observed.runtimeEpoch, pointer.runtimeEpoch);
  const ownerToken = randomUUID();
  const lease = await requestController(host.authority.controllerFile, { action: 'acquire',
    runtimeEpoch: pointer.runtimeEpoch, ownerToken, releaseId: 'fixture-qualified', ttlMs: 120_000 });
  const sealed = await requestController(host.authority.controllerFile, { action: 'seal',
    runtimeEpoch: pointer.runtimeEpoch, ownerToken, generation: lease.generation, ttlMs: 120_000 });
  assert.equal(sealed.httpIngressDrainProven, true);
  await assert.rejects(requestController(host.authority.controllerFile, { action: 'release',
    runtimeEpoch: randomUUID(), ownerToken, generation: lease.generation }), { reason: 'runtime_epoch_mismatch' });
  await requestController(host.authority.controllerFile, { action: 'release', runtimeEpoch: pointer.runtimeEpoch,
    ownerToken, generation: lease.generation });
  fs.chmodSync(host.authority.controllerFile, 0o644);
  assert.throws(() => readControllerPointer(host.authority.controllerFile), { reason: 'controller_pointer_not_private' });
  fs.chmodSync(host.authority.controllerFile, 0o600);
});

test('systemd watcher source renders finite isolated ticks and immutable explicit paths, not installed effects', t => {
  const f = fixture(t);
  const unit = renderDeferredDeploymentUnits({ request: f.request,
    requestFile: path.join(f.directory, 'request.json'), stateFile: f.stateFile,
    adapterFile: path.join(f.directory, 'adapter.mjs'), coordinatorFile: '/root/projects/code-ai/ops/deferred-deployment/coordinator.mjs',
    nodeExecutable: '/usr/bin/node', serviceUser: 'root', writablePaths: ['/mnt/synthetic-qualified-build'] });
  assert.equal(unit.name, `code-ai-deferred-deployment-${f.request.deploymentId}`);
  for (const expected of ['Type=oneshot', 'User=root', 'UMask=0077', 'TimeoutStartSec=45s',
    '"--nonblock" "--close" "--conflict-exit-code=75"', 'SuccessExitStatus=75', 'ProtectSystem=strict']) {
    assert.ok(unit.service.includes(expected), 'required finite private service contract');
  }
  assert.ok(unit.timer.includes('OnUnitInactiveSec=15s'));
  assert.ok(unit.timer.includes('OnBootSec=30s'));
  assert.equal(fs.existsSync(unit.stateDirectory), false, 'render does not install or create private state');
  assert.equal(unit.service.includes('systemctl'), false, 'source renderer does not invoke service management');
  assert.equal(unit.service.includes(f.request.candidate.serverSha256), false, 'candidate JSON not embedded into command');
});

test('systemd path quoting neutralizes specifiers and rejects broad roots or newline injection', t => {
  const f = fixture(t);
  const config = { request: f.request, requestFile: '/tmp/%%h-request.json', stateFile: f.stateFile,
    adapterFile: '/tmp/adapter.mjs', coordinatorFile: '/tmp/coordinator.mjs', nodeExecutable: '/usr/bin/node', serviceUser: 'root' };
  const quoted = renderDeferredDeploymentUnits(config);
  assert.ok(quoted.service.includes('"/tmp/%%%%h-request.json"'));
  assert.throws(() => renderDeferredDeploymentUnits({ ...config, writablePaths: ['/'] }), { reason: 'unsafe_unit_path' });
  assert.throws(() => renderDeferredDeploymentUnits({ ...config, requestFile: '/tmp/request\nExecStart=bad' }), { reason: 'unsafe_unit_path' });
  assert.throws(() => renderDeferredDeploymentUnits({ ...config, serviceUser: 'root\nExecStart=bad' }), { reason: 'explicit_service_user_required' });
});

test('actual systemd parser validates generated units without loading or installing them', t => {
  const f = fixture(t);
  const units = renderDeferredDeploymentUnits({ request: f.request, requestFile: path.join(f.directory, 'request.json'),
    stateFile: f.stateFile, adapterFile: path.join(f.directory, 'adapter.mjs'),
    coordinatorFile: '/root/projects/code-ai/ops/deferred-deployment/coordinator.mjs',
    nodeExecutable: fs.realpathSync(process.execPath), serviceUser: 'root' });
  const serviceFile = path.join(f.directory, units.name + '.service');
  const timerFile = path.join(f.directory, units.name + '.timer');
  fs.writeFileSync(serviceFile, units.service, { mode: 0o600 });
  fs.writeFileSync(timerFile, units.timer, { mode: 0o600 });
  const parsed = spawnSync('/usr/bin/systemd-analyze', ['verify', '--man=no', serviceFile, timerFile], { encoding: 'utf8', timeout: 5_000 });
  if (parsed.error?.code === 'ENOENT') {
    t.skip('systemd-analyze unavailable in this isolated container; actual host parser requires separate verification');
    return;
  }
  assert.equal(parsed.error, undefined, 'systemd parser invocation must not fail or time out');
  assert.equal(parsed.status, 0, 'source service and timer accepted by real systemd parser');
});

test('actual nonblocking flock permits one coordinator owner and refuses a duplicate before invocation', async t => {
  const f = fixture(t);
  const lock = path.join(f.directory, 'fixture.lock');
  const executable = fs.realpathSync(process.execPath);
  const prefix = ['--nonblock', '--close', '--conflict-exit-code=75', lock, executable];
  const owner = spawn('/usr/bin/flock', [...prefix, '-e', 'process.stdout.write("held\\n"); process.stdin.resume();'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { owner.stdin.end(); if (owner.exitCode === null) owner.kill('SIGTERM'); });
  const closed = new Promise((resolve, reject) => { owner.once('close', resolve); owner.once('error', reject); });
  await new Promise((resolve, reject) => {
    owner.stdout.once('data', chunk => chunk.toString().includes('held') ? resolve() : reject(syntheticError('fixture_lock_unproven')));
    owner.once('error', reject);
  });
  const duplicate = spawnSync('/usr/bin/flock', [...prefix, '-e', 'process.stdout.write("must-not-run\\n");'], { encoding: 'utf8' });
  assert.equal(duplicate.status, 75);
  assert.equal(duplicate.stdout, '');
  owner.stdin.end();
  assert.equal(await closed, 0);
  const successor = spawnSync('/usr/bin/flock', [...prefix, '-e', 'process.stdout.write("ran\\n");'], { encoding: 'utf8' });
  assert.equal(successor.status, 0);
  assert.equal(successor.stdout, 'ran\n');
});
