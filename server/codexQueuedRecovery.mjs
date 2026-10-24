import { readFile, lstat, realpath, readlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { NATIVE_FRAME_BYTES, assertNativeHistoryRead } from './codexNativeTransport.mjs';

const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
};
const owned = (r, target) => r && r.threadId === target.threadId && r.clientId === target.clientUserMessageId
  && r.queuedId === target.queuedSubmissionId && r.phase === 'queued' && !r.turnId && !r.turnComplete;

async function readPrivateOwnerFile(file, uid) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o077) || s.size > 1_000_000) throw new Error('Private owner metadata unavailable');
  return JSON.parse(await readFile(file, 'utf8'));
}

/** An application release can precede the native owner's idle-only upgrade.
 * Resolve its pinned predecessor without relaxing the active broker hash gate.
 * Profile plans supply paths only; custody supplies the authoritative hash.
 */
export async function resolveManagedRecoveryBroker({ brokerModule, directory, custody, uid = process.getuid() }) {
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) throw new Error('Private owner directory unavailable');
  if (!/^[a-f0-9]{64}$/.test(custody.brokerModuleSha256)) throw new Error('Native recovery broker version unavailable');
  const matches = async file => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    try {
      const resolved = await realpath(file);
      return createHash('sha256').update(await readFile(resolved)).digest('hex') === custody.brokerModuleSha256 ? resolved : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const preferred = await matches(brokerModule);
  if (preferred) return preferred;
  const plans = (await readdir(directory)).filter(name => /^profile-[a-f0-9-]{36}\.json$/.test(name));
  if (plans.length > 100) throw new Error('Native recovery profile bound exceeded');
  for (const name of plans.sort()) {
    const plan = await readPrivateOwnerFile(path.join(directory, name), uid);
    if (plan.format !== 'code-ai-native-owner-profile' || plan.version !== 1
        || plan.codexHome !== custody.codexHome || plan.ownerDirectory !== directory
        || plan.profileId !== custody.profileId || plan.nativeBinarySha256 !== custody.nativeBinarySha256
        || plan.brokerModuleSha256 !== custody.brokerModuleSha256) continue;
    const pinned = await matches(plan.brokerModule);
    if (pinned) return pinned;
  }
  throw new Error('Native recovery broker version mismatch');
}

/** Start the existing reserved native input, never enqueue/resend or steer a turn.
 * queue/start is native's atomic idle-only operation. The legacy broker keeps
 * its settings reservation and observes the resulting stable user-item ID.
 */
export async function recoverReservedQueuedInput({ rpc, readReservation, ...target }) {
  const record = await readReservation();
  if (!owned(record, target)) return 'not-reserved';
  const state = await rpc('thread/read', { threadId: target.threadId, includeTurns: false });
  if (state.thread?.id !== target.threadId || state.thread?.status?.type !== 'idle') return 'busy';
  const queue = await rpc('thread/queue/list', { threadId: target.threadId, limit: 1 });
  const first = queue.data?.[0];
  if (!first || first.id !== target.queuedSubmissionId || first.clientUserMessageId !== target.clientUserMessageId) return 'not-first';
  const settings = await rpc('thread/resume', { threadId: target.threadId, excludeTurns: true });
  const actual = { model: settings.model, effort: settings.reasoningEffort ?? null, cwd: settings.cwd,
    approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandbox };
  if (!same(actual, record.requested)) throw new Error('Reserved native settings mismatch');
  const fresh = await readReservation();
  if (!owned(fresh, target) || !same(fresh.requested, record.requested)) return 'changed';
  try {
    await rpc('thread/queue/start', { threadId: target.threadId, queuedSubmissionId: target.queuedSubmissionId });
    return 'start-requested';
  } catch (error) {
    // A native idle->busy/dequeue race is known-not-started by this request.
    // A lost acknowledgement is not: propagate it for durable reconciliation.
    if (error.nativeRejected && [-32600, -32602].includes(error.code)) return 'native-race';
    throw error;
  }
}

/** Compatibility recovery for the already-installed broker, with the same
 * private UID/profile/process custody as its runner. No owner restart is needed.
 * This capability is not exposed to browser clients or arbitrary queued inputs.
 */
export async function recoverManagedQueuedSubmission(options) {
  return withManagedNativeConnection(options, async ({rpc, readReservation}) =>
    recoverReservedQueuedInput({...options, rpc, readReservation: () => readReservation(options.threadId)}));
}

/** Read-only compatibility for an older broker. No input, settings or journal
 * writes. Native socket FD/process custody is proved before and after reading.
 */
export async function readManagedNativeHistory({ method, params, ...options }) {
  assertNativeHistoryRead(method, params);
  return withManagedNativeConnection({...options, readOnly:true}, async ({rpc, verifyGeneration}) => {
    const result = await rpc(method, params);
    await verifyGeneration();
    return result;
  });
}

async function withManagedNativeConnection({ codexHome, readOnly = false, brokerModule = fileURLToPath(new URL('./codexSharedOwnerBroker.mjs', import.meta.url)) }, operation) {
  const home = await realpath(codexHome), uid = process.getuid();
  const directory = path.join(path.dirname(home), 'code-ai-native-owner');
  const privateFile = file => readPrivateOwnerFile(file, uid);
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077)) throw new Error('Private owner directory unavailable');
  const custody = await privateFile(path.join(directory, 'ownership.json'));
  if (custody.version !== 2 || custody.codexHome !== home || custody.backendSocket !== path.join(directory, 'engine.sock')) throw new Error('Native owner custody mismatch');
  // Load the pinned CLI module as a module, never inline its executable entry
  // point into the application's bundle (import.meta.url changes under bundling).
  const brokerFile = readOnly ? await realpath(brokerModule)
    : await resolveManagedRecoveryBroker({ brokerModule, directory, custody, uid });
  const { assertPrivateNativeEndpoint, validateBrokerJournal } = await import(pathToFileURL(brokerFile).href);
  await assertPrivateNativeEndpoint(custody.backendSocket, home);
  const socketAddress = await realpath(custody.backendSocket);
  const verifyGeneration = async () => {
    const current = await privateFile(path.join(directory, 'ownership.json'));
    if (!same(current.nativeIdentity, custody.nativeIdentity) || current.nativePid !== custody.nativePid
      || (!readOnly && current.brokerModuleSha256 !== custody.brokerModuleSha256)) throw new Error('Native owner generation changed');
    if ((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim() !== custody.bootId) throw new Error('Native owner boot changed');
    await assertPrivateNativeEndpoint(custody.backendSocket, home);
    if (await realpath(custody.backendSocket) !== socketAddress) throw new Error('Native owner endpoint changed');
    const status = await readFile('/proc/' + custody.nativePid + '/status', 'utf8');
    const stat = await readFile('/proc/' + custody.nativePid + '/stat', 'utf8');
    if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid || /^State:\s+Z\b/m.test(status)
      || stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== custody.nativeIdentity.startTime
      || await realpath('/proc/' + custody.nativePid + '/exe') !== custody.nativeIdentity.executable
      || createHash('sha256').update(await readFile('/proc/' + custody.nativePid + '/cgroup')).digest('hex') !== custody.nativeIdentity.cgroupSha256
      || await readlink('/proc/' + custody.nativePid + '/ns/net') !== custody.nativeIdentity.networkNamespace
      || await readlink('/proc/self/ns/net') !== custody.nativeIdentity.networkNamespace) throw new Error('Native owner identity unavailable');
    // Prove the listening stream FD belongs to the recorded native generation,
    // not merely that a same-UID process created a socket at the expected path.
    const inodes = (await readFile('/proc/net/unix', 'utf8')).split('\n').flatMap(line => {
      const m = /^\S+:\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
      return m && m[5] === socketAddress && /^[a-f0-9]+$/i.test(m[1])
        && (BigInt('0x' + m[1]) & 0x10000n) && m[2] === '0001' && m[3] === '01' ? [m[4]] : [];
    });
    if (inodes.length !== 1) throw new Error('Native recovery listener unavailable');
    let held = false;
    for (const fd of await readdir('/proc/' + custody.nativePid + '/fd')) {
      try { if (await readlink('/proc/' + custody.nativePid + '/fd/' + fd) === 'socket:[' + inodes[0] + ']') held = true; }
      catch { /* Unrelated descriptors may close during enumeration. */ }
    }
    if (!held) throw new Error('Native recovery listener custody unavailable');
  };
  await verifyGeneration();
  await assertPrivateNativeEndpoint(custody.backendSocket, home);
  const ws = new WebSocket(`ws+unix://${custody.backendSocket}:/`, { handshakeTimeout: 5000, maxPayload: NATIVE_FRAME_BYTES, perMessageDeflate: false });
  const pending = new Map(); let next = 0;
  const fail = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Native recovery disconnected')); } pending.clear(); };
  ws.on('close', fail); ws.on('error', fail);
  ws.on('message', (bytes, binary) => {
    if (binary) return ws.terminate();
    let frame; try { frame = JSON.parse(bytes.toString()); } catch { return ws.terminate(); }
    const p = pending.get(frame.id); if (!p) return;
    pending.delete(frame.id); clearTimeout(p.timer);
    if (frame.error) { const e = new Error('Native recovery refused'); e.nativeRejected = true; e.code = frame.error.code; p.reject(e); }
    else p.resolve(frame.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (readOnly && method !== 'initialize') {
      try { assertNativeHistoryRead(method, params); } catch (e) { reject(e); return; }
    }
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('Native recovery unavailable'));
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native recovery acknowledgement unavailable')); }, 8000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Native recovery unavailable'))); });
    const init = await rpc('initialize', { clientInfo: { name: 'code-ai-owned-queue-recovery', version: '1.0' }, capabilities: { experimentalApi: true } });
    if (await realpath(init.codexHome) !== home) throw new Error('Native recovery home mismatch');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return await operation({ rpc, verifyGeneration, readReservation: async threadId => {
      await verifyGeneration();
      return validateBrokerJournal(await privateFile(path.join(directory, 'broker-journal.json'))).find(r => r.threadId === threadId);
    } });
  } finally { ws.terminate(); }
}
