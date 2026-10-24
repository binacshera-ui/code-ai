import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const LEASE_FORMAT = 'code-ai-deployment-drain-lease';
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 120_000;
const MAX_CONTROL_BYTES = 8_192;
const REQUIRED_PARTICIPANTS = ['queue', 'agent', 'terminal', 'native-codex', 'http-writes', 'http-peers'];
const MAX_PEER_REQUESTS = 128;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class CodexDeploymentDrainError extends Error {
  constructor(reason = 'maintenance_active') {
    super('Code AI is preserving this request while a deployment drain is active.');
    this.name = 'CodexDeploymentDrainError';
    this.code = 'CODE_AI_DEPLOYMENT_DRAIN';
    this.reason = reason;
  }
}

export function isCodexDeploymentDrainError(error) {
  return error?.code === 'CODE_AI_DEPLOYMENT_DRAIN';
}

function controlError(reason) {
  const error = new Error('Deployment drain control request was refused.');
  error.code = 'CODE_AI_DEPLOYMENT_CONTROL';
  error.reason = reason;
  return error;
}

function checkPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0) {
    throw controlError('control_directory_not_private');
  }
}

function preparePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkPrivateDirectory(directory);
}

function writePrivateJson(file, value) {
  preparePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTROL_BYTES
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0) {
    throw controlError('lease_unreadable');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateLease(lease) {
  if (!lease || lease.format !== LEASE_FORMAT || lease.version !== 1
    || !UUID.test(lease.ownerToken) || !UUID.test(lease.generation)
    || !SAFE_ID.test(lease.releaseId) || !Number.isSafeInteger(lease.expiresAt)
    || !Number.isSafeInteger(lease.createdAt) || !Number.isSafeInteger(lease.renewedAt)
    || lease.expiresAt - lease.renewedAt < MIN_LEASE_MS
    || lease.expiresAt - lease.renewedAt > MAX_LEASE_MS
    || !['draining', 'sealed'].includes(lease.phase)
    || (lease.phase === 'sealed' && (!UUID.test(lease.sealId) || !UUID.test(lease.runtimeEpoch)))) {
    throw controlError('lease_unreadable');
  }
  return lease;
}

function localProcessIdentity(pid = process.pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) throw controlError('process_identity_unavailable');
  const root = `/proc/${pid}`;
  const uid = fs.statSync(root).uid;
  const stat = fs.readFileSync(`${root}/stat`, 'utf8');
  const boundary = stat.lastIndexOf(')');
  const startTime = stat.slice(boundary + 2).split(' ')[19];
  const pidNamespace = String(fs.statSync(`${root}/ns/pid`).ino);
  if (boundary < 0 || !/^\d+$/.test(startTime || '') || !/^\d+$/.test(pidNamespace)) throw controlError('process_identity_unavailable');
  return { pid, uid, startTime, pidNamespace };
}

function sameProcess(left, right) {
  return left.pid === right.pid && left.startTime === right.startTime && left.pidNamespace === right.pidNamespace;
}

function processProvenGone(identity) {
  try { return !sameProcess(localProcessIdentity(identity.pid), identity); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return false;
    try { process.kill(identity.pid, 0); return false; }
    catch (probe) { return probe.code === 'ESRCH'; }
  }
}

/**
 * One file-backed queue owns one drain authority. Lease mutations and actual
 * launch admission are synchronous in that owner's event loop: there is no
 * await between checking the fence and reserving a tracked launch ticket.
 * A live ticket admits only continuation of already-reserved work, never a
 * new request. This does not coordinate an old runtime lacking these hooks.
 */
export function createCodexDeploymentDrain({ queueRoot, clock = Date.now, requiredParticipants = REQUIRED_PARTICIPANTS,
  executionEnabled = true, requiredHttpPeers = [] }) {
  if (typeof queueRoot !== 'string' || !path.isAbsolute(queueRoot)) {
    throw controlError('invalid_queue_root');
  }
  const root = path.join(queueRoot, 'deployment-drain');
  const leaseFile = path.join(root, 'lease.json');
  const controllerFile = path.join(root, 'controller.json');
  const runtimeEpoch = randomUUID();
  if (!Array.isArray(requiredParticipants) || requiredParticipants.some(name => !SAFE_ID.test(name))) {
    throw controlError('invalid_required_participants');
  }
  const participantNames = [...new Set([...requiredParticipants, 'http-peers'])];
  const participants = new Map();
  const admissions = new Map();
  if (!Array.isArray(requiredHttpPeers) || requiredHttpPeers.length > 32
    || requiredHttpPeers.some(id => !SAFE_ID.test(id)) || new Set(requiredHttpPeers).size !== requiredHttpPeers.length) {
    throw controlError('invalid_required_http_peers');
  }
  const peers = new Map();
  const controlSockets = new Set();
  let controlServer = null;

  function readLease() {
    try {
      const lease = validateLease(readPrivateJson(leaseFile));
      return lease.expiresAt > clock() ? lease : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw controlError('lease_unreadable');
    }
  }

  function acquireAdmission(kind, continuationTicket) {
    if (!executionEnabled) throw new CodexDeploymentDrainError('execution_disabled');
    if (!SAFE_ID.test(kind)) throw controlError('invalid_admission_kind');
    const isContinuation = continuationTicket !== undefined;
    if (isContinuation && !admissions.has(continuationTicket)) {
      throw new CodexDeploymentDrainError('invalid_continuation_ticket');
    }
    if (!isContinuation) {
      let lease;
      try { lease = readLease(); } catch { throw new CodexDeploymentDrainError('lease_unreadable'); }
      if (lease) throw new CodexDeploymentDrainError('maintenance_active');
    }
    const ticket = Object.freeze({
      release() { admissions.delete(ticket); },
    });
    admissions.set(ticket, kind);
    return ticket;
  }

  function acquireHttpAdmission() {
    let lease;
    try { lease = readLease(); } catch { throw new CodexDeploymentDrainError('lease_unreadable'); }
    if (lease?.phase === 'sealed') throw new CodexDeploymentDrainError('maintenance_sealed');
    const ticket = Object.freeze({ release() { admissions.delete(ticket); } });
    admissions.set(ticket, 'http-write');
    return ticket;
  }

  // Only already-admitted native work may use this API to reconcile/reattach.
  // It must never introduce a provider job: callers validate the stable native
  // client request identity before acquiring. Recovery remains a tracked
  // participant and cannot cross the fully sealed cutover boundary.
  function acquireRecoveryAdmission(kind) {
    if (!executionEnabled) throw new CodexDeploymentDrainError('execution_disabled');
    if (!SAFE_ID.test(kind)) throw controlError('invalid_admission_kind');
    let lease;
    try { lease = readLease(); } catch { throw new CodexDeploymentDrainError('lease_unreadable'); }
    if (lease?.phase === 'sealed') throw new CodexDeploymentDrainError('maintenance_sealed');
    const ticket = Object.freeze({ release() { admissions.delete(ticket); } });
    admissions.set(ticket, `recovery-${kind}`);
    return ticket;
  }

  function registerParticipant(name, readStatus) {
    if (!SAFE_ID.test(name) || typeof readStatus !== 'function' || participants.has(name)) {
      throw controlError('invalid_participant');
    }
    participants.set(name, readStatus);
  }

  function settlePeerTickets(peer) {
    for (const ticket of peer.requests.values()) ticket.release();
    peer.requests.clear();
  }

  // A disconnected live peer may still be completing an admitted handler.
  // No timeout, lease age or socket event is a process-death proof.
  function peerCoverage() {
    for (const peer of peers.values()) {
      if (processProvenGone(peer.identity)) {
        settlePeerTickets(peer);
        peer.gone = true;
        peer.socket?.destroy();
      }
    }
    const missing = requiredHttpPeers.some(id => !peers.has(id));
    const disconnected = [...peers.values()].some(peer => !peer.gone && !peer.socket);
    return { ready: !missing && !disconnected,
      active: [...peers.values()].reduce((total, peer) => total + peer.requests.size, 0),
      ...(missing ? { reason: 'required_http_peer_unseen' } : disconnected ? { reason: 'http_peer_disconnected' } : {}) };
  }
  registerParticipant('http-peers', peerCoverage);

  function registerHttpPeer(input, socket) {
    if (!SAFE_ID.test(input.peerId) || !UUID.test(input.peerEpoch)
      || !Array.isArray(input.activeRequestIds) || input.activeRequestIds.length > MAX_PEER_REQUESTS
      || input.activeRequestIds.some(id => !UUID.test(id)) || new Set(input.activeRequestIds).size !== input.activeRequestIds.length) {
      throw controlError('invalid_http_peer_registration');
    }
    const identity = localProcessIdentity(input.pid);
    const owner = localProcessIdentity();
    if (identity.uid !== owner.uid || identity.pidNamespace !== owner.pidNamespace
      || identity.startTime !== input.startTime || identity.pidNamespace !== input.pidNamespace) {
      throw controlError('http_peer_process_identity_mismatch');
    }
    let peer = peers.get(input.peerId);
    if (peer && !processProvenGone(peer.identity)
      && (!sameProcess(peer.identity, identity) || peer.peerEpoch !== input.peerEpoch)) {
      throw controlError('http_peer_identity_conflict');
    }
    if (!peer || !sameProcess(peer.identity, identity) || peer.peerEpoch !== input.peerEpoch) {
      if (peer) settlePeerTickets(peer);
      if (peers.size >= 64 && !peer) throw controlError('http_peer_capacity');
      peer = { peerId: input.peerId, peerEpoch: input.peerEpoch, identity, requests: new Map(), socket: null, gone: false };
      peers.set(input.peerId, peer);
    }
    // Reconnect inventory is emitted by the same installed passive process
    // before it resumes admission. It includes all handlers still executing;
    // a missing ID had no handler start or already fully settled.
    const inventory = new Set(input.activeRequestIds);
    for (const [id, ticket] of peer.requests) {
      if (!inventory.has(id)) { ticket.release(); peer.requests.delete(id); }
    }
    for (const id of inventory) {
      if (!peer.requests.has(id)) {
        const ticket = Object.freeze({ release() { admissions.delete(ticket); } });
        admissions.set(ticket, `http-peer-${peer.peerId}`);
        peer.requests.set(id, ticket);
      }
    }
    const previous = peer.socket;
    peer.socket = socket;
    peer.gone = false;
    if (previous && previous !== socket) previous.destroy();
    return peer;
  }

  function peerOperation(peer, input) {
    if (!UUID.test(input.requestId)) throw controlError('invalid_http_peer_request');
    if (input.action === 'http-acquire') {
      if (peer.requests.has(input.requestId)) throw controlError('http_peer_request_exists');
      if (peer.requests.size >= MAX_PEER_REQUESTS) throw controlError('http_peer_capacity');
      const ticket = acquireHttpAdmission();
      admissions.set(ticket, `http-peer-${peer.peerId}`);
      peer.requests.set(input.requestId, ticket);
    } else if (input.action === 'http-release') {
      peer.requests.get(input.requestId)?.release();
      peer.requests.delete(input.requestId);
    } else throw controlError('invalid_http_peer_action');
    return { runtimeEpoch, admitted: input.action === 'http-acquire' };
  }

  function status() {
    let lease;
    let leaseReadable = true;
    try { lease = readLease(); } catch { leaseReadable = false; }
    const participantStatus = {};
    let covered = true;
    let quiescent = admissions.size === 0;
    for (const name of participantNames) {
      const reader = participants.get(name);
      if (!reader) {
        covered = false;
        participantStatus[name] = { ready: false, reason: 'participant_not_registered' };
        continue;
      }
      try {
        const value = reader();
        const valid = value && typeof value.ready === 'boolean'
          && Number.isSafeInteger(value.active) && value.active >= 0
          && (value.inFlight === undefined || (Number.isSafeInteger(value.inFlight) && value.inFlight >= 0))
          && (value.persisting === undefined || typeof value.persisting === 'boolean');
        if (!valid) throw controlError('participant_status_invalid');
        // Return counts and bounded reason codes only, never arbitrary callback
        // objects, thread IDs, queued prompts, provider output, or exceptions.
        participantStatus[name] = {
          ready: value.ready,
          active: value.active,
          inFlight: value.inFlight || 0,
          persisting: value.persisting === true,
          ...(SAFE_ID.test(value.reason || '') ? { reason: value.reason } : {}),
        };
        covered &&= value.ready;
        quiescent &&= value.active === 0 && !value.inFlight && value.persisting !== true;
      } catch {
        covered = false;
        participantStatus[name] = { ready: false, reason: 'participant_status_failed' };
      }
    }
    quiescent &&= admissions.size === 0;
    const byKind = {};
    for (const kind of admissions.values()) byKind[kind] = (byKind[kind] || 0) + 1;
    return {
      format: 'code-ai-deployment-drain-status', version: 1,
      runtimeEpoch, runtimePid: process.pid,
      observedAt: clock(), leaseReadable,
      admissionClosed: !leaseReadable || Boolean(lease),
      maintenanceActive: Boolean(lease),
      ownerToken: lease?.ownerToken || null,
      generation: lease?.generation || null,
      releaseId: lease?.releaseId || null,
      expiresAt: lease?.expiresAt || null,
      phase: lease?.phase || null,
      sealId: lease?.sealId || null,
      coverageReady: covered,
      activeAdmissions: admissions.size,
      admissionsByKind: byKind,
      participants: participantStatus,
      // An unfenced idle observation is NEVER a deployment permission.
      drained: Boolean(lease) && leaseReadable && covered && quiescent,
      httpIngressDrainProven: Boolean(lease?.phase === 'sealed') && leaseReadable && covered && quiescent,
    };
  }

  function leaseOperation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw controlError('invalid_request');
    if (input.action === 'status') return status();
    if (input.runtimeEpoch !== runtimeEpoch) throw controlError('runtime_epoch_mismatch');
    if (!UUID.test(input.ownerToken)) throw controlError('invalid_owner_token');
    const current = readLease();
    if (input.action === 'acquire') {
      if (!SAFE_ID.test(input.releaseId)) throw controlError('invalid_release_id');
      if (current) throw controlError('lease_already_active');
    } else if (['renew', 'release', 'seal'].includes(input.action)) {
      if (!current) throw controlError('lease_not_active');
      if (current.ownerToken !== input.ownerToken || current.generation !== input.generation) {
        throw controlError('lease_owner_mismatch');
      }
    } else {
      throw controlError('invalid_action');
    }
    if (input.action === 'release') {
      fs.unlinkSync(leaseFile);
      const descriptor = fs.openSync(root, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return status();
    }
    const ttlMs = input.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_MS || ttlMs > MAX_LEASE_MS) {
      throw controlError('invalid_lease_duration');
    }
    const now = clock();
    const lease = current || {
      format: LEASE_FORMAT, version: 1,
      ownerToken: input.ownerToken, generation: randomUUID(), releaseId: input.releaseId,
      createdAt: now, phase: 'draining', sealId: null, runtimeEpoch: null,
    };
    if (input.action === 'seal') {
      if (!status().drained) throw controlError('runtime_not_drained');
      lease.phase = 'sealed';
      lease.sealId = randomUUID();
      lease.runtimeEpoch = runtimeEpoch;
    }
    lease.renewedAt = now;
    lease.expiresAt = now + ttlMs;
    writePrivateJson(leaseFile, lease);
    return status();
  }

  async function startController() {
    if (process.platform === 'win32') throw controlError('private_control_transport_unsupported');
    if (controlServer) throw controlError('controller_already_started');
    preparePrivateDirectory(root);
    const privateRoot = path.join(root, 'private');
    preparePrivateDirectory(privateRoot);
    try {
      const previous = readPrivateJson(controllerFile);
      if (previous?.runtimeEpoch !== runtimeEpoch && Number.isSafeInteger(previous?.runtimePid) && previous.runtimePid > 0) {
        try { process.kill(previous.runtimePid, 0); } catch (error) {
          if (error.code === 'ESRCH') previous.runtimePid = 0;
          else throw controlError('another_runtime_not_excluded');
        }
        if (previous.runtimePid !== 0) throw controlError('another_runtime_not_excluded');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Unique socket names avoid deleting or taking over another process's
    // socket. The private pointer is published only after listen succeeds.
    const socketPath = path.join(privateRoot, `${runtimeEpoch.slice(0, 12)}.sock`);
    const candidate = net.createServer((socket) => {
      controlSockets.add(socket);
      let buffer = '';
      let handled = false;
      let peer = null;
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on('error', () => {});
      socket.once('close', () => {
        controlSockets.delete(socket);
        if (peer?.socket === socket) peer.socket = null;
      });
      socket.on('data', (chunk) => {
        if (handled) return;
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES * (peer ? MAX_PEER_REQUESTS : 1)) {
          handled = true;
          socket.end(`${JSON.stringify({ ok: false, reason: 'request_too_large' })}\n`);
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let input;
          try {
            if (Buffer.byteLength(raw) > MAX_CONTROL_BYTES) throw controlError('request_too_large');
            input = JSON.parse(raw);
            if (peer) {
              if (peer.socket !== socket) throw controlError('http_peer_connection_replaced');
              if (!UUID.test(input.rpcId)) throw controlError('invalid_http_peer_request');
              const result = peerOperation(peer, input);
              socket.write(`${JSON.stringify({ ok: true, rpcId: input.rpcId, result })}\n`);
            } else if (input.action === 'http-register') {
              if (!UUID.test(input.rpcId)) throw controlError('invalid_http_peer_registration');
              peer = registerHttpPeer(input, socket);
              socket.setTimeout(0);
              socket.write(`${JSON.stringify({ ok: true, rpcId: input.rpcId, result: { runtimeEpoch, registered: true } })}\n`);
            } else {
              handled = true;
              const result = leaseOperation(input);
              socket.end(`${JSON.stringify({ ok: true, result })}\n`);
              return;
            }
          } catch (error) {
            const reason = SAFE_ID.test(error.reason || '') ? error.reason : 'control_request_failed';
            const reply = `${JSON.stringify({ ok: false, ...(UUID.test(input?.rpcId) ? { rpcId: input.rpcId } : {}), reason })}\n`;
            if (peer) socket.write(reply);
            else { handled = true; socket.end(reply); return; }
          }
        }
      });
    });
    await new Promise((resolve, reject) => {
      candidate.once('error', reject);
      candidate.listen(socketPath, resolve);
    });
    try {
      fs.chmodSync(socketPath, 0o600);
      writePrivateJson(controllerFile, {
        format: 'code-ai-deployment-drain-controller', version: 1,
        runtimeEpoch, runtimePid: process.pid, socketPath,
      });
      controlServer = candidate;
      controlServer.unref();
    } catch (error) {
      await new Promise((resolve) => candidate.close(resolve));
      throw error;
    }
    return { runtimeEpoch, socketPath, controllerFile };
  }

  async function stopController() {
    const server = controlServer;
    controlServer = null;
    for (const socket of controlSockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (server) {
      try {
        const pointer = readPrivateJson(controllerFile);
        if (pointer.runtimeEpoch === runtimeEpoch) fs.unlinkSync(controllerFile);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Never remove a live lease: a successor starts fenced and the same
    // coordinator must explicitly release it after post-switch readback.
  }

  return { runtimeEpoch, leaseFile, controllerFile, acquireAdmission, acquireHttpAdmission, acquireRecoveryAdmission,
    registerParticipant, status, leaseOperation, startController, stopController };
}

function privateControllerPointer(controllerFile) {
  const pointer = readPrivateJson(controllerFile);
  const privateRoot = path.join(path.dirname(controllerFile), 'private');
  checkPrivateDirectory(path.dirname(controllerFile));
  checkPrivateDirectory(privateRoot);
  if (pointer?.format !== 'code-ai-deployment-drain-controller' || pointer.version !== 1
    || !UUID.test(pointer.runtimeEpoch) || !Number.isSafeInteger(pointer.runtimePid) || pointer.runtimePid <= 0
    || typeof pointer.socketPath !== 'string' || path.dirname(pointer.socketPath) !== privateRoot) throw controlError('controller_pointer_invalid');
  const socket = fs.lstatSync(pointer.socketPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0
    || socket.uid !== process.getuid()) throw controlError('controller_socket_invalid');
  return pointer;
}

/** Persistent same-UID UDS admission, never a local lease-file approximation. */
export function createCodexDeploymentPassiveHttpAdmission(authority, { peerId = 'uploads', reconnectMs = 1_000 } = {}) {
  if (!authority?.controllerFile || !SAFE_ID.test(peerId) || !Number.isSafeInteger(reconnectMs)
    || reconnectMs < 10 || reconnectMs > 5_000) throw controlError('invalid_http_peer_configuration');
  const identity = localProcessIdentity();
  const peerEpoch = randomUUID();
  const requests = new Set();
  const pending = new Map();
  let socket = null;
  let ownerEpoch = null;
  let connected = false;
  let connecting = null;
  let retry = null;
  let stopped = false;

  const unavailable = reason => new CodexDeploymentDrainError(reason);
  function scheduleReconnect() {
    if (retry || stopped) return;
    retry = setTimeout(() => { retry = null; void start().catch(() => {}); }, reconnectMs);
    retry.unref();
  }

  function rpc(input, connection = socket) {
    if (!connection || connection.destroyed) return Promise.reject(unavailable('http_owner_unavailable'));
    const rpcId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rpcId);
        reject(unavailable('http_owner_unavailable'));
        connection.destroy();
      }, 2_000);
      timer.unref();
      pending.set(rpcId, { resolve, reject, timer, connection });
      connection.write(`${JSON.stringify({ ...input, rpcId })}\n`);
    });
  }

  async function start() {
    if (stopped) throw unavailable('http_peer_stopped');
    if (connected && socket && !socket.destroyed) return;
    if (connecting) return connecting;
    connecting = (async () => {
      let pointer;
      try { pointer = privateControllerPointer(authority.controllerFile); }
      catch { scheduleReconnect(); throw unavailable('http_owner_unavailable'); }
      const connection = net.createConnection(pointer.socketPath);
      socket = connection;
      connection.unref();
      let buffer = '';
      connection.on('error', () => {});
      connection.once('close', () => {
        if (socket === connection) { socket = null; connected = false; ownerEpoch = null; }
        for (const [id, item] of pending) {
          if (item.connection !== connection) continue;
          clearTimeout(item.timer);
          pending.delete(id);
          item.reject(unavailable('http_owner_disconnected'));
        }
        scheduleReconnect();
      });
      connection.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > MAX_CONTROL_BYTES * MAX_PEER_REQUESTS) { connection.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let reply;
          try { reply = JSON.parse(raw); } catch { connection.destroy(); return; }
          const item = pending.get(reply.rpcId);
          if (!item || item.connection !== connection) { connection.destroy(); return; }
          clearTimeout(item.timer);
          pending.delete(reply.rpcId);
          if (reply.ok !== true) {
            item.reject(unavailable(SAFE_ID.test(reply.reason || '') ? reply.reason : 'http_owner_refused'));
          } else if (reply.result?.runtimeEpoch !== pointer.runtimeEpoch) {
            item.reject(unavailable('http_owner_epoch_mismatch'));
            connection.destroy();
          } else item.resolve(reply.result);
        }
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { connection.destroy(); reject(unavailable('http_owner_unavailable')); }, 2_000);
        timer.unref();
        const error = () => { clearTimeout(timer); reject(unavailable('http_owner_unavailable')); };
        connection.once('error', error);
        connection.once('connect', () => { clearTimeout(timer); connection.removeListener('error', error); resolve(); });
      });
      const inventory = [...requests];
      const result = await rpc({ action: 'http-register', peerId, peerEpoch, ...identity,
        activeRequestIds: inventory }, connection);
      if (result.registered !== true || socket !== connection || connection.destroyed) throw unavailable('http_owner_unavailable');
      ownerEpoch = pointer.runtimeEpoch;
      connected = true;
      // An already-running handler may finish while registration is awaiting
      // the owner acknowledgement. Its release happened while disconnected;
      // flush that exact inventory delta before considering reconnect done.
      for (const requestId of inventory) {
        if (!requests.has(requestId)) await rpc({ action: 'http-release', requestId }, connection);
      }
    })();
    try { await connecting; }
    catch (error) { socket?.destroy(); scheduleReconnect(); throw error; }
    finally { connecting = null; }
  }

  async function acquireHttpAdmission() {
    await start();
    if (!connected || !socket || socket.destroyed) throw unavailable('http_owner_disconnected');
    if (requests.size >= MAX_PEER_REQUESTS) throw unavailable('http_peer_capacity');
    const requestId = randomUUID();
    requests.add(requestId);
    try {
      const result = await rpc({ action: 'http-acquire', requestId });
      if (result.admitted !== true || !connected) throw unavailable('http_owner_disconnected');
    } catch (error) {
      requests.delete(requestId);
      if (connected) void rpc({ action: 'http-release', requestId }).catch(() => { scheduleReconnect(); });
      throw error;
    }
    let released = false;
    return Object.freeze({
      assertActive() { if (!connected || !socket || socket.destroyed || stopped) throw unavailable('http_owner_disconnected'); },
      release() {
        if (released) return;
        released = true;
        requests.delete(requestId);
        if (connected) void rpc({ action: 'http-release', requestId }).catch(() => { scheduleReconnect(); });
      },
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(retry);
    retry = null;
    socket?.destroy();
    connected = false;
  }

  return { acquireHttpAdmission, registerParticipant: (...args) => authority.registerParticipant(...args),
    start, stop, getPeerStatus: () => ({ connected, ownerEpoch, active: requests.size }) };
}

export function isProtectedCodexDeploymentHttpRequest(method, requestPath) {
  if (method === 'OPTIONS') return false;
  if (method !== 'GET' && method !== 'HEAD') return true;
  if (!requestPath.startsWith('/api/')) return false;
  // The finite GET queue readers run scheduled transitions and persist state.
  // Protect finite API reads by default rather than guessing from method alone.
  // These three exclusions do not write the queue or launch a provider turn.
  if (requestPath === '/api/codex/remote-agent/health') return false;
  if (/^\/api\/codex\/sessions\/[^/]+\/events$/.test(requestPath)) return false;
  if (requestPath === '/api/codex/session-browser-viewer/stream') return false;
  return true;
}

/** Track both HTTP lifetime AND actual async route-handler settlement. A
 * socket abort is not proof that the handler's pending writes have stopped.
 * Late callbacks re-entering routing after an abort acquire a fresh ticket
 * before invoking the handler, and therefore cannot slip past a sealed fence.
 */
export function createCodexDeploymentHttpTracker(authority) {
  const requests = new WeakMap();
  let active = 0;
  authority.registerParticipant('http-writes', () => ({ ready: true, active }));

  function refuse(res, next, error) {
    if (!isCodexDeploymentDrainError(error)) { next(error); return; }
    if (res.headersSent || res.destroyed) return;
    res.setHeader('Retry-After', '2');
    res.status(503).json({
      error: 'Code AI is completing a deployment; retry this same request shortly.',
      code: 'CODE_AI_DEPLOYMENT_DRAIN', retryable: true,
    });
  }

  function ensureRequest(req, res) {
    let current = requests.get(req);
    if (current) return current.waiting || current;
    const requestPath = String(req.originalUrl || req.path || '').split('?')[0];
    if (!isProtectedCodexDeploymentHttpRequest(req.method, requestPath)) return null;
    const ticket = authority.acquireHttpAdmission();
    current = { ticket: null, waiting: null, handlers: 0,
      closed: Boolean(res.writableEnded || res.destroyed), finished: false };
    requests.set(req, current);
    const releaseIfSettled = () => {
      if (!current.ticket || !current.closed || current.handlers !== 0 || current.finished) return;
      current.finished = true;
      current.ticket.release();
      active -= 1;
      if (requests.get(req) === current) requests.delete(req);
    };
    current.releaseIfSettled = releaseIfSettled;
    const closed = () => { current.closed = true; releaseIfSettled(); };
    res.once('finish', closed);
    res.once('close', closed);
    req.once('aborted', closed);
    const admitted = value => {
      current.ticket = value;
      current.waiting = null;
      active += 1;
      if (current.closed && ticket && typeof ticket.then === 'function') releaseIfSettled();
      return current;
    };
    if (ticket && typeof ticket.then === 'function') {
      current.waiting = Promise.resolve(ticket).then(admitted, error => {
        if (requests.get(req) === current) requests.delete(req);
        throw error;
      });
      return current.waiting;
    }
    admitted(ticket);
    return current;
  }

  function middleware(req, res, next) {
    try {
      const current = ensureRequest(req, res);
      if (current && typeof current.then === 'function') {
        return current.then(value => { if (!value.finished) next(); }, error => refuse(res, next, error));
      }
      next();
    } catch (error) { refuse(res, next, error); }
  }

  const wrapped = new WeakSet();
  function wrapHandlers(router) {
    for (const layer of router.stack || router._router?.stack || []) {
      if (layer.route) {
        for (const handler of layer.route.stack || []) {
          const original = handler.handle;
          if (typeof original !== 'function' || original.length === 4 || wrapped.has(original)) continue;
          const tracked = function (req, res, next) {
            let current;
            try { current = ensureRequest(req, res); } catch (error) { refuse(res, next, error); return; }
            const invoke = value => {
              if (!value) return original(req, res, next);
              if (value.finished) return;
              try { value.ticket.assertActive?.(); } catch (error) { refuse(res, next, error); return; }
              value.handlers += 1;
              let done = false;
              let returned = false;
              let promiseHandler = false;
              let nextCalled = false;
              const settled = () => {
                if (done) return;
                done = true;
                value.handlers -= 1;
                value.releaseIfSettled();
              };
              const trackedNext = (...args) => {
                nextCalled = true;
                if (returned && !promiseHandler) settled();
                return next(...args);
              };
              try {
                const result = original(req, res, trackedNext);
                returned = true;
                if (result && typeof result.then === 'function') {
                  promiseHandler = true;
                  return Promise.resolve(result).then(
                    (result) => { settled(); return result; },
                    (error) => { settled(); throw error; },
                  );
                }
                // Callback-style middleware may still be writing an upload
                // stream after its synchronous return/socket abort. next() is
                // its completion contract; an unknown completion stays held.
                if (original.length < 3 || nextCalled) settled();
                return result;
              } catch (error) { settled(); throw error; }
            };
            if (current && typeof current.then === 'function') return current.then(invoke, error => refuse(res, next, error));
            return invoke(current);
          };
          wrapped.add(tracked);
          handler.handle = tracked;
        }
      } else if (layer.handle?.stack) wrapHandlers(layer.handle);
    }
  }
  return { middleware, wrapHandlers, getActiveCount: () => active };
}

let authority = null;
const pendingParticipants = new Map();
const unconfiguredAdmissions = new Set();

export function configureCodexDeploymentDrain(options) {
  if (authority) throw controlError('already_configured');
  if (unconfiguredAdmissions.size > 0) throw controlError('unconfigured_work_active');
  authority = createCodexDeploymentDrain(options);
  for (const [name, reader] of pendingParticipants) authority.registerParticipant(name, reader);
  pendingParticipants.clear();
  return authority;
}

export function acquireCodexDeploymentAdmission(kind, continuationTicket) {
  if (!authority) {
    // Library imports and isolated tests do not start a production controller.
    // Track such work; configuration refuses to manufacture an idle boundary
    // while it is alive. index configures before opening HTTP ingress.
    if (continuationTicket !== undefined && !unconfiguredAdmissions.has(continuationTicket)) {
      throw new CodexDeploymentDrainError('invalid_continuation_ticket');
    }
    const ticket = Object.freeze({ release() { unconfiguredAdmissions.delete(ticket); } });
    unconfiguredAdmissions.add(ticket);
    return ticket;
  }
  return authority.acquireAdmission(kind, continuationTicket);
}

export function acquireCodexDeploymentRecoveryAdmission(kind) {
  if (!authority) return acquireCodexDeploymentAdmission(`recovery-${kind}`);
  return authority.acquireRecoveryAdmission(kind);
}

export function registerCodexDeploymentDrainParticipant(name, reader) {
  if (authority) authority.registerParticipant(name, reader);
  else {
    if (pendingParticipants.has(name)) throw controlError('invalid_participant');
    pendingParticipants.set(name, reader);
  }
}

export function getCodexDeploymentDrainStatus() {
  if (!authority) throw new CodexDeploymentDrainError('not_configured');
  return authority.status();
}

export function isCodexDeploymentDrainSealed() {
  if (!authority) return false;
  const result = authority.status();
  return !result.leaseReadable || result.phase === 'sealed';
}

export function startCodexDeploymentDrainController() {
  if (!authority) throw new CodexDeploymentDrainError('not_configured');
  return authority.startController();
}

export function stopCodexDeploymentDrainController() {
  return authority?.stopController() || Promise.resolve();
}
