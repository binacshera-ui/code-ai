import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import { promises as fs } from 'fs';
import http from 'http';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export type CodeAiServerTransport = 'local' | 'ssh' | 'reverse-tunnel';
export type CodeAiServerConnectionStatus = 'online' | 'offline' | 'connecting' | 'unknown';

export interface RemoteHostConfig {
  id: string;
  label: string;
  transport: Exclude<CodeAiServerTransport, 'local'>;
  enabled: boolean;
  token: string;
  sshTarget?: string;
  remotePort?: number;
  localHost?: string;
  localPort?: number;
  description?: string;
}

export interface RemoteAgentHealth {
  ok: boolean;
  hostname: string;
  version: string;
  codexVersion?: string | null;
  checkedAt: string;
  profiles: Array<{
    id: string;
    label: string;
    provider: string;
    mode?: string;
    authenticated?: boolean;
  }>;
}

export interface CodeAiServerSummary {
  id: string;
  label: string;
  transport: CodeAiServerTransport;
  isLocal: boolean;
  enabled: boolean;
  description: string | null;
  status: CodeAiServerConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  hostname: string | null;
  version: string | null;
  codexVersion: string | null;
  profileCount: number | null;
  authenticatedProfileCount: number | null;
}

interface RemoteHostRegistryFile {
  version: 1;
  hosts: RemoteHostConfig[];
}

interface HostRuntimeState {
  status: CodeAiServerConnectionStatus;
  tunnel: ChildProcessWithoutNullStreams | null;
  localPort: number | null;
  connecting: Promise<RemoteAgentEndpoint> | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  health: RemoteAgentHealth | null;
}

export interface RemoteAgentEndpoint {
  hostname: string;
  port: number;
  token: string;
}

const LOCAL_SERVER_ID = 'local';
const HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const SSH_TARGET_PATTERN = /^[a-zA-Z0-9_.:@-]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;
const runtimeByHostId = new Map<string, HostRuntimeState>();

let cachedRegistry: {
  mtimeMs: number;
  hosts: RemoteHostConfig[];
} | null = null;

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/x-code-ai-remote-token\s*:\s*[^\s]+/gi, 'x-code-ai-remote-token: [redacted]')
    .slice(0, 500);
}

function normalizePort(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${fieldName} must be a valid TCP port`);
  }
  return parsed;
}

function normalizeHostConfig(value: unknown): RemoteHostConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('Remote host entry must be an object');
  }

  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim().toLowerCase() : '';
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  const transport = candidate.transport === 'ssh' || candidate.transport === 'reverse-tunnel'
    ? candidate.transport
    : null;
  const token = typeof candidate.token === 'string' ? candidate.token.trim() : '';

  if (!HOST_ID_PATTERN.test(id) || id === LOCAL_SERVER_ID) {
    throw new Error(`Remote host id is invalid: ${id || '[empty]'}`);
  }
  if (!label) {
    throw new Error(`Remote host ${id} must have a label`);
  }
  if (!transport) {
    throw new Error(`Remote host ${id} has an unsupported transport`);
  }
  if (token.length < 24) {
    throw new Error(`Remote host ${id} token must contain at least 24 characters`);
  }

  const normalized: RemoteHostConfig = {
    id,
    label,
    transport,
    enabled: candidate.enabled !== false,
    token,
    description: typeof candidate.description === 'string' && candidate.description.trim()
      ? candidate.description.trim()
      : undefined,
  };

  if (transport === 'ssh') {
    const sshTarget = typeof candidate.sshTarget === 'string' ? candidate.sshTarget.trim() : '';
    if (!SSH_TARGET_PATTERN.test(sshTarget)) {
      throw new Error(`Remote host ${id} has an invalid sshTarget`);
    }
    normalized.sshTarget = sshTarget;
    normalized.remotePort = normalizePort(candidate.remotePort || 4010, `${id}.remotePort`);
    return normalized;
  }

  const localHost = typeof candidate.localHost === 'string' && candidate.localHost.trim()
    ? candidate.localHost.trim()
    : '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(localHost)) {
    throw new Error(`Remote host ${id} reverse tunnel must terminate on loopback`);
  }
  normalized.localHost = localHost;
  normalized.localPort = normalizePort(candidate.localPort, `${id}.localPort`);
  return normalized;
}

async function loadRegistryFile(): Promise<RemoteHostConfig[]> {
  const registryPath = CODEX_APP_CONFIG.remoteHostsFile;
  let stats;
  try {
    stats = await fs.stat(registryPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      cachedRegistry = { mtimeMs: 0, hosts: [] };
      return [];
    }
    throw error;
  }

  if (cachedRegistry?.mtimeMs === stats.mtimeMs) {
    return cachedRegistry.hosts;
  }

  const raw = await fs.readFile(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<RemoteHostRegistryFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) {
    throw new Error(`Remote host registry at ${registryPath} must use version 1`);
  }

  const hosts = parsed.hosts.map(normalizeHostConfig);
  const duplicateIds = hosts
    .map((host) => host.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Remote host registry contains duplicate ids: ${[...new Set(duplicateIds)].join(', ')}`);
  }

  cachedRegistry = {
    mtimeMs: stats.mtimeMs,
    hosts,
  };
  return hosts;
}

function getRuntimeState(hostId: string): HostRuntimeState {
  const existing = runtimeByHostId.get(hostId);
  if (existing) {
    return existing;
  }

  const created: HostRuntimeState = {
    status: 'unknown',
    tunnel: null,
    localPort: null,
    connecting: null,
    lastCheckedAt: null,
    lastError: null,
    health: null,
  };
  runtimeByHostId.set(hostId, created);
  return created;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a loopback port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitForTunnelReady(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 4_000) {
        stderr = stderr.slice(-4_000);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`SSH tunnel exited before it was ready (${code ?? signal ?? 'unknown'}): ${stderr.trim()}`));
    };
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(), 450);

    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function requestRemoteHealth(
  endpoint: RemoteAgentEndpoint,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS
): Promise<RemoteAgentHealth> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: '/api/codex/remote-agent/health',
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-code-ai-remote-token': endpoint.token,
      },
      timeout: timeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) {
          request.destroy(new Error('Remote health response exceeded 1MB'));
        }
      });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`Remote agent health returned HTTP ${response.statusCode}: ${raw.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw) as RemoteAgentHealth;
          if (parsed?.ok !== true || !Array.isArray(parsed.profiles)) {
            throw new Error('Remote health payload is invalid');
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.once('timeout', () => {
      request.destroy(new Error(`Remote health timed out after ${timeoutMs}ms`));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForRemoteHealth(
  endpoint: RemoteAgentEndpoint,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS
): Promise<RemoteAgentHealth> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await requestRemoteHealth(endpoint, Math.min(2_000, Math.max(250, deadline - Date.now())));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Remote health did not become ready within ${timeoutMs}ms`);
}

async function startSshTunnel(host: RemoteHostConfig, state: HostRuntimeState): Promise<RemoteAgentEndpoint> {
  if (!host.sshTarget || !host.remotePort) {
    throw new Error(`Remote host ${host.id} is missing SSH tunnel settings`);
  }

  if (state.tunnel && state.localPort && state.tunnel.exitCode === null && !state.tunnel.killed) {
    return {
      hostname: '127.0.0.1',
      port: state.localPort,
      token: host.token,
    };
  }

  const localPort = await reserveLoopbackPort();
  const child = spawn('ssh', [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${host.remotePort}`,
    host.sshTarget,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();

  state.tunnel = child;
  state.localPort = localPort;
  child.once('exit', () => {
    if (state.tunnel === child) {
      state.tunnel = null;
      state.localPort = null;
      state.status = 'offline';
    }
  });
  child.once('error', (error) => {
    if (state.tunnel === child) {
      state.lastError = sanitizeError(error);
      state.status = 'offline';
    }
  });

  await waitForTunnelReady(child);
  return {
    hostname: '127.0.0.1',
    port: localPort,
    token: host.token,
  };
}

function getReverseTunnelEndpoint(host: RemoteHostConfig): RemoteAgentEndpoint {
  if (!host.localHost || !host.localPort) {
    throw new Error(`Remote host ${host.id} is missing reverse tunnel settings`);
  }
  return {
    hostname: host.localHost,
    port: host.localPort,
    token: host.token,
  };
}

export async function listRemoteHostConfigs(): Promise<RemoteHostConfig[]> {
  return (await loadRegistryFile()).filter((host) => host.enabled);
}

export async function getRemoteHostConfig(hostId: string): Promise<RemoteHostConfig | null> {
  const normalizedId = hostId.trim().toLowerCase();
  const hosts = await loadRegistryFile();
  return hosts.find((host) => host.id === normalizedId && host.enabled) || null;
}

export async function ensureRemoteHostEndpoint(hostId: string): Promise<RemoteAgentEndpoint> {
  const host = await getRemoteHostConfig(hostId);
  if (!host) {
    throw new Error(`Unknown or disabled remote server: ${hostId}`);
  }

  const state = getRuntimeState(host.id);
  if (state.connecting) {
    return state.connecting;
  }

  state.status = 'connecting';
  state.lastError = null;
  state.connecting = (async () => {
    try {
      const endpoint = host.transport === 'ssh'
        ? await startSshTunnel(host, state)
        : getReverseTunnelEndpoint(host);
      const health = await waitForRemoteHealth(endpoint);
      state.health = health;
      state.status = 'online';
      state.lastCheckedAt = new Date().toISOString();
      return endpoint;
    } catch (error) {
      state.status = 'offline';
      state.lastCheckedAt = new Date().toISOString();
      state.lastError = sanitizeError(error);
      if (state.tunnel) {
        state.tunnel.kill('SIGTERM');
        state.tunnel = null;
        state.localPort = null;
      }
      throw error;
    } finally {
      state.connecting = null;
    }
  })();

  return state.connecting;
}

export async function refreshRemoteHostHealth(hostId: string): Promise<RemoteAgentHealth> {
  const host = await getRemoteHostConfig(hostId);
  if (!host) {
    throw new Error(`Unknown or disabled remote server: ${hostId}`);
  }
  const state = getRuntimeState(host.id);
  try {
    const endpoint = await ensureRemoteHostEndpoint(host.id);
    const health = await requestRemoteHealth(endpoint);
    state.health = health;
    state.status = 'online';
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = null;
    return health;
  } catch (error) {
    state.status = 'offline';
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = sanitizeError(error);
    throw error;
  }
}

export async function listCodeAiServers(options: { refresh?: boolean } = {}): Promise<CodeAiServerSummary[]> {
  const hosts = await loadRegistryFile();
  if (options.refresh) {
    await Promise.allSettled(
      hosts
        .filter((host) => host.enabled)
        .map((host) => refreshRemoteHostHealth(host.id))
    );
  }

  const summaries: CodeAiServerSummary[] = [{
    id: LOCAL_SERVER_ID,
    label: process.env.CODEX_LOCAL_SERVER_LABEL?.trim() || 'השרת הנוכחי',
    transport: 'local',
    isLocal: true,
    enabled: true,
    description: 'החשבונות והסשנים שמותקנים על שרת code-ai הנוכחי.',
    status: 'online',
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    hostname: process.env.HOSTNAME || null,
    version: process.env.npm_package_version || '1.0.0',
    codexVersion: null,
    profileCount: null,
    authenticatedProfileCount: null,
  }];

  for (const host of hosts) {
    const state = getRuntimeState(host.id);
    const profiles = state.health?.profiles || [];
    summaries.push({
      id: host.id,
      label: host.label,
      transport: host.transport,
      isLocal: false,
      enabled: host.enabled,
      description: host.description || null,
      status: host.enabled ? state.status : 'offline',
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      hostname: state.health?.hostname || null,
      version: state.health?.version || null,
      codexVersion: state.health?.codexVersion || null,
      profileCount: state.health ? profiles.length : null,
      authenticatedProfileCount: state.health
        ? profiles.filter((profile) => profile.authenticated === true).length
        : null,
    });
  }

  return summaries;
}

export function isLocalCodeAiServerId(serverId: string | null | undefined): boolean {
  return !serverId || serverId.trim().toLowerCase() === LOCAL_SERVER_ID;
}

export function invalidateRemoteHostRegistryCache(): void {
  cachedRegistry = null;
}

export async function writeRemoteHostRegistry(hosts: RemoteHostConfig[]): Promise<void> {
  const normalizedHosts = hosts.map(normalizeHostConfig);
  const targetPath = CODEX_APP_CONFIG.remoteHostsFile;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, hosts: normalizedHosts }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, targetPath);
  await fs.chmod(targetPath, 0o600);
  invalidateRemoteHostRegistryCache();
}

export function shutdownRemoteHostTunnels(): void {
  for (const state of runtimeByHostId.values()) {
    if (state.tunnel && state.tunnel.exitCode === null) {
      state.tunnel.kill('SIGTERM');
    }
    state.tunnel = null;
    state.localPort = null;
  }
}
