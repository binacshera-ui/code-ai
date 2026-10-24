import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOSTS = new Set(['main', 'beam-10g', 'pci', 'ubuntu-gpu-lab', 'personal-windows-me']);
const BINDING_KEYS = ['buildId', 'importRoot', 'artifactTreeSha256', 'attestationSha256', 'sourceFreezeSha256', 'serverSha256', 'manifestSha256'];
const LEASE_MS = 120_000;
const DEFAULT_CYCLE_MS = 40_000;
const MAX_CYCLE_MS = 45_000;
const UNCERTAIN_PHASES = new Set(['switching', 'verifying', 'rollback_pending']);
const HOST_PHASES = new Set(['pending', 'pending_host', 'blocked_bootstrap', 'blocked_baseline', 'draining', 'sealed', ...UNCERTAIN_PHASES, 'accepted', 'rolled_back']);

function fail(reason) {
  const error = new Error('Deferred Code AI deployment stopped at a safety gate.');
  error.reason = reason;
  return error;
}

function reason(error, fallback) {
  return /^[a-z_]{1,100}$/.test(error?.reason || '') ? error.reason : fallback;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const digest = value => createHash('sha256').update(value).digest('hex');

export function validateDeploymentRequest(request) {
  if (!request || request.format !== 'code-ai-deferred-deployment-request' || request.version !== 1
    || !UUID.test(request.deploymentId) || !SHA256.test(request.adapterSha256)
    || !request.candidate || !UUID.test(request.candidate.buildId)
    || typeof request.candidate.importRoot !== 'string' || !path.isAbsolute(request.candidate.importRoot)
    || !Array.isArray(request.hosts) || request.hosts.length === 0 || request.hosts.length > HOSTS.size) {
    throw fail('invalid_public_request');
  }
  const allowed = ['format', 'version', 'deploymentId', 'createdAt', 'adapterSha256', 'candidate', 'hosts'];
  if (Object.keys(request).some(key => !allowed.includes(key))
    || Object.keys(request.candidate).some(key => !BINDING_KEYS.includes(key))) throw fail('invalid_public_request');
  for (const key of BINDING_KEYS.slice(2)) if (!SHA256.test(request.candidate[key])) throw fail('invalid_candidate_binding');
  const ids = new Set();
  for (const host of request.hosts) {
    if (!host || !HOSTS.has(host.id) || ids.has(host.id)
      || Object.keys(host).some(key => !['id', 'baseline', 'candidateRelease'].includes(key))
      || !host.baseline || !SAFE_ID.test(host.baseline.release)
      || !SHA256.test(host.baseline.serverSha256) || !SAFE_ID.test(host.candidateRelease)
      || Object.keys(host.baseline).some(key => !['release', 'serverSha256'].includes(key))) {
      throw fail('invalid_host_binding');
    }
    ids.add(host.id);
  }
  return request;
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.release === right.release && left.serverSha256 === right.serverSha256);
}

function targetIdentity(host, request) {
  return { release: host.candidateRelease, serverSha256: request.candidate.serverSha256 };
}

function validateQualification(proof, request) {
  if (!proof || proof.verified !== true || proof.fullApplication !== true || proof.productionReady !== true
    || proof.cumulative !== true || proof.acceptancePassed !== true
    || !['dist/server.js', 'dist/public/index.html'].every(file => proof.requiredFiles?.includes(file))) {
    throw fail('full_candidate_not_qualified');
  }
  for (const key of BINDING_KEYS) if (proof[key] !== request.candidate[key]) throw fail('candidate_binding_changed');
}

function privateJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('state_directory_not_private');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, canonical(value) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(directory, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readState(file, request) {
  const requestSha256 = digest(canonical(request));
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('state_file_not_private');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.format !== 'code-ai-deferred-deployment-state' || value.version !== 1
      || value.requestSha256 !== requestSha256 || value.deploymentId !== request.deploymentId
      || !value.hosts || typeof value.hosts !== 'object') throw fail('durable_request_binding_changed');
    if (Object.keys(value.hosts).length !== request.hosts.length) throw fail('durable_state_invalid');
    for (const host of request.hosts) {
      const saved = value.hosts[host.id];
      if (!saved || !HOST_PHASES.has(saved.phase) || !UUID.test(saved.ownerToken)
        || (saved.operationId !== null && !UUID.test(saved.operationId))
        || typeof saved.accepted !== 'boolean' || !Number.isSafeInteger(saved.attempts) || saved.attempts < 0
        || !sameIdentity(saved.baseline, host.baseline) || !sameIdentity(saved.candidate, targetIdentity(host, request))
        || (saved.accepted && saved.phase !== 'accepted')
        || (UNCERTAIN_PHASES.has(saved.phase) && !saved.operationId)
        || (saved.lease !== null && (!UUID.test(saved.lease?.generation) || !UUID.test(saved.lease?.runtimeEpoch)))) {
        throw fail('durable_state_invalid');
      }
    }
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail(reason(error, 'durable_state_unreadable'));
    return {
      format: 'code-ai-deferred-deployment-state', version: 1,
      deploymentId: request.deploymentId, requestSha256,
      state: 'pending', hosts: Object.fromEntries(request.hosts.map(host => [host.id, {
        phase: 'pending', ownerToken: randomUUID(), operationId: null,
        lease: null, baseline: host.baseline, candidate: targetIdentity(host, request),
        accepted: false, attempts: 0, reason: null,
      }])),
    };
  }
}

function leaseMatches(observed, hostState) {
  return Boolean(observed.maintenanceActive && observed.ownerToken === hostState.ownerToken
    && observed.generation === hostState.lease?.generation);
}

function validateControl(observed) {
  if (observed?.format !== 'code-ai-deployment-drain-status' || observed.version !== 1
    || !UUID.test(observed.runtimeEpoch) || !Number.isSafeInteger(observed.runtimePid) || observed.runtimePid <= 0
    || !['maintenanceActive', 'leaseReadable', 'coverageReady', 'drained', 'httpIngressDrainProven'].every(key => typeof observed[key] === 'boolean')
    || (observed.maintenanceActive && (!UUID.test(observed.ownerToken) || !UUID.test(observed.generation)
      || !SAFE_ID.test(observed.releaseId) || !Number.isSafeInteger(observed.expiresAt)
      || !['draining', 'sealed'].includes(observed.phase)))) throw fail('controller_status_invalid');
  return observed;
}

/**
 * One bounded tick, externally serialized by systemd/flock. A host adapter
 * owns actual platform commands and canonical BEAM verification. It must
 * respect context.signal/deadlineAt, and reconcile durable operation IDs.
 * No mutation is inferred from queue snapshots or unsupported old runtimes.
 */
export async function runDeploymentCycle({ request, stateFile, adapter, clock = Date.now, cycleMs = DEFAULT_CYCLE_MS }) {
  validateDeploymentRequest(request);
  if (!path.isAbsolute(stateFile) || !Number.isSafeInteger(cycleMs) || cycleMs < 1 || cycleMs > MAX_CYCLE_MS) {
    throw fail('invalid_cycle_configuration');
  }
  for (const name of ['verifyCandidate', 'inspectHost', 'control', 'activate', 'reconcile', 'readiness', 'rollback']) {
    if (typeof adapter?.[name] !== 'function') throw fail('host_adapter_incomplete');
  }
  const state = readState(stateFile, request);
  if (state.state === 'accepted') return publicStatus(state);
  const deadlineAt = clock() + cycleMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cycleMs);
  timer.unref();
  const save = () => { state.updatedAt = clock(); privateJson(stateFile, state); };
  const context = (operationId) => ({ signal: controller.signal, deadlineAt, operationId });
  const call = async (name, args, operationId = null) => {
    if (controller.signal.aborted || clock() >= deadlineAt) throw fail('cycle_deadline');
    const pending = Promise.resolve().then(() => adapter[name](...args, context(operationId)));
    let aborted;
    const timedOut = new Promise((_, reject) => {
      aborted = () => reject(fail('cycle_deadline'));
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    try { return await Promise.race([pending, timedOut]); }
    finally { controller.signal.removeEventListener('abort', aborted); }
  };

  const updateLease = (hostState, observed) => {
    hostState.lease = {
      runtimeEpoch: observed.runtimeEpoch, generation: observed.generation,
      expiresAt: observed.expiresAt, phase: observed.phase, sealId: observed.sealId,
    };
    save();
  };

  const getControl = async host => validateControl(await call('control', [host, { action: 'status' }]));
  const changeControl = async (host, hostState, action, observed) => validateControl(await call('control', [host, {
    action, runtimeEpoch: observed.runtimeEpoch, ownerToken: hostState.ownerToken,
    generation: hostState.lease?.generation, releaseId: host.candidateRelease, ttlMs: LEASE_MS,
  }]));

  const ensureLease = async (host, hostState) => {
    let observed = await getControl(host);
    if (!observed.leaseReadable || !observed.coverageReady) throw fail('admission_coverage_unqualified');
    if (observed.maintenanceActive) {
      if (observed.ownerToken !== hostState.ownerToken || observed.releaseId !== host.candidateRelease
        || (hostState.lease && !leaseMatches(observed, hostState))) throw fail('foreign_maintenance_lease');
      // A crash may occur after acquisition but before persisting generation.
      // Its already-persisted unique owner + immutable release safely adopts
      // only this request's lease, never another controller's maintenance.
      if (!hostState.lease) updateLease(hostState, observed);
      observed = await changeControl(host, hostState, 'renew', observed);
    } else observed = await changeControl(host, hostState, 'acquire', observed);
    if (!observed.maintenanceActive || observed.ownerToken !== hostState.ownerToken
      || observed.releaseId !== host.candidateRelease || observed.expiresAt <= clock()) throw fail('lease_receipt_unproven');
    updateLease(hostState, observed);
    return observed;
  };

  const sealLease = async (host, hostState) => {
    let observed = await ensureLease(host, hostState);
    if (!observed.drained) return null;
    observed = await changeControl(host, hostState, 'seal', observed);
    if (!observed.drained || !observed.httpIngressDrainProven || observed.phase !== 'sealed'
      || !UUID.test(observed.sealId) || !leaseMatches(observed, hostState)) throw fail('sealed_boundary_unproven');
    updateLease(hostState, observed);
    return observed;
  };

  const unfence = async (host, hostState) => {
    const observed = await getControl(host);
    if (!observed.maintenanceActive) { hostState.lease = null; save(); return; }
    if (!leaseMatches(observed, hostState)) throw fail('foreign_maintenance_lease');
    const released = await changeControl(host, hostState, 'release', observed);
    if (released.maintenanceActive) throw fail('lease_release_unproven');
    hostState.lease = null;
    save();
  };

  const rollback = async (host, hostState) => {
    hostState.phase = 'rollback_pending';
    save();
    // The coordinator may have crashed longer than the bounded lease. Never
    // roll a successor back under newly admitted work: establish a fresh sealed
    // boundary and wait for its ordinary completions first.
    const seal = await sealLease(host, hostState);
    if (!seal) { hostState.reason = 'rollback_waiting_for_drain'; save(); return; }
    const result = await call('rollback', [host, request, {
      operationId: hostState.operationId, baseline: hostState.baseline, seal,
    }], hostState.operationId);
    if (!sameIdentity(result?.releaseIdentity, hostState.baseline)) throw fail('rollback_identity_unproven');
    const verified = await call('reconcile', [host, request, {
      operationId: hostState.operationId, expectedBaseline: hostState.baseline,
    }], hostState.operationId);
    if (verified.state !== 'baseline' || verified.operationSettled !== true || verified.readiness !== true
      || !sameIdentity(verified.releaseIdentity, hostState.baseline)) throw fail('rollback_readiness_unproven');
    await unfence(host, hostState);
    hostState.phase = 'rolled_back';
    hostState.reason = 'candidate_readiness_failed';
    save();
  };

  const verifyAccepted = async (host, hostState) => {
    hostState.phase = 'verifying';
    save();
    const health = await call('readiness', [host, request], hostState.operationId);
    if (health?.ready !== true || !sameIdentity(health.releaseIdentity, hostState.candidate)) {
      await rollback(host, hostState);
      return;
    }
    await unfence(host, hostState);
    hostState.phase = 'accepted';
    hostState.accepted = true;
    hostState.reason = null;
    save();
  };

  try {
    save();
    // Canonical artifact+attestation verification precedes every new drain.
    const proof = await call('verifyCandidate', [request]);
    validateQualification(proof, request);
    state.reason = null;
    for (const host of request.hosts) {
      if (clock() >= deadlineAt || controller.signal.aborted) break;
      const hostState = state.hosts[host.id];
      if (hostState.accepted || hostState.phase === 'rolled_back') continue;
      hostState.reason = null;
      try {
        const observed = await call('inspectHost', [host, request]);
        if (observed?.reachable !== true) {
          hostState.reason = 'host_unreachable';
          // Preserve switching state across disconnection: it must reconcile,
          // never blindly activate again after the managed channel returns.
          if (!UNCERTAIN_PHASES.has(hostState.phase)) hostState.phase = 'pending_host';
          save();
          continue;
        }
        if (observed.gateSupported !== true) {
          if (!UNCERTAIN_PHASES.has(hostState.phase)) hostState.phase = 'blocked_bootstrap';
          hostState.reason = 'bootstrap_gate_unsupported';
          save();
          continue;
        }

        if (UNCERTAIN_PHASES.has(hostState.phase)) {
          // Keep an existing own lease alive during outcome/readiness checks.
          // If it expired, acquiring it pauses only new work; rollback still
          // requires a fresh zero-work seal above.
          await ensureLease(host, hostState);
          const reconciliation = await call('reconcile', [host, request, {
            operationId: hostState.operationId, expectedBaseline: hostState.baseline,
          }], hostState.operationId);
          if (reconciliation.operationSettled !== true || reconciliation.state === 'indeterminate') {
            hostState.reason = 'activation_outcome_unproven';
            save();
            continue;
          }
          if (hostState.phase === 'rollback_pending' && reconciliation.state === 'baseline'
            && sameIdentity(reconciliation.releaseIdentity, hostState.baseline) && reconciliation.readiness === true) {
            await unfence(host, hostState);
            hostState.phase = 'rolled_back';
            hostState.reason = 'candidate_readiness_failed';
            save();
            continue;
          }
          if (hostState.phase === 'rollback_pending') { await rollback(host, hostState); continue; }
          if (reconciliation.state === 'candidate' && sameIdentity(reconciliation.releaseIdentity, hostState.candidate)) {
            await verifyAccepted(host, hostState);
            continue;
          }
          if (reconciliation.state !== 'baseline' || !sameIdentity(reconciliation.releaseIdentity, hostState.baseline)) {
            throw fail('activation_identity_unproven');
          }
          // Definite baseline, no outstanding operation: retry at a new sealed
          // boundary on a later cycle, not blindly in this reconciling cycle.
          await unfence(host, hostState);
          hostState.phase = 'pending';
          hostState.reason = 'baseline_reconciled';
          save();
          continue;
        }

        if (!sameIdentity(observed.releaseIdentity, hostState.baseline)) {
          if (hostState.lease) await unfence(host, hostState);
          hostState.phase = 'blocked_baseline';
          hostState.reason = 'accepted_baseline_changed';
          save();
          continue;
        }
        let drain = await ensureLease(host, hostState);
        hostState.phase = 'draining';
        save();
        if (!drain.drained) continue;

        // A successor release appearing during waiting invalidates this whole
        // request lineage. The platform adapter rechecks this at activation.
        const beforeSeal = await call('inspectHost', [host, request]);
        if (!sameIdentity(beforeSeal.releaseIdentity, hostState.baseline)) {
          await unfence(host, hostState);
          hostState.phase = 'blocked_baseline';
          hostState.reason = 'accepted_baseline_changed';
          save();
          continue;
        }
        drain = await changeControl(host, hostState, 'seal', drain);
        if (!drain.drained || !drain.httpIngressDrainProven || drain.phase !== 'sealed') throw fail('sealed_boundary_unproven');
        updateLease(hostState, drain);
        hostState.phase = 'sealed';
        save();
        hostState.operationId = randomUUID();
        hostState.attempts += 1;
        hostState.phase = 'switching';
        save(); // Crash recovery always sees the ID BEFORE external mutation.
        const activation = await call('activate', [host, request, {
          operationId: hostState.operationId, seal: drain, expectedBaseline: hostState.baseline,
        }], hostState.operationId);
        if (activation?.operationId !== hostState.operationId
          || !sameIdentity(activation.releaseIdentity, hostState.candidate)) throw fail('activation_receipt_unproven');
        await verifyAccepted(host, hostState);
      } catch (error) {
        hostState.reason = reason(error, 'host_operation_failed');
        // A persisted switching/verifying state must reconcile after any
        // uncertainty. Never treat a transport error as a completed swap.
        save();
      }
    }
    const values = Object.values(state.hosts);
    state.state = values.every(host => host.accepted) ? 'accepted'
      : values.some(host => UNCERTAIN_PHASES.has(host.phase)) ? 'reconciling'
      : values.some(host => host.phase.startsWith('blocked') || host.phase === 'rolled_back') ? 'blocked'
      : 'waiting';
    save();
    return publicStatus(state);
  } catch (error) {
    state.state = 'blocked';
    state.reason = reason(error, 'candidate_verification_failed');
    // Never leave ordinary drains indefinitely paused after qualification
    // fails; bounded lease expiry is a fail-safe if the controller is offline.
    for (const host of request.hosts) {
      const hostState = state.hosts[host.id];
      if (!hostState.lease || UNCERTAIN_PHASES.has(hostState.phase)) continue;
      try { await unfence(host, hostState); } catch {}
    }
    save();
    return publicStatus(state);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function publicStatus(state) {
  return {
    format: 'code-ai-deferred-deployment-cycle', version: 1,
    deploymentId: state.deploymentId, state: state.state,
    reason: state.reason || null,
    hosts: Object.fromEntries(Object.entries(state.hosts).map(([id, host]) => [id, {
      phase: host.phase, accepted: host.accepted, attempts: host.attempts,
      reason: host.reason, release: host.accepted ? host.candidate.release : null,
    }])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== '--request' || args[2] !== '--state' || args[4] !== '--adapter'
      || ![args[1], args[3], args[5]].every(value => path.isAbsolute(value))) throw fail('explicit_private_configuration_required');
    const request = validateDeploymentRequest(JSON.parse(fs.readFileSync(args[1], 'utf8')));
    const adapterFile = fs.realpathSync(args[5]);
    const adapterBytes = fs.readFileSync(adapterFile);
    if (digest(adapterBytes) !== request.adapterSha256) throw fail('host_adapter_binding_changed');
    const module = await import(pathToFileURL(adapterFile).href);
    const adapter = await module.createAdapter({ request });
    console.log(JSON.stringify(await runDeploymentCycle({ request, stateFile: args[3], adapter })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, reason: reason(error, 'coordinator_failed') }));
    process.exitCode = 1;
  }
}
