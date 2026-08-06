import { spawn, type ChildProcessByStdio } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import type { Readable } from 'stream';
import { CODEX_APP_CONFIG } from './config.js';
import { getRemoteHostConfig, isLocalCodeAiServerId } from './remoteHostRegistry.js';

export interface PersonalPortForwardRecord {
  id: string;
  ownerId: string;
  bindingId: string;
  sourceServerId: string;
  sourcePort: number;
  personalPort: number;
  label: string;
  createdAt: string;
  expiresAt: string;
  status: 'starting' | 'active' | 'failed' | 'closed';
  error: string | null;
  localUrl: string;
}

interface PersistedState {
  version: 1;
  forwards: PersonalPortForwardRecord[];
}

type TunnelProcess = ChildProcessByStdio<null, Readable, Readable>;

interface RuntimeForward {
  relay: TunnelProcess | null;
  reverse: TunnelProcess | null;
}

const STATE_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'local', 'personal-port-forwards');
const STATE_FILE = path.join(STATE_ROOT, 'forwards.json');
const PERSONAL_SSH_TARGET = process.env.CODE_AI_PERSONAL_SSH_TARGET?.trim() || 'personal-windows-ssh';
const runtimeById = new Map<string, RuntimeForward>();
let records = new Map<string, PersonalPortForwardRecord>();
let loaded: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let expiryTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function isPort(value: unknown, minimum = 1): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= 65535;
}

function sanitizeRecord(value: unknown): PersonalPortForwardRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersonalPortForwardRecord>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.ownerId !== 'string'
    || typeof candidate.bindingId !== 'string'
    || typeof candidate.sourceServerId !== 'string'
    || !isPort(candidate.sourcePort)
    || !isPort(candidate.personalPort, 1024)
    || typeof candidate.expiresAt !== 'string'
  ) return null;
  return {
    id: candidate.id,
    ownerId: candidate.ownerId,
    bindingId: candidate.bindingId,
    sourceServerId: candidate.sourceServerId,
    sourcePort: candidate.sourcePort,
    personalPort: candidate.personalPort,
    label: typeof candidate.label === 'string' ? candidate.label.slice(0, 120) : '',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : nowIso(),
    expiresAt: candidate.expiresAt,
    status: candidate.status === 'active' || candidate.status === 'starting' ? 'starting' : 'closed',
    error: null,
    localUrl: `http://127.0.0.1:${candidate.personalPort}`,
  };
}

async function ensureLoaded() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as PersistedState;
      records = new Map((Array.isArray(parsed.forwards) ? parsed.forwards : [])
        .map(sanitizeRecord)
        .filter((record): record is PersonalPortForwardRecord => Boolean(record))
        .map((record) => [record.id, record]));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      records = new Map();
    }
  })();
  return loaded;
}

async function persist() {
  const snapshot: PersistedState = { version: 1, forwards: [...records.values()] };
  persistTail = persistTail.then(async () => {
    await fs.mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
    const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, STATE_FILE);
    await fs.chmod(STATE_FILE, 0o600).catch(() => undefined);
  });
  await persistTail;
}

async function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopRuntime(runtime: RuntimeForward | undefined) {
  if (!runtime) return;
  for (const child of [runtime.reverse, runtime.relay]) {
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

async function waitForSshReady(child: TunnelProcess, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      if (child.exitCode === null && !child.killed) resolve();
      else reject(new Error(`${label} exited before becoming ready${stderr ? `: ${stderr.trim()}` : ''}`));
    }, 900);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`${label} exited (${code ?? signal ?? 'unknown'})${stderr ? `: ${stderr.trim()}` : ''}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onStderr = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stderr.off('data', onStderr);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    child.stderr.on('data', onStderr);
  });
}

async function startRecord(record: PersonalPortForwardRecord): Promise<void> {
  if (Date.parse(record.expiresAt) <= Date.now()) {
    record.status = 'closed';
    record.error = 'TTL expired';
    return;
  }

  record.status = 'starting';
  record.error = null;
  if (record.sourceServerId === 'personal-windows') {
    if (record.personalPort !== record.sourcePort) {
      throw new Error('For a service already on the personal computer, personalPort must equal sourcePort.');
    }
    record.status = 'active';
    runtimeById.set(record.id, { relay: null, reverse: null });
    return;
  }

  let relay: TunnelProcess | null = null;
  let relayPort = record.sourcePort;
  if (!isLocalCodeAiServerId(record.sourceServerId)) {
    const source = await getRemoteHostConfig(record.sourceServerId);
    if (!source || source.transport !== 'ssh' || !source.sshTarget) {
      throw new Error(`The source server cannot provide a TCP relay: ${record.sourceServerId}`);
    }
    relayPort = await reserveEphemeralPort();
    relay = spawn('ssh', [
      '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ClearAllForwardings=no',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${relayPort}:127.0.0.1:${record.sourcePort}`,
      source.sshTarget,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitForSshReady(relay, `Relay for ${record.sourceServerId}:${record.sourcePort}`);
    } catch (error) {
      if (!relay.killed) relay.kill('SIGTERM');
      throw error;
    }
  }

  const reverse = spawn('ssh', [
    '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${record.personalPort}:127.0.0.1:${relayPort}`,
    PERSONAL_SSH_TARGET,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    await waitForSshReady(reverse, `Personal port ${record.personalPort}`);
  } catch (error) {
    if (relay && !relay.killed) relay.kill('SIGTERM');
    throw error;
  }

  const runtime = { relay, reverse };
  runtimeById.set(record.id, runtime);
  const markFailed = (source: string) => (code: number | null, signal: NodeJS.Signals | null) => {
    const current = records.get(record.id);
    if (!current || current.status === 'closed') return;
    current.status = 'failed';
    current.error = `${source} tunnel stopped (${code ?? signal ?? 'unknown'})`;
    stopRuntime(runtime);
    void persist();
  };
  reverse.once('exit', markFailed('Personal'));
  relay?.once('exit', markFailed('Source'));
  record.status = 'active';
}

function publicRecord(record: PersonalPortForwardRecord): PersonalPortForwardRecord {
  return { ...record };
}

export async function startPersonalPortForwardBroker(): Promise<void> {
  await ensureLoaded();
  for (const record of records.values()) {
    if (record.status === 'closed' || Date.parse(record.expiresAt) <= Date.now()) continue;
    try {
      await startRecord(record);
    } catch (error: any) {
      record.status = 'failed';
      record.error = error?.message || 'Failed to restore port forward';
    }
  }
  await persist();
  if (!expiryTimer) {
    expiryTimer = setInterval(() => {
      void expirePersonalPortForwards();
    }, 30_000);
    expiryTimer.unref();
  }
}

export async function listPersonalPortForwards(ownerId: string, bindingId?: string): Promise<PersonalPortForwardRecord[]> {
  await ensureLoaded();
  await expirePersonalPortForwards();
  return [...records.values()]
    .filter((record) => record.ownerId === ownerId && (!bindingId || record.bindingId === bindingId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(publicRecord);
}

export async function openPersonalPortForward(input: {
  ownerId: string;
  bindingId: string;
  sourceServerId: string;
  sourcePort: number;
  personalPort?: number | null;
  label?: string | null;
  ttlMinutes?: number | null;
}): Promise<PersonalPortForwardRecord> {
  await ensureLoaded();
  if (!isPort(input.sourcePort)) throw new Error('sourcePort must be between 1 and 65535.');
  const sourceServerId = input.sourceServerId.trim().toLowerCase();
  if (!sourceServerId) throw new Error('sourceServerId is required.');
  const personalPort = isPort(input.personalPort, 1024) ? input.personalPort : input.sourcePort;
  if (!isPort(personalPort, 1024)) throw new Error('personalPort must be between 1024 and 65535.');
  const conflict = [...records.values()].find((record) => (
    record.personalPort === personalPort
    && (record.status === 'starting' || record.status === 'active')
    && Date.parse(record.expiresAt) > Date.now()
  ));
  if (conflict) throw new Error(`Personal port ${personalPort} is already used by ${conflict.label || conflict.id}.`);
  const ttlMinutes = Math.min(1440, Math.max(1, Number(input.ttlMinutes) || 120));
  const record: PersonalPortForwardRecord = {
    id: randomUUID(),
    ownerId: input.ownerId,
    bindingId: input.bindingId,
    sourceServerId,
    sourcePort: input.sourcePort,
    personalPort,
    label: (input.label || `${sourceServerId}:${input.sourcePort}`).trim().slice(0, 120),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    status: 'starting',
    error: null,
    localUrl: `http://127.0.0.1:${personalPort}`,
  };
  records.set(record.id, record);
  try {
    await startRecord(record);
  } catch (error: any) {
    record.status = 'failed';
    record.error = error?.message || 'Failed to open port forward';
    await persist();
    throw error;
  }
  await persist();
  return publicRecord(record);
}

export async function closePersonalPortForward(ownerId: string, forwardId: string, bindingId?: string): Promise<PersonalPortForwardRecord> {
  await ensureLoaded();
  const record = records.get(forwardId);
  if (!record || record.ownerId !== ownerId || (bindingId && record.bindingId !== bindingId)) {
    throw new Error('Port forward was not found.');
  }
  record.status = 'closed';
  record.error = null;
  stopRuntime(runtimeById.get(record.id));
  runtimeById.delete(record.id);
  await persist();
  return publicRecord(record);
}

async function expirePersonalPortForwards(): Promise<void> {
  await ensureLoaded();
  let changed = false;
  for (const record of records.values()) {
    if (record.status !== 'closed' && Date.parse(record.expiresAt) <= Date.now()) {
      record.status = 'closed';
      record.error = 'TTL expired';
      stopRuntime(runtimeById.get(record.id));
      runtimeById.delete(record.id);
      changed = true;
    }
  }
  if (changed) await persist();
}

export function shutdownPersonalPortForwardBroker(): void {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
  for (const runtime of runtimeById.values()) stopRuntime(runtime);
  runtimeById.clear();
}
