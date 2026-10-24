/**
 * Local, same-UID admission adapter for ONE native Codex app-server.
 * Native Codex remains the sole queue/history/model executor. This adapter never
 * stores prompts, creates a rollout, deletes a lock, or starts another owner.
 * The optional product queue field pins model/effort by reserving an otherwise
 * empty native queue, publishing future settings, then using native queue/add.
 * All cooperating desktop/IDE/Code AI clients must enter through this boundary.
 */
import { createServer } from 'node:http';
import { lstat, realpath, open, rename, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { nativeRpcTimeoutMs, publicRpcDiagnostic, validatePublicRpcDiagnostic } from './codexRpcDiagnostic.mjs';
import { NATIVE_FRAME_BYTES, NATIVE_BUFFER_BYTES } from './codexNativeTransport.mjs';
import { readSharedHistoryTurns } from './codexSharedHistory.mjs';

const MAX_BYTES = NATIVE_FRAME_BYTES;
const MAX_PENDING_CALLS = 256;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const OBJECT = value => value && typeof value === 'object' && !Array.isArray(value);
const MODEL = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const ID = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const ABSOLUTE = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value)
  && !/[\0\r\n]/.test(value);
function approvalPolicy(value) {
  if (['never', 'on-request', 'untrusted'].includes(value)) return true;
  if (!OBJECT(value) || Object.keys(value).length !== 1 || !OBJECT(value.granular)) return false;
  const allowed = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
  return Object.keys(value.granular).every(key => allowed.includes(key) && typeof value.granular[key] === 'boolean')
    && ['sandbox_approval', 'rules', 'mcp_elicitations'].every(key => Object.hasOwn(value.granular, key));
}
function sandboxPolicy(value) {
  if (!OBJECT(value)) return false;
  if (value.type === 'dangerFullAccess') return Object.keys(value).length === 1;
  if (value.type === 'readOnly') return Object.keys(value).every(key => ['type', 'networkAccess'].includes(key))
    && (value.networkAccess === undefined || typeof value.networkAccess === 'boolean');
  if (value.type === 'externalSandbox') return Object.keys(value).every(key => ['type', 'networkAccess'].includes(key))
    && (value.networkAccess === undefined || ['enabled', 'restricted'].includes(value.networkAccess));
  if (value.type !== 'workspaceWrite') return false;
  return Object.keys(value).every(key => ['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].includes(key))
    && (value.writableRoots === undefined || (Array.isArray(value.writableRoots)
      && value.writableRoots.length <= 128 && value.writableRoots.every(ABSOLUTE)))
    && ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].every(key =>
      value[key] === undefined || typeof value[key] === 'boolean');
}
function normalizeSandbox(value) {
  if (value.type === 'readOnly') return { type: value.type, networkAccess: value.networkAccess ?? false };
  if (value.type === 'externalSandbox') return { type: value.type, networkAccess: value.networkAccess ?? 'restricted' };
  if (value.type === 'workspaceWrite') return { type: value.type, writableRoots: value.writableRoots ?? [],
    networkAccess: value.networkAccess ?? false, excludeTmpdirEnvVar: value.excludeTmpdirEnvVar ?? false,
    excludeSlashTmp: value.excludeSlashTmp ?? false };
  return { type: 'dangerFullAccess' };
}
/** Native built-in IDs changed spelling between desktop/CLI releases.
 * A recognized ID is restorable only when its actual sandbox kind matches.
 * Custom profiles, inherited profiles and contradictory snapshots fail closed.
 */
export function isRestorableNativePermissionProfile(profile, sandbox) {
  if (profile == null) return true; // Older native versions omit this metadata.
  if (!OBJECT(profile) || profile.extends != null || !OBJECT(sandbox)) return false;
  const builtinKinds = {
    ':read-only': 'readOnly',
    ':workspace': 'workspaceWrite',
    ':workspace-write': 'workspaceWrite',
    ':full-access': 'dangerFullAccess',
    ':danger-full-access': 'dangerFullAccess',
  };
  return Object.hasOwn(builtinKinds, profile.id) && builtinKinds[profile.id] === sandbox.type;
}
const SETTINGS = value => OBJECT(value) && Object.keys(value).length === 5
  && Object.keys(value).every(key => ['model', 'effort', 'cwd', 'approvalPolicy', 'sandboxPolicy'].includes(key))
  && MODEL(value.model) && (value.effort === null || EFFORTS.has(value.effort))
  && ABSOLUTE(value.cwd) && approvalPolicy(value.approvalPolicy) && sandboxPolicy(value.sandboxPolicy);
const GLOBAL_WRITES = /^(config\/(value\/write|batchWrite|mcpServer\/reload)|experimentalFeature\/enablement\/set)$/;
function sameSetting(a, b, depth = 0) {
  if (depth > 20) return false;
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length
    && a.every((value, index) => sameSetting(value, b[index], depth + 1));
  if (!OBJECT(a) || !OBJECT(b)) return false;
  const keys = Object.keys(a).sort();
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && sameSetting(a[key], b[key], depth + 1));
}
function baselineShape(value) {
  return OBJECT(value) && typeof value.cwd === 'string' && path.isAbsolute(value.cwd)
    && Object.hasOwn(value, 'approvalPolicy') && OBJECT(value.sandbox)
    && ['cwd', 'approvalPolicy', 'sandbox', 'modelProvider', 'serviceTier'].every(key =>
      !Object.hasOwn(value, key) || value[key] !== undefined)
    && Object.keys(value).every(key => ['cwd', 'approvalPolicy', 'sandbox', 'modelProvider', 'serviceTier'].includes(key))
    && JSON.stringify(value).length < 64 * 1024;
}

export class BrokerRefusal extends Error {
  constructor(reason, code = -32001) {
    super('Shared native admission temporarily unavailable; input was not accepted');
    this.code = code;
    this.reason = reason;
    this.delivery = 'notAccepted';
  }
}

/** Exact metadata-only journal. Unknown fields (including prompts/config) fail closed. */
export function validateBrokerJournal(value) {
  if (!OBJECT(value) || Object.keys(value).some(k => !['format', 'version', 'records'].includes(k))
      || value.format !== 'code-ai-native-owner-reservations' || value.version !== 1
      || !Array.isArray(value.records) || value.records.length > 1000) throw new Error('Invalid reservation journal');
  const seen = new Set();
  for (const record of value.records) {
    if (!OBJECT(record) || Object.keys(record).some(k => ![
      'threadId', 'clientId', 'queuedId', 'turnId', 'phase', 'previous', 'requested',
      'createdAt', 'turnComplete', 'collaborationMode',
    ].includes(k)) || !ID(record.threadId) || !ID(record.clientId) || seen.has(record.threadId)
        || !(record.queuedId === null || ID(record.queuedId))
        || !(record.turnId === null || ID(record.turnId))
        || !['prepared', 'applied', 'enqueuing', 'queued', 'started', 'released', 'uncertain'].includes(record.phase)
        || !SETTINGS(record.previous) || !SETTINGS(record.requested)
        || !(record.collaborationMode === null || ['default', 'plan'].includes(record.collaborationMode))
        || (['enqueuing', 'queued', 'started'].includes(record.phase) && record.collaborationMode === null)
        || typeof record.turnComplete !== 'boolean' || !Number.isSafeInteger(record.createdAt)) {
      throw new Error('Invalid reservation metadata');
    }
    seen.add(record.threadId);
  }
  return value.records.map(record => structuredClone(record));
}

export async function assertPrivateNativeEndpoint(socketPath, codexHome) {
  if (process.platform === 'win32' || !path.isAbsolute(socketPath) || socketPath.includes(':')
      || !path.isAbsolute(codexHome)) throw new Error('Unsupported private endpoint');
  const uid = process.getuid();
  const home = await realpath(codexHome);
  const link = await lstat(socketPath), parent = await lstat(path.dirname(socketPath));
  const targetPath = await realpath(socketPath);
  const target = await lstat(targetPath), targetParent = await lstat(path.dirname(targetPath));
  if ((!link.isSocket() && !link.isSymbolicLink()) || !target.isSocket()
      || [link, target, parent, targetParent].some(s => s.uid !== uid)
      || (parent.mode & 0o077) || (targetParent.mode & 0o077)) {
    throw new Error('Private endpoint ownership mismatch');
  }
  return { home, targetPath };
}

export async function createReservationJournal(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Absolute journal path required');
  const parentPath = path.dirname(filename);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
    throw new Error('Private journal directory required');
  }
  let records = [];
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 1_000_000) {
      throw new Error('Private journal file required');
    }
    records = validateBrokerJournal(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not load private reservation metadata');
  }
  return {
    records,
    async save(next) {
      const value = { format: 'code-ai-native-owner-reservations', version: 1, records: next };
      validateBrokerJournal(value);
      const serialized = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(serialized) > 1_000_000) throw new Error('Reservation metadata capacity reached');
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filename);
      const dir = await open(parentPath, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    },
  };
}

/** Transport-independent reservation logic, exercised with native and mock owners. */
export class CodexSharedOwnerBroker {
  constructor({ records = [], save = async () => {}, now = Date.now, onChange = () => {} } = {}) {
    this.records = new Map(records.map(record => [record.threadId, record]));
    this.save = save;
    this.now = now;
    this.locks = new Map();
    this.clients = new Map();
    this.persistChain = Promise.resolve();
    this.storageHealthy = true;
    this.preparing = new Set();
    this.globalWriters = 0;
    this.onChange = onChange;
    this.ownerModes = new Map();
    this.freshStates = new Map();
  }

  async persist() {
    // Retain only bounded terminal metadata. Never discard unresolved custody.
    if (this.records.size > 900) for (const [threadId, record] of this.records) {
      if (record.phase === 'released' && record.turnComplete) {
        this.records.delete(threadId); this.clients.delete(threadId);
        if (this.records.size <= 900) break;
      }
    }
    const snapshot = [...this.records.values()].map(record => structuredClone(record));
    this.persistChain = this.persistChain.then(() => this.save(snapshot));
    try { await this.persistChain; this.onChange(); }
    catch { this.storageHealthy = false; throw new Error('Reservation journal unavailable'); }
  }

  async serialize(threadId, operation) {
    const predecessor = this.locks.get(threadId) ?? Promise.resolve();
    const result = predecessor.catch(() => {}).then(operation);
    this.locks.set(threadId, result);
    try { return await result; }
    finally { if (this.locks.get(threadId) === result) this.locks.delete(threadId); }
  }

  guarded(threadId) {
    const record = this.records.get(threadId);
    return record && record.phase !== 'released';
  }

  keepConnection(channel) {
    for (const [threadId, owner] of this.clients) {
      const record = this.records.get(threadId);
      if (owner === channel && record && (record.phase !== 'released' || !record.turnComplete)) return true;
    }
    return false;
  }

  /** Reject known-not-delivered mutations, never defer/replay an arbitrary user prompt. */
  assertAdmission(frame) {
    if (!frame.method) return;
    const threadId = frame.params?.threadId;
    const active = this.preparing.size || [...this.records.values()].some(record => record.phase !== 'released');
    if (active && GLOBAL_WRITES.test(frame.method)) {
      throw new BrokerRefusal('owner-settings-reserved');
    }
    const record = this.records.get(threadId);
    if (!record) return;
    if (frame.method === 'turn/settings/update' && record.turnId === frame.params?.turnId && !record.turnComplete) {
      throw new BrokerRefusal('own-turn-settings-reserved');
    }
    if (record.phase === 'released') return;
    const safe = new Set([
      'thread/read', 'thread/turns/list', 'thread/items/list', 'thread/queue/list',
      'thread/resume', 'turn/interrupt', 'turn/steer', 'thread/queue/delete',
      'thread/name/set', 'thread/metadata/update', 'thread/goal/get',
      'thread/backgroundTerminals/list',
    ]);
    if (!safe.has(frame.method)) throw new BrokerRefusal('thread-admission-reserved');
    // A loaded subscribed thread ignores resume overrides in native Codex. We
    // nevertheless reject override-bearing rejoins while its future config is pinned.
    if (frame.method === 'thread/resume' && Object.keys(frame.params ?? {}).some(key =>
      !['threadId', 'excludeTurns', 'initialTurnsPage', 'cwd'].includes(key))) {
      throw new BrokerRefusal('resume-settings-reserved');
    }
  }

  async readSettings(channel, threadId) {
    const result = await this.readOwnerState(channel, threadId);
    const settings = { model: result?.model, effort: result?.reasoningEffort ?? null,
      cwd: result?.cwd, approvalPolicy: result?.approvalPolicy,
      sandboxPolicy: result?.sandbox && normalizeSandbox(result.sandbox) };
    if (!SETTINGS(settings)) throw new BrokerRefusal('native-settings-unavailable');
    return settings;
  }

  async readOwnerState(channel, threadId) {
    try {
      const current = await channel.call('thread/resume', { threadId, excludeTurns: true });
      this.observeOwnerMode(threadId, current);
      return current;
    }
    catch (error) {
      // Native cannot resume a brand-new loaded thread before its first rollout
      // exists. Its just-returned start snapshot is authoritative, not history
      // guessed from another process. Retire the fallback on first user item.
      if (error.nativeRejected && [-32600, -32603].includes(error.code) && this.freshStates.has(threadId)) {
        return structuredClone(this.freshStates.get(threadId));
      }
      throw error;
    }
  }

  observeOwnerMode(threadId, current) {
    // Resumed desktop/browser threads may never have emitted a settings event
    // to this broker. Native's resume snapshot is authoritative even when the
    // requested settings are unchanged and no settings/updated event follows.
    // Older native versions omit this field; retain their event-derived proof.
    if (!Object.hasOwn(current ?? {}, 'collaborationMode')) return;
    const mode = current.collaborationMode?.mode;
    if (['default', 'plan'].includes(mode)) this.ownerModes.set(threadId, mode);
    else this.ownerModes.delete(threadId);
  }

  async publishSettings(channel, threadId, settings) {
    await channel.call('thread/settings/update', {
      threadId, model: settings.model, ...(settings.effort !== null ? { effort: settings.effort } : {}),
      cwd: settings.cwd, approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandboxPolicy,
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      const current = await this.readSettings(channel, threadId);
      if (sameSetting(current, settings)) return;
      if (Date.now() > deadline) throw new Error('Native settings observation unavailable');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async release(channel, record) {
    // Native 0.163 MCP authorization reads the live thread settings even after
    // turn context captured never/full-access. An early restore silently turns
    // authorized MCP calls into approval requests which headless clients deny.
    // Keep the reservation through the EXACT turn's terminal notification.
    if (record.turnId && !record.turnComplete) throw new Error('Active turn settings cannot be restored');
    await this.publishSettings(channel, record.threadId, record.previous);
    record.phase = 'released';
    await this.persist();
  }

  async pinAndEnqueue(channel, params) {
    const requested = structuredClone(params?.codeAiTurnSettings);
    const expected = params?.codeAiExpectedOwnerSettings;
    const collaborationMode = params?.codeAiExpectedCollaborationMode ?? 'default';
    if (channel.clientName !== 'code-ai' || !SETTINGS(requested) || !ID(params?.threadId)
        || !ID(params?.clientUserMessageId) || !['default', 'plan'].includes(collaborationMode)
        || (expected !== undefined && !baselineShape(expected))) {
      throw new BrokerRefusal('invalid-product-settings', -32602);
    }
    const threadId = params.threadId;
    return this.serialize(threadId, async () => {
      const existing = this.records.get(threadId);
      if (!this.storageHealthy || this.globalWriters || (existing && (existing.phase !== 'released' || !existing.turnComplete))) {
        throw new BrokerRefusal('thread-admission-reserved');
      }
      this.preparing.add(threadId);
      let previous;
      try {
        const queued = await channel.call('thread/queue/list', { threadId, limit: 1 });
        if (!Array.isArray(queued?.data) || queued.data.length !== 0 || queued.nextCursor) {
          throw new BrokerRefusal('foreign-queue-pending');
        }
        const current = await this.readOwnerState(channel, threadId);
        if (expected && !Object.keys(expected).every(key => sameSetting(expected[key], current?.[key]))) {
          throw new BrokerRefusal('owner-policy-baseline-mismatch');
        }
        previous = await this.readSettings(channel, threadId);
        requested.sandboxPolicy = normalizeSandbox(requested.sandboxPolicy);
        if (!isRestorableNativePermissionProfile(current.activePermissionProfile, current.sandbox)) {
          // A legacy sandbox snapshot cannot reconstruct a named permission
          // profile's finer-grained rules/provenance. Never widen or flatten it.
          throw new BrokerRefusal('unrestorable-named-permission-profile');
        }
        if (requested.cwd !== previous.cwd && (current.runtimeWorkspaceRoots?.length > 1
            || current.thread?.environments?.length > 1)) {
          throw new BrokerRefusal('unrestorable-multiple-environment-roots');
        }
        if (previous.effort === null && requested.effort !== null) {
          // Public null does not clear effort. Never replace a value we cannot restore exactly.
          throw new BrokerRefusal('unrestorable-native-effort');
        }
      } finally { this.preparing.delete(threadId); }
      if (requested.effort === null) requested.effort = previous.effort;
      const record = {
        threadId, clientId: params.clientUserMessageId, queuedId: null, turnId: null,
        phase: 'prepared', previous, requested: structuredClone(requested),
        createdAt: this.now(), turnComplete: false,
        collaborationMode: this.ownerModes.get(threadId) ?? null,
      };
      this.records.set(threadId, record);
      this.clients.set(threadId, channel);
      await this.persist();
      try {
        await this.publishSettings(channel, threadId, record.requested);
        record.collaborationMode = this.ownerModes.get(threadId) ?? null;
        record.phase = 'applied';
        await this.persist();
      } catch {
        record.phase = 'uncertain';
        await this.persist();
        throw new Error('Native settings reservation unresolved; no input was sent');
      }
      const ownerMode = this.ownerModes.get(threadId);
      if (ownerMode !== collaborationMode) {
        await this.release(channel, record);
        record.turnComplete = true;
        await this.persist();
        throw new BrokerRefusal(ownerMode ? 'native-collaboration-mode-mismatch' : 'native-collaboration-mode-unavailable');
      }
      record.phase = 'enqueuing';
      await this.persist();
      const nativeParams = { ...params };
      delete nativeParams.codeAiTurnSettings;
      delete nativeParams.codeAiExpectedOwnerSettings;
      delete nativeParams.codeAiExpectedCollaborationMode;
      try {
        const result = await channel.call('thread/queue/add', nativeParams);
        if (!ID(result?.queuedSubmission?.id)
            || result.queuedSubmission.clientUserMessageId !== record.clientId) {
          throw new Error('Native queue acknowledgement unrecognized');
        }
        record.queuedId = result.queuedSubmission.id;
        // An idle queue can publish its user item before its enqueue acknowledgement.
        if (!record.turnId && record.phase !== 'released') record.phase = 'queued';
        await this.persist();
        return result;
      } catch (error) {
        if (error.nativeRejected === true && [-32600, -32602].includes(error.code) && !record.turnId) {
          await this.release(channel, record);
          record.turnComplete = true;
          await this.persist();
          throw new BrokerRefusal('native-queue-rejected', error.code ?? -32602);
        }
        // Lost/malformed ACK could already mean accepted work. Keep reservation;
        // never restore settings, replay, cancel another turn, or assert failure.
        if (record.phase !== 'released') record.phase = 'uncertain';
        await this.persist();
        throw new Error('Native queue custody unresolved; do not replay input');
      }
    });
  }

  async handle(channel, frame) {
    if (frame.method === 'thread/queue/add' && Object.hasOwn(frame.params ?? {}, 'codeAiTurnSettings')) {
      return this.pinAndEnqueue(channel, frame.params);
    }
    const threadId = frame.params?.threadId;
    const operation = async () => {
      this.assertAdmission(frame);
      if (!this.storageHealthy && /^(turn\/start|thread\/(settings\/update|queue\/add|queue\/start))$/.test(frame.method)) {
        throw new BrokerRefusal('reservation-journal-unavailable');
      }
      const global = GLOBAL_WRITES.test(frame.method);
      if (global) this.globalWriters++;
      if (frame.method === 'turn/start' && frame.params?.collaborationMode?.mode
          && frame.params.collaborationMode.mode !== this.ownerModes.get(threadId)) {
        // Busy turn/start can steer and ignore its mode argument. Invalidate
        // stale metadata instead of treating requested mode as applied proof.
        this.ownerModes.delete(threadId);
      }
      let result;
      try { result = await channel.call(frame.method, frame.params); }
      catch (error) {
        // A settings update ACK only acknowledges the queued native Op. If the
        // subsequent applied-state notification is lost, do not allow a new
        // settings reservation to overtake that unresolved write.
        if ((frame.method === 'thread/settings/update' || global) && !error.nativeRejected) this.storageHealthy = false;
        throw error;
      }
      finally { if (global) this.globalWriters--; }
      if (frame.method === 'thread/resume' && ID(threadId)) this.observeOwnerMode(threadId, result);
      const record = this.records.get(threadId);
      if (frame.method === 'thread/start' && ID(result?.thread?.id)) {
        // Qualified native constructor initializes Default, independently of the
        // mode of other threads. Loaded/resumed threads are never guessed here.
        this.ownerModes.set(result.thread.id, 'default');
        this.freshStates.set(result.thread.id, structuredClone(result));
      }
      if (frame.method === 'turn/start' && ID(result?.turn?.id)) this.freshStates.delete(threadId);
      if (frame.method === 'thread/queue/delete' && result?.deleted === true && record
          && frame.params.queuedSubmissionId === record.queuedId && !record.turnId) {
        await this.release(channel, record);
        record.turnComplete = true;
        await this.persist();
      }
      return result;
    };
    return threadId ? this.serialize(threadId, operation) : operation();
  }

  async observe(channel, frame) {
    const threadId = frame.params?.threadId;
    if (frame.method === 'thread/settings/updated') {
      const settings = frame.params?.threadSettings;
      const mode = settings?.collaborationMode?.mode;
      if (ID(threadId) && ['default', 'plan'].includes(mode)) this.ownerModes.set(threadId, mode);
      const fresh = this.freshStates.get(threadId);
      if (fresh && settings) Object.assign(fresh, {
        model: settings.model, reasoningEffort: settings.effort ?? null, cwd: settings.cwd,
        approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy,
        modelProvider: settings.modelProvider, serviceTier: settings.serviceTier,
      });
    }
    if (frame.method === 'item/started' && frame.params?.item?.type === 'userMessage') this.freshStates.delete(threadId);
    const record = this.records.get(threadId);
    if (!record) return;
    if (frame.method === 'item/started' && frame.params?.item?.type === 'userMessage'
        && frame.params.item.clientId === record.clientId && ID(frame.params.turnId)) {
      // Set identity synchronously before entering the asynchronous journal fence.
      // Otherwise an enqueue error path could incorrectly treat a proven turn as undelivered.
      record.turnId = frame.params.turnId;
      if (record.phase !== 'released') record.phase = 'started';
      await this.serialize(threadId, async () => {
        await this.persist();
      });
    }
    if (frame.method === 'turn/completed' && frame.params?.turn?.id === record.turnId) {
      record.turnComplete = true;
      await this.serialize(threadId, async () => {
        await this.persist();
        if (record.phase !== 'released') await this.release(this.clients.get(threadId) ?? channel, record);
      });
    }
  }

  async recover(channel) {
    for (const record of this.records.values()) {
      if (record.phase === 'released' && record.turnComplete) continue;
      // The journal stores only the previously proved enum, not instructions.
      // Cooperating clients cannot mutate it while the persisted fence is held.
      if (record.collaborationMode) this.ownerModes.set(record.threadId, record.collaborationMode);
      else this.ownerModes.delete(record.threadId);
      this.clients.set(record.threadId, channel);
      await this.serialize(record.threadId, async () => {
        await this.readOwnerState(channel, record.threadId);
        if (record.phase === 'released' && ID(record.turnId)) {
          // The persisted release already proves this stable input started and
          // future settings were restored. Reobserve its EXACT turn status,
          // not thousands of tool-output bodies, before exposing the adapter.
          let cursor = null; const seen = new Set(); let found = false;
          for (let page = 0; page < 100; page++) {
            const turns = await channel.call('thread/turns/list', { threadId: record.threadId,
              cursor, limit: 20, itemsView: 'notLoaded', sortDirection: 'desc' });
            if (!Array.isArray(turns?.data)) throw new Error('Released turn status unavailable');
            const turn = turns.data.find(turn => turn.id === record.turnId);
            if (turn) {
              if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) throw new Error('Released turn status unavailable');
              record.turnComplete ||= ['completed', 'interrupted', 'failed'].includes(turn.status);
              await this.persist(); found = true; break;
            }
            if (!turns.nextCursor) break;
            if (typeof turns.nextCursor !== 'string' || seen.has(turns.nextCursor)) throw new Error('Released turn pagination unavailable');
            seen.add(turns.nextCursor); cursor = turns.nextCursor;
          }
          if (!found) throw new Error('Released turn custody unavailable');
          return;
        }
        const history = await readSharedHistoryTurns(channel.call.bind(channel), record.threadId, record.clientId, record.turnId || undefined);
        const turn = history.find(turn => turn.items?.some(item =>
          item.type === 'userMessage' && item.clientId === record.clientId));
        if (turn && ID(turn.id)) {
          record.turnId = turn.id;
          record.turnComplete = ['completed', 'interrupted', 'failed'].includes(turn.status);
          if (record.turnComplete && record.phase !== 'released') await this.release(channel, record);
          else { if (record.phase !== 'released') record.phase = 'started'; await this.persist(); }
          return;
        }
        if (record.phase === 'prepared' || record.phase === 'applied') {
          // The journal fence proves native queue/add was never attempted.
          await this.release(channel, record);
          record.turnComplete = true;
          await this.persist();
          return;
        }
        const queued = await channel.call('thread/queue/list', { threadId: record.threadId, limit: 100 });
        const item = queued?.data?.find(item => item.clientUserMessageId === record.clientId);
        if (item && ID(item.id)) {
          record.queuedId = item.id;
          record.phase = 'queued';
          await this.publishSettings(channel, record.threadId, record.requested);
        } else record.phase = 'uncertain';
        // Absence from one history/queue snapshot is not proof of nondelivery.
        await this.persist();
      });
    }
  }
}

/** One transport per frontend keeps native request IDs and reply custody intact. */
async function connectNative(socket, expectedHome, onFrame = () => {}, freshState = () => undefined) {
  const ws = new WebSocket(`ws+unix://${socket}:/`, {
    maxPayload: MAX_BYTES, handshakeTimeout: 10_000, perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve); ws.once('error', () => reject(new Error('Native endpoint unavailable')));
  });
  let next = 0;
  const pending = new Map();
  const events = [];
  const settingsVersions = new Map(), settingsWaiters = new Set();
  let bufferedEventsBytes = 0;
  let sink = frame => {
    bufferedEventsBytes += Buffer.byteLength(JSON.stringify(frame));
    if (bufferedEventsBytes > NATIVE_BUFFER_BYTES) { ws.terminate(); return; }
    events.push(frame);
  };
  ws.on('message', (data, binary) => {
    if (binary || data.length > MAX_BYTES) { ws.terminate(); return; }
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { ws.terminate(); return; }
    const rpc = !frame.method && pending.get(frame.id);
    if (rpc) {
      pending.delete(frame.id); clearTimeout(rpc.timer);
      if (frame.error) {
        const error = new Error('Native request rejected');
        error.nativeRejected = true; error.code = frame.error.code;
        error.diagnostic = publicRpcDiagnostic(rpc.method, error.code, frame.error.message, Date.now() - rpc.startedAt);
        rpc.reject(error);
      } else rpc.resolve(frame.result);
    } else {
      if (frame.method === 'thread/settings/updated' && ID(frame.params?.threadId)) {
        const threadId = frame.params.threadId;
        const version = (settingsVersions.get(threadId) ?? 0) + 1;
        settingsVersions.set(threadId, version);
        for (const waiter of settingsWaiters) if (waiter.threadId === threadId && version > waiter.version) {
          clearTimeout(waiter.timer); settingsWaiters.delete(waiter); waiter.resolve();
        }
      }
      onFrame(frame);
      sink(frame);
    }
  });
  const fail = () => {
    for (const rpc of pending.values()) { clearTimeout(rpc.timer); rpc.reject(new Error('Native connection lost')); }
    pending.clear();
    for (const waiter of settingsWaiters) {
      clearTimeout(waiter.timer); waiter.reject(new Error('Native applied settings observation lost'));
    }
    settingsWaiters.clear();
  };
  ws.on('error', fail); ws.on('close', fail);
  const channel = {
    ws, clientName: null,
    call(method, params) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const failCall = message => {
          const error = new Error(message);
          error.diagnostic = publicRpcDiagnostic(method, null, message, Date.now() - startedAt);
          reject(error);
        };
        if (pending.size >= MAX_PENDING_CALLS || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > NATIVE_BUFFER_BYTES) {
          failCall('Native transport capacity unavailable'); return;
        }
        const id = `code-ai-broker-${++next}-${randomUUID()}`;
        const timer = setTimeout(() => {
          pending.delete(id); failCall('Native acknowledgement unavailable');
        }, nativeRpcTimeoutMs(method));
        pending.set(id, { resolve, reject, timer, method, startedAt });
        ws.send(JSON.stringify({ id, method, params }), error => {
          if (error) { pending.delete(id); clearTimeout(timer); reject(new Error('Native write failed')); }
        });
      });
    },
    send(frame) {
      if (ws.bufferedAmount > NATIVE_BUFFER_BYTES) { ws.terminate(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
    setSink(fn) {
      sink = fn; for (const frame of events.splice(0)) sink(frame); bufferedEventsBytes = 0;
    },
  };
  const initialize = channel.call.bind(channel);
  channel.call = async (method, params) => {
    if (method === 'thread/settings/update') {
      let current;
      try { current = await initialize('thread/resume', { threadId: params.threadId, excludeTurns: true }); }
      catch (error) {
        if (!error.nativeRejected || ![-32600, -32603].includes(error.code) || !freshState(params.threadId)) throw error;
        current = freshState(params.threadId);
      }
      const comparable = { model: current?.model, effort: current?.reasoningEffort ?? null,
        cwd: current?.cwd, approvalPolicy: current?.approvalPolicy,
        sandboxPolicy: current?.sandbox && normalizeSandbox(current.sandbox),
        serviceTier: current?.serviceTier, approvalsReviewer: current?.approvalsReviewer };
      const noEffect = Object.entries(params).every(([key, value]) => key === 'threadId'
        || (value === null && key !== 'serviceTier')
        || (Object.hasOwn(comparable, key) && sameSetting(comparable[key],
          key === 'sandboxPolicy' && sandboxPolicy(value) ? normalizeSandbox(value) : value)));
      // Native suppresses settings/updated for a no-op. Since every preceding
      // cooperating thread write is fenced, an authoritative unchanged request
      // can be answered without enqueuing a redundant asynchronous native Op.
      if (noEffect) return {};
    }
    const settingsVersion = settingsVersions.get(params?.threadId) ?? 0;
    const result = await initialize(method, params);
    if (method === 'initialize') {
      if (typeof result?.codexHome !== 'string'
          || await realpath(result.codexHome).catch(() => null) !== expectedHome) {
        ws.terminate(); throw new Error('Native profile mismatch');
      }
      channel.clientName = params?.clientInfo?.name;
    }
    if (method === 'thread/settings/update'
        && (settingsVersions.get(params.threadId) ?? 0) <= settingsVersion) {
      await new Promise((resolve, reject) => {
        const waiter = { threadId: params.threadId, version: settingsVersion, resolve, reject };
        waiter.timer = setTimeout(() => {
          settingsWaiters.delete(waiter); reject(new Error('Native applied settings observation unavailable'));
        }, 10_000);
        settingsWaiters.add(waiter);
      });
    }
    return result;
  };
  return channel;
}

export async function startCodexSharedOwnerBroker({ socketPath, backendSocket, codexHome, journalPath }) {
  const { home } = await assertPrivateNativeEndpoint(backendSocket, codexHome);
  if (!path.isAbsolute(socketPath) || socketPath === backendSocket) throw new Error('Distinct absolute broker endpoint required');
  const parent = await lstat(path.dirname(socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
    throw new Error('Private broker socket directory required');
  }
  // Never unlink an existing native or broker endpoint. The installer must choose
  // a validated separate socket and manage its own systemd RuntimeDirectory.
  try { await lstat(socketPath); throw new Error('Broker endpoint already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const journal = await createReservationJournal(journalPath);
  const channels = new Set();
  const broker = new CodexSharedOwnerBroker({ records: journal.records, save: journal.save, onChange: () => {
    for (const channel of channels) {
      if (channel.detached && !broker.keepConnection(channel)) channel.ws.close();
    }
  } });
  let recover;
  recover = await connectNative(backendSocket, home, frame => {
    if (recover) void broker.observe(recover, frame).catch(() => {});
  }, threadId => broker.freshStates.get(threadId));
  channels.add(recover);
  await recover.call('initialize', {
    clientInfo: { name: 'code-ai-broker-recovery', version: '1.0.0' }, capabilities: { experimentalApi: true },
  });
  recover.send({ method: 'initialized', params: {} });
  try { await broker.recover(recover); }
  catch (error) { recover.ws.terminate(); throw error; }
  recover.setSink(() => {});
  const server = createServer((req, res) => { req.resume(); res.writeHead(404).end(); });
  const wss = new WebSocketServer({ server, maxPayload: MAX_BYTES, perMessageDeflate: false });
  wss.on('connection', front => {
    let channel, initialized = false, bytes = 0;
    let delivery = Promise.resolve();
    const sendFront = frame => {
      if (front.bufferedAmount > NATIVE_BUFFER_BYTES) { front.terminate(); return; }
      if (front.readyState === WebSocket.OPEN) front.send(JSON.stringify(frame));
    };
    const opening = connectNative(backendSocket, home, frame => {
      if (channel) void broker.observe(channel, frame).catch(() => {});
    }, threadId => broker.freshStates.get(threadId)).then(native => {
      channel = native; channels.add(native);
      native.setSink(frame => {
        if (initialized) sendFront(frame);
        if (frame.method === 'turn/completed' && front.readyState !== WebSocket.OPEN
            && !broker.keepConnection(native)) native.ws.close();
      });
      native.ws.once('close', () => { channels.delete(native); front.close(); });
      return native;
    });
    opening.catch(() => front.close());
    front.on('message', (data, binary) => {
      bytes += data.length;
      if (binary || data.length > MAX_BYTES || bytes > NATIVE_BUFFER_BYTES) { front.close(); return; }
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { front.close(); return; }
      // Native server-request replies must not wait behind model submission/config
      // fences: blocking a question answer could deadlock the current desktop turn.
      if (!frame.method) {
        void opening.then(native => { if (initialized) native.send(frame); });
        bytes -= data.length;
        return;
      }
      delivery = delivery.then(async () => {
        const native = await opening;
        if (!initialized && frame.method !== 'initialize') throw new BrokerRefusal('not-initialized', -32600);
        if (!Object.hasOwn(frame, 'id')) { native.send(frame); return; }
        const result = frame.method === 'initialize'
          ? await native.call(frame.method, frame.params)
          : await broker.handle(native, frame);
        if (frame.method === 'initialize') initialized = true;
        sendFront({ id: frame.id,
          result: frame.method === 'initialize'
            ? { ...result, codeAiSharedOwner: { version: 1, turnSettings: true, historyReads: 'canonical-v1' } } : result });
      }).catch(error => {
        if (front.readyState !== WebSocket.OPEN || !Object.hasOwn(frame, 'id')) return;
        sendFront({ id: frame.id, error: {
          code: error instanceof BrokerRefusal || error.nativeRejected ? error.code : -32603,
          message: error instanceof BrokerRefusal ? error.message : 'Shared native custody unresolved; do not replay input',
          data: error instanceof BrokerRefusal
            ? { codeAiAdmission: 'notAccepted', reason: error.reason }
            : { codeAiAdmission: 'uncertain', codeAiDiagnostic:
              validatePublicRpcDiagnostic(error.diagnostic)
              ?? publicRpcDiagnostic(frame.method, error.nativeRejected ? error.code : null, error.message) },
        } });
      }).finally(() => { bytes -= data.length; });
    });
    front.on('close', () => {
      void opening.then(native => {
        native.detached = true;
        if (!broker.keepConnection(native)) native.ws.close();
      });
    });
  });
  server.listen(socketPath);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return {
    broker,
    async close() {
      // Close this adapter's clients only. Never signal native owner/model jobs.
      for (const front of wss.clients) front.terminate();
      for (const channel of channels) channel.ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startCodexSharedOwnerBroker({ socketPath: process.argv[2], backendSocket: process.argv[3],
    codexHome: process.env.CODEX_HOME, journalPath: process.argv[4] }).then(instance => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
      void instance.close().then(() => { process.exitCode = 0; });
    });
  }).catch(() => {
    process.stderr.write('CODE_AI_NATIVE_BROKER_UNAVAILABLE\n');
    process.exitCode = 1;
  });
}
