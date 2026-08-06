import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Server as HttpServer, IncomingMessage } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { CODEX_APP_CONFIG } from './config.js';
import {
  PERSONAL_CHROME_PROTOCOL_VERSION,
  findPersonalChromeTool,
  shouldRequirePersonalChromeApproval,
  validatePersonalChromeToolArguments,
  type PersonalChromeApprovalPolicy,
  type PersonalChromeClientEnvelope,
  type PersonalChromeCommandEnvelope,
  type PersonalChromeScope,
  type PersonalChromeServerEnvelope,
  type PersonalChromeToolName,
} from './personalChromeProtocol.js';
import {
  closePersonalPortForward,
  listPersonalPortForwards,
  openPersonalPortForward,
} from './personalPortForwardBroker.js';

type AccessMiddleware = (req: Request, res: Response, next: NextFunction) => void;

interface PersonalChromeDeviceRecord {
  id: string;
  ownerId: string;
  name: string;
  tokenHash: string;
  extensionId: string | null;
  platform: string | null;
  browserVersion: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  capabilities: string[];
}

interface PersonalChromeBindingRecord {
  id: string;
  ownerId: string;
  deviceId: string;
  profileId: string;
  sessionKey: string;
  tabId: number | null;
  tokenHash: string;
  scopes: PersonalChromeScope[];
  approvalPolicy: PersonalChromeApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

interface PairingCodeRecord {
  codeHash: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
}

interface EnrollmentTokenRecord {
  tokenHash: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
}

interface PairingAttemptWindow {
  count: number;
  resetAt: number;
}

interface BridgeState {
  version: 1;
  devices: PersonalChromeDeviceRecord[];
  bindings: PersonalChromeBindingRecord[];
}

interface DeviceConnection {
  ws: WebSocket;
  deviceId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
}

interface PendingCommand {
  deviceId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: string; details?: unknown }) => void;
  timer: NodeJS.Timeout;
}

interface PendingApproval {
  deviceId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export interface PersonalChromeBindingSecret {
  bindingId: string;
  bindingToken: string;
  controlUrl: string;
}

const BRIDGE_ROOT = path.join(CODEX_APP_CONFIG.storageRoot, 'local', 'personal-chrome-bridge');
const STATE_FILE = path.join(BRIDGE_ROOT, 'state.json');
const AUDIT_FILE = path.join(BRIDGE_ROOT, 'audit.jsonl');
const PAIRING_TTL_MS = 10 * 60_000;
const ENROLLMENT_TTL_MS = 2 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_WS_PAYLOAD = 10 * 1024 * 1024;
const TOKEN_HEADER = 'x-code-ai-extension-token';
const DEVICE_HEADER = 'x-code-ai-extension-device';
const SOCKET_PATH = '/api/codex/browser-extension/socket';
const DEFAULT_SCOPES: PersonalChromeScope[] = ['read', 'write', 'javascript', 'upload', 'ports'];

const pairingCodes = new Map<string, PairingCodeRecord>();
const enrollmentTokens = new Map<string, EnrollmentTokenRecord>();
const pairingAttempts = new Map<string, PairingAttemptWindow>();
let globalPairingAttempts: PairingAttemptWindow = { count: 0, resetAt: 0 };
const deviceConnections = new Map<string, DeviceConnection>();
const pendingCommands = new Map<string, PendingCommand>();
const pendingApprovals = new Map<string, PendingApproval>();
let state: BridgeState = { version: 1, devices: [], bindings: [] };
let loaded: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let auditTail: Promise<void> = Promise.resolve();
let heartbeatTimer: NodeJS.Timeout | null = null;
let socketServer: WebSocketServer | null = null;

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqualHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function readHeader(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] || '' : typeof value === 'string' ? value : '';
}

function ownerIdFromRequest(req: Request): string {
  const extensionOwnerId = String((req as any).codexAuth?.personalChromeOwnerId || '').trim();
  if (extensionOwnerId) return extensionOwnerId;
  if ((req as any).codeAiRemoteAgentAuthenticated === true || (req as any).codexAuth?.remoteAgent === true) {
    const proxiedOwner = readHeader(req, 'x-code-ai-proxied-owner').trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(proxiedOwner)) return `proxied:${proxiedOwner}`;
  }
  const rawId = String((req as any).codexAuth?.user?.id || 'code-ai-local-user');
  return createHmac('sha256', CODEX_APP_CONFIG.sessionSecret).update(rawId).digest('hex');
}

function consumePairingClaimAttempt(req: Request): number | null {
  const now = Date.now();
  const windowMs = 60_000;
  if (globalPairingAttempts.resetAt <= now) globalPairingAttempts = { count: 0, resetAt: now + windowMs };
  globalPairingAttempts.count += 1;
  if (globalPairingAttempts.count > 300) return Math.ceil((globalPairingAttempts.resetAt - now) / 1000);

  const remoteKey = `${req.socket.remoteAddress || 'unknown'}|${req.ip || 'unknown'}`.slice(0, 240);
  const current = pairingAttempts.get(remoteKey);
  const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  window.count += 1;
  pairingAttempts.set(remoteKey, window);
  if (pairingAttempts.size > 1000) {
    for (const [key, value] of pairingAttempts) if (value.resetAt <= now) pairingAttempts.delete(key);
  }
  return window.count > 20 ? Math.ceil((window.resetAt - now) / 1000) : null;
}

function prunePairingCodes(now = Date.now()) {
  for (const [key, pairing] of pairingCodes) {
    if (Date.parse(pairing.expiresAt) <= now) pairingCodes.delete(key);
  }
}

function pruneEnrollmentTokens(now = Date.now()) {
  for (const [key, enrollment] of enrollmentTokens) {
    if (Date.parse(enrollment.expiresAt) <= now) enrollmentTokens.delete(key);
  }
}

function normalizeDevice(value: unknown): PersonalChromeDeviceRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersonalChromeDeviceRecord>;
  if (!candidate.id || !candidate.ownerId || !candidate.tokenHash || !candidate.name) return null;
  return {
    id: String(candidate.id), ownerId: String(candidate.ownerId), name: String(candidate.name).slice(0, 120),
    tokenHash: String(candidate.tokenHash), extensionId: candidate.extensionId ? String(candidate.extensionId) : null,
    platform: candidate.platform ? String(candidate.platform).slice(0, 120) : null,
    browserVersion: candidate.browserVersion ? String(candidate.browserVersion).slice(0, 120) : null,
    createdAt: candidate.createdAt || nowIso(), updatedAt: candidate.updatedAt || nowIso(),
    lastSeenAt: candidate.lastSeenAt || null, revokedAt: candidate.revokedAt || null,
    capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.map(String).slice(0, 100) : [],
  };
}

function normalizeBinding(value: unknown): PersonalChromeBindingRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersonalChromeBindingRecord>;
  if (!candidate.id || !candidate.ownerId || !candidate.deviceId || !candidate.profileId || !candidate.sessionKey || !candidate.tokenHash) return null;
  const scopes: PersonalChromeScope[] = Array.isArray(candidate.scopes)
    ? candidate.scopes.filter((scope): scope is PersonalChromeScope => DEFAULT_SCOPES.includes(scope as PersonalChromeScope))
    : ['read', 'write'];
  return {
    id: String(candidate.id), ownerId: String(candidate.ownerId), deviceId: String(candidate.deviceId),
    profileId: String(candidate.profileId), sessionKey: String(candidate.sessionKey),
    tabId: Number.isInteger(Number(candidate.tabId)) && Number(candidate.tabId) >= 0 ? Number(candidate.tabId) : null,
    tokenHash: String(candidate.tokenHash),
    scopes, approvalPolicy: candidate.approvalPolicy === 'always' || candidate.approvalPolicy === 'never' ? candidate.approvalPolicy : 'risky',
    createdAt: candidate.createdAt || nowIso(), updatedAt: candidate.updatedAt || nowIso(), revokedAt: candidate.revokedAt || null,
  };
}

async function ensureLoaded() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as Partial<BridgeState>;
      state = {
        version: 1,
        devices: (Array.isArray(parsed.devices) ? parsed.devices : []).map(normalizeDevice).filter((value): value is PersonalChromeDeviceRecord => Boolean(value)),
        bindings: (Array.isArray(parsed.bindings) ? parsed.bindings : []).map(normalizeBinding).filter((value): value is PersonalChromeBindingRecord => Boolean(value)),
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      state = { version: 1, devices: [], bindings: [] };
    }
  })();
  return loaded;
}

async function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(BRIDGE_ROOT, { recursive: true, mode: 0o700 });
    const temporary = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
    await fs.rename(temporary, STATE_FILE);
    await fs.chmod(STATE_FILE, 0o600).catch(() => undefined);
  });
  await persistTail;
}

function redactAuditValue(value: unknown, key = ''): unknown {
  const normalizedKey = key.toLowerCase();
  if (/token|secret|password|authorization|cookie|base64/.test(normalizedKey)) return '[REDACTED]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => redactAuditValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactAuditValue(entryValue, entryKey)]));
  }
  return value;
}

async function audit(entry: Record<string, unknown>) {
  const redacted = redactAuditValue(entry);
  const safeEntry = redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
  const line = `${JSON.stringify({ at: nowIso(), ...safeEntry })}\n`;
  auditTail = auditTail.then(async () => {
    await fs.mkdir(BRIDGE_ROOT, { recursive: true, mode: 0o700 });
    await fs.appendFile(AUDIT_FILE, line, { mode: 0o600 });
  }).catch((error) => console.error('[personal-chrome] audit write failed', error));
  await auditTail;
}

function sendEnvelope(ws: WebSocket, envelope: PersonalChromeServerEnvelope) {
  if (ws.readyState !== WebSocket.OPEN) throw Object.assign(new Error('Personal Chrome is offline.'), { code: 'DEVICE_OFFLINE' });
  ws.send(JSON.stringify(envelope));
}

function publicDevice(device: PersonalChromeDeviceRecord) {
  const connection = deviceConnections.get(device.id);
  return {
    id: device.id,
    name: device.name,
    extensionId: device.extensionId,
    platform: device.platform,
    browserVersion: device.browserVersion,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
    online: Boolean(connection?.ws.readyState === WebSocket.OPEN),
    connectedAt: connection?.connectedAt || null,
    capabilities: device.capabilities,
  };
}

function findBindingByToken(token: string): PersonalChromeBindingRecord | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  return state.bindings.find((binding) => !binding.revokedAt && secureEqualHash(binding.tokenHash, tokenHash)) || null;
}

function findDeviceWithToken(deviceId: string, token: string): PersonalChromeDeviceRecord | null {
  const tokenHash = sha256(token);
  return state.devices.find((device) => device.id === deviceId && !device.revokedAt && secureEqualHash(device.tokenHash, tokenHash)) || null;
}

function parseBearer(req: Request): string {
  const authorization = readHeader(req, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || '';
}

function getControlUrl(req: Request): string {
  const configured = process.env.CODE_AI_PUBLIC_URL?.trim() || process.env.CODE_AI_CONTROL_PLANE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function argumentsPreview(args: Record<string, unknown>): string {
  const redacted = redactAuditValue(args);
  const serialized = JSON.stringify(redacted, null, 2);
  return serialized.length > 2000 ? `${serialized.slice(0, 2000)}…` : serialized;
}

function redactToolArguments(toolName: PersonalChromeToolName, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'browser_type' && args.secret === true) {
    return { ...args, text: '[REDACTED]' };
  }
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    return {
      ...args,
      fields: args.fields.map((field) => {
        if (!field || typeof field !== 'object') return field;
        const candidate = field as Record<string, unknown>;
        return candidate.secret === true ? { ...candidate, value: '[REDACTED]' } : candidate;
      }),
    };
  }
  return args;
}

function approvalDescription(toolName: PersonalChromeToolName): string {
  const descriptions: Partial<Record<PersonalChromeToolName, string>> = {
    browser_click: 'הסוכן מבקש לבצע לחיצה שעלולה לגרום לפעולה משמעותית באתר.',
    browser_fill_form: 'הסוכן מבקש למלא או לשלוח טופס בדפדפן האישי.',
    browser_upload: 'הסוכן מבקש לצרף קובץ לדף הפתוח.',
    browser_evaluate: 'הסוכן מבקש להריץ JavaScript בדף האישי.',
    dev_port_open: 'הסוכן מבקש לפתוח פורט פיתוח מקומי במחשב האישי.',
  };
  return descriptions[toolName] || 'הסוכן מבקש לבצע פעולה שמשנה את מצב הדפדפן האישי.';
}

async function requestApproval(
  connection: DeviceConnection,
  commandId: string,
  toolName: PersonalChromeToolName,
  args: Record<string, unknown>,
): Promise<boolean> {
  const approvalId = randomUUID();
  const timeoutMs = 120_000;
  const approved = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false);
    }, timeoutMs);
    pendingApprovals.set(approvalId, { deviceId: connection.deviceId, resolve, timer });
  });
  sendEnvelope(connection.ws, {
    type: 'approval_request', version: PERSONAL_CHROME_PROTOCOL_VERSION, approvalId, commandId, toolName,
    title: 'נדרש אישור לפעולה בדפדפן', description: approvalDescription(toolName),
    argumentsPreview: argumentsPreview(redactToolArguments(toolName, args)), expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  });
  return approved;
}

async function callExtension(
  binding: PersonalChromeBindingRecord,
  toolName: PersonalChromeToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const connection = deviceConnections.get(binding.deviceId);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    throw Object.assign(new Error('The paired personal Chrome is offline.'), { code: 'DEVICE_OFFLINE' });
  }
  const tool = findPersonalChromeTool(toolName);
  if (!tool) throw Object.assign(new Error(`Unknown personal Chrome tool: ${toolName}`), { code: 'UNKNOWN_TOOL' });
  if (!binding.scopes.includes(tool.scope)) {
    throw Object.assign(new Error(`The session binding does not allow the ${tool.scope} scope.`), { code: 'SCOPE_DENIED' });
  }
  const commandId = randomUUID();
  if (shouldRequirePersonalChromeApproval(tool, binding.approvalPolicy, args)) {
    const approved = await requestApproval(connection, commandId, toolName, args);
    if (!approved) throw Object.assign(new Error('The user rejected or did not approve the browser action.'), { code: 'APPROVAL_REJECTED' });
  }
  const effectiveArgs = binding.tabId !== null && args.tabId == null ? { ...args, tabId: binding.tabId } : args;
  const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(5_000, Number(effectiveArgs.timeoutMs) || 45_000));
  const result = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(Object.assign(new Error(`Personal Chrome command timed out after ${timeoutMs}ms.`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    pendingCommands.set(commandId, { deviceId: binding.deviceId, resolve, reject, timer });
  });
  const envelope: PersonalChromeCommandEnvelope = {
    type: 'command', version: PERSONAL_CHROME_PROTOCOL_VERSION, commandId, toolName, arguments: effectiveArgs,
    session: { profileId: binding.profileId, sessionKey: binding.sessionKey, bindingId: binding.id },
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
  };
  sendEnvelope(connection.ws, envelope);
  try {
    const value = await result;
    void audit({ event: 'tool_result', bindingId: binding.id, deviceId: binding.deviceId, toolName, ok: true, args: redactToolArguments(toolName, args) });
    return value;
  } catch (error: any) {
    void audit({ event: 'tool_result', bindingId: binding.id, deviceId: binding.deviceId, toolName, ok: false, error: error?.message, code: error?.code, args: redactToolArguments(toolName, args) });
    throw error;
  }
}

async function dispatchTool(binding: PersonalChromeBindingRecord, toolName: PersonalChromeToolName, args: Record<string, unknown>) {
  const tool = findPersonalChromeTool(toolName);
  if (!tool) throw Object.assign(new Error(`Unknown personal Chrome tool: ${toolName}`), { code: 'UNKNOWN_TOOL' });
  if (!binding.scopes.includes(tool.scope)) throw Object.assign(new Error(`Scope denied: ${tool.scope}`), { code: 'SCOPE_DENIED' });
  if (toolName === 'dev_port_list') return { forwards: await listPersonalPortForwards(binding.ownerId, binding.id) };
  if (toolName === 'dev_port_open') {
    const connection = deviceConnections.get(binding.deviceId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) throw Object.assign(new Error('The personal computer extension is offline.'), { code: 'DEVICE_OFFLINE' });
    if (shouldRequirePersonalChromeApproval(tool, binding.approvalPolicy, args)) {
      const approved = await requestApproval(connection, randomUUID(), toolName, args);
      if (!approved) throw Object.assign(new Error('The user rejected the port forward.'), { code: 'APPROVAL_REJECTED' });
    }
    return { forward: await openPersonalPortForward({
      ownerId: binding.ownerId, bindingId: binding.id,
      sourceServerId: String(args.sourceServerId || ''), sourcePort: Number(args.sourcePort),
      personalPort: args.personalPort == null ? null : Number(args.personalPort),
      label: typeof args.label === 'string' ? args.label : null,
      ttlMinutes: args.ttlMinutes == null ? null : Number(args.ttlMinutes),
    }) };
  }
  if (toolName === 'dev_port_close') return { forward: await closePersonalPortForward(binding.ownerId, String(args.forwardId || ''), binding.id) };
  return callExtension(binding, toolName, args);
}

function handleSocketEnvelope(connection: DeviceConnection, raw: RawData) {
  let envelope: PersonalChromeClientEnvelope;
  try {
    envelope = JSON.parse(raw.toString()) as PersonalChromeClientEnvelope;
  } catch {
    return;
  }
  connection.lastHeartbeatAt = nowIso();
  if (envelope.type === 'result') {
    const pending = pendingCommands.get(envelope.commandId);
    if (!pending || pending.deviceId !== connection.deviceId) return;
    clearTimeout(pending.timer);
    pendingCommands.delete(envelope.commandId);
    if (envelope.ok) pending.resolve(envelope.result);
    else pending.reject(Object.assign(new Error(envelope.error?.message || 'Personal Chrome command failed.'), {
      code: envelope.error?.code || 'COMMAND_FAILED', details: envelope.error?.details,
    }));
    return;
  }
  if (envelope.type === 'approval_response') {
    const pending = pendingApprovals.get(envelope.approvalId);
    if (!pending || pending.deviceId !== connection.deviceId) return;
    clearTimeout(pending.timer);
    pendingApprovals.delete(envelope.approvalId);
    pending.resolve(envelope.approved === true);
    return;
  }
  if (envelope.type === 'event' && envelope.name === 'capabilities' && Array.isArray(envelope.payload)) {
    const device = state.devices.find((entry) => entry.id === connection.deviceId);
    if (device) {
      device.capabilities = envelope.payload.map(String).slice(0, 100);
      device.updatedAt = nowIso();
      void persist();
    }
  }
}

async function authenticateSocket(ws: WebSocket, raw: RawData): Promise<DeviceConnection | null> {
  let envelope: PersonalChromeClientEnvelope;
  try { envelope = JSON.parse(raw.toString()) as PersonalChromeClientEnvelope; } catch { return null; }
  if (envelope.type !== 'auth' || envelope.version !== PERSONAL_CHROME_PROTOCOL_VERSION) return null;
  await ensureLoaded();
  const device = findDeviceWithToken(envelope.deviceId, envelope.token);
  if (!device) return null;
  const previous = deviceConnections.get(device.id);
  if (previous && previous.ws !== ws) previous.ws.close(4001, 'Replaced by a newer connection');
  const connection: DeviceConnection = { ws, deviceId: device.id, connectedAt: nowIso(), lastHeartbeatAt: nowIso() };
  deviceConnections.set(device.id, connection);
  device.lastSeenAt = nowIso();
  device.updatedAt = nowIso();
  if (envelope.extensionId) device.extensionId = envelope.extensionId.slice(0, 120);
  await persist();
  sendEnvelope(ws, { type: 'auth_ok', version: PERSONAL_CHROME_PROTOCOL_VERSION, deviceId: device.id, connectedAt: connection.connectedAt });
  void audit({ event: 'device_connected', deviceId: device.id });
  return connection;
}

function handleSocketConnection(ws: WebSocket) {
  let connection: DeviceConnection | null = null;
  const authTimer = setTimeout(() => ws.close(4003, 'Authentication timeout'), 8_000);
  ws.once('message', (raw) => {
    void authenticateSocket(ws, raw).then((authenticated) => {
      if (!authenticated) {
        ws.close(4003, 'Authentication failed');
        return;
      }
      clearTimeout(authTimer);
      connection = authenticated;
      ws.on('message', (nextRaw) => connection && handleSocketEnvelope(connection, nextRaw));
    }).catch(() => ws.close(1011, 'Authentication failed'));
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (connection && deviceConnections.get(connection.deviceId)?.ws === ws) {
      deviceConnections.delete(connection.deviceId);
      const device = state.devices.find((entry) => entry.id === connection?.deviceId);
      if (device) {
        device.lastSeenAt = nowIso();
        device.updatedAt = nowIso();
        void persist();
      }
      for (const [commandId, pending] of pendingCommands.entries()) {
        if (pending.deviceId !== connection.deviceId) continue;
        clearTimeout(pending.timer);
        pendingCommands.delete(commandId);
        pending.reject(Object.assign(new Error('Personal Chrome disconnected during the command.'), { code: 'DEVICE_OFFLINE' }));
      }
      for (const [approvalId, pending] of pendingApprovals.entries()) {
        if (pending.deviceId !== connection.deviceId) continue;
        clearTimeout(pending.timer);
        pendingApprovals.delete(approvalId);
        pending.resolve(false);
      }
    }
  });
}

export function attachPersonalChromeBridge(server: HttpServer): void {
  if (socketServer) return;
  socketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  socketServer.on('connection', handleSocketConnection);
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url || '/', 'http://code-ai.internal').pathname;
    if (pathname !== SOCKET_PATH || !socketServer) return;
    socketServer.handleUpgrade(request, socket, head, (ws) => socketServer?.emit('connection', ws, request));
  });
  heartbeatTimer = setInterval(() => {
    for (const connection of deviceConnections.values()) {
      if (Date.now() - Date.parse(connection.lastHeartbeatAt) > 90_000) {
        connection.ws.terminate();
        continue;
      }
      try {
        sendEnvelope(connection.ws, { type: 'ping', version: PERSONAL_CHROME_PROTOCOL_VERSION, sentAt: nowIso() });
      } catch {
        connection.ws.terminate();
      }
    }
  }, 20_000);
  heartbeatTimer.unref();
}

export function shutdownPersonalChromeBridge(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  for (const connection of deviceConnections.values()) connection.ws.close(1001, 'Server shutdown');
  deviceConnections.clear();
  socketServer?.close();
  socketServer = null;
}

export async function authenticatePersonalChromeUiToken(deviceId: string, token: string) {
  await ensureLoaded();
  const device = findDeviceWithToken(deviceId, token);
  if (!device) return null;
  return {
    authenticated: true, localBypass: false, publicAccess: false, deviceUnlocked: true, extensionDevice: true,
    personalChromeOwnerId: device.ownerId,
    user: { id: `extension:${device.ownerId}`, email: '', name: device.name },
  };
}

export async function issuePersonalChromeEnrollmentToken(req: Request) {
  await ensureLoaded();
  pruneEnrollmentTokens();
  const ownerId = ownerIdFromRequest(req);
  for (const [key, enrollment] of enrollmentTokens) {
    if (enrollment.ownerId === ownerId) enrollmentTokens.delete(key);
  }
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
  enrollmentTokens.set(tokenHash, { tokenHash, ownerId, createdAt, expiresAt });
  await audit({ event: 'extension_enrollment_issued', ownerId, expiresAt });
  return { token, expiresAt };
}

export function readPersonalChromeUiCredentials(req: Request): { deviceId: string; token: string } | null {
  const deviceId = readHeader(req, DEVICE_HEADER).trim();
  const token = readHeader(req, TOKEN_HEADER).trim();
  return deviceId && token ? { deviceId, token } : null;
}

export function createPersonalChromeBridgeRouter(requireAccess: AccessMiddleware) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, protocolVersion: PERSONAL_CHROME_PROTOCOL_VERSION, socketPath: SOCKET_PATH });
  });

  router.post('/pairing/start', requireAccess, async (req, res) => {
    await ensureLoaded();
    const ownerId = ownerIdFromRequest(req);
    prunePairingCodes();
    for (const [key, pairing] of pairingCodes) if (pairing.ownerId === ownerId) pairingCodes.delete(key);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const entropy = randomBytes(8);
    const rawCode = Array.from(entropy, (byte) => alphabet[byte % alphabet.length]).join('');
    const code = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;
    const key = sha256(code.replace(/-/g, ''));
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    pairingCodes.set(key, { codeHash: key, ownerId, createdAt: nowIso(), expiresAt });
    res.json({ code, expiresAt, controlUrl: getControlUrl(req), socketPath: SOCKET_PATH });
  });

  router.post('/pairing/claim', async (req, res) => {
    await ensureLoaded();
    const retryAfter = consumePairingClaimAttempt(req);
    if (retryAfter !== null) {
      res.setHeader('retry-after', String(Math.max(1, retryAfter)));
      res.status(429).json({ error: 'יותר מדי ניסיונות חיבור. נסה שוב בעוד דקה.' });
      return;
    }
    prunePairingCodes();
    const normalizedCode = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const key = sha256(normalizedCode);
    const pairing = pairingCodes.get(key);
    if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) {
      pairingCodes.delete(key);
      res.status(400).json({ error: 'קוד החיבור שגוי או פג תוקף.' });
      return;
    }
    pairingCodes.delete(key);
    const token = randomBytes(32).toString('base64url');
    const device: PersonalChromeDeviceRecord = {
      id: randomUUID(), ownerId: pairing.ownerId,
      name: String(req.body?.deviceName || 'Chrome אישי').trim().slice(0, 120) || 'Chrome אישי',
      tokenHash: sha256(token),
      extensionId: typeof req.body?.extensionId === 'string' ? req.body.extensionId.slice(0, 120) : null,
      platform: typeof req.body?.platform === 'string' ? req.body.platform.slice(0, 120) : null,
      browserVersion: typeof req.body?.browserVersion === 'string' ? req.body.browserVersion.slice(0, 120) : null,
      createdAt: nowIso(), updatedAt: nowIso(), lastSeenAt: null, revokedAt: null, capabilities: [],
    };
    state.devices.push(device);
    await persist();
    await audit({ event: 'device_paired', deviceId: device.id, ownerId: device.ownerId, name: device.name });
    res.status(201).json({
      deviceId: device.id, deviceToken: token, device: publicDevice(device),
      controlUrl: getControlUrl(req), socketPath: SOCKET_PATH,
    });
  });

  router.post('/enrollment/claim', async (req, res) => {
    await ensureLoaded();
    const retryAfter = consumePairingClaimAttempt(req);
    if (retryAfter !== null) {
      res.setHeader('retry-after', String(Math.max(1, retryAfter)));
      res.status(429).json({ error: 'יותר מדי ניסיונות אישור מכשיר. נסה שוב בעוד דקה.' });
      return;
    }
    pruneEnrollmentTokens();
    const rawToken = typeof req.body?.enrollmentToken === 'string' ? req.body.enrollmentToken.trim() : '';
    const tokenHash = sha256(rawToken);
    const enrollment = rawToken ? enrollmentTokens.get(tokenHash) : null;
    if (!enrollment || Date.parse(enrollment.expiresAt) <= Date.now()) {
      if (enrollment) enrollmentTokens.delete(tokenHash);
      res.status(400).json({ error: 'אישור המכשיר אינו תקף או שפג תוקפו. הזן שוב את סיסמת המכשיר.' });
      return;
    }
    enrollmentTokens.delete(tokenHash);
    const token = randomBytes(32).toString('base64url');
    const device: PersonalChromeDeviceRecord = {
      id: randomUUID(), ownerId: enrollment.ownerId,
      name: String(req.body?.deviceName || 'Chrome במחשב האישי').trim().slice(0, 120) || 'Chrome במחשב האישי',
      tokenHash: sha256(token),
      extensionId: typeof req.body?.extensionId === 'string' ? req.body.extensionId.slice(0, 120) : null,
      platform: typeof req.body?.platform === 'string' ? req.body.platform.slice(0, 120) : null,
      browserVersion: typeof req.body?.browserVersion === 'string' ? req.body.browserVersion.slice(0, 120) : null,
      createdAt: nowIso(), updatedAt: nowIso(), lastSeenAt: null, revokedAt: null, capabilities: [],
    };
    state.devices.push(device);
    await persist();
    await audit({ event: 'device_enrolled', deviceId: device.id, ownerId: device.ownerId, name: device.name });
    res.status(201).json({
      deviceId: device.id, deviceToken: token, device: publicDevice(device),
      controlUrl: getControlUrl(req), socketPath: SOCKET_PATH,
    });
  });

  router.get('/devices', requireAccess, async (req, res) => {
    await ensureLoaded();
    const ownerId = ownerIdFromRequest(req);
    res.json({ devices: state.devices.filter((device) => device.ownerId === ownerId && !device.revokedAt).map(publicDevice) });
  });

  router.delete('/devices/:deviceId', requireAccess, async (req, res) => {
    await ensureLoaded();
    const ownerId = ownerIdFromRequest(req);
    const device = state.devices.find((entry) => entry.id === req.params.deviceId && entry.ownerId === ownerId && !entry.revokedAt);
    if (!device) { res.status(404).json({ error: 'Device not found' }); return; }
    device.revokedAt = nowIso();
    device.updatedAt = nowIso();
    for (const binding of state.bindings) if (binding.deviceId === device.id && !binding.revokedAt) binding.revokedAt = nowIso();
    deviceConnections.get(device.id)?.ws.close(4004, 'Device revoked');
    await persist();
    res.json({ revoked: true, deviceId: device.id });
  });

  router.post('/bindings', requireAccess, async (req, res) => {
    await ensureLoaded();
    const ownerId = ownerIdFromRequest(req);
    const deviceId = String(req.body?.deviceId || '');
    const device = state.devices.find((entry) => entry.id === deviceId && entry.ownerId === ownerId && !entry.revokedAt);
    if (!device) { res.status(404).json({ error: 'ה־Chrome האישי שנבחר לא נמצא.' }); return; }
    const profileId = String(req.body?.profileId || '').trim();
    const sessionKey = String(req.body?.sessionKey || '').trim();
    if (!profileId || !sessionKey) { res.status(400).json({ error: 'profileId and sessionKey are required.' }); return; }
    const requestedScopes = Array.isArray(req.body?.scopes) ? req.body.scopes : DEFAULT_SCOPES;
    const scopes = requestedScopes.filter((scope: unknown): scope is PersonalChromeScope => DEFAULT_SCOPES.includes(scope as PersonalChromeScope));
    const approvalPolicy: PersonalChromeApprovalPolicy = req.body?.approvalPolicy === 'always' || req.body?.approvalPolicy === 'never'
      ? req.body.approvalPolicy : 'risky';
    const token = randomBytes(32).toString('base64url');
    const binding: PersonalChromeBindingRecord = {
      id: randomUUID(), ownerId, deviceId, profileId, sessionKey,
      tabId: Number.isInteger(Number(req.body?.tabId)) && Number(req.body.tabId) >= 0 ? Number(req.body.tabId) : null,
      tokenHash: sha256(token),
      scopes: scopes.length ? scopes : ['read'], approvalPolicy,
      createdAt: nowIso(), updatedAt: nowIso(), revokedAt: null,
    };
    state.bindings.push(binding);
    await persist();
    await audit({ event: 'binding_created', bindingId: binding.id, deviceId, profileId, sessionKey, scopes, approvalPolicy });
    res.status(201).json({
      binding: { id: binding.id, deviceId, profileId, sessionKey, scopes, approvalPolicy, createdAt: binding.createdAt },
      bindingToken: token,
      controlUrl: getControlUrl(req),
    });
  });

  router.delete('/bindings/:bindingId', requireAccess, async (req, res) => {
    await ensureLoaded();
    const ownerId = ownerIdFromRequest(req);
    const binding = state.bindings.find((entry) => entry.id === req.params.bindingId && entry.ownerId === ownerId && !entry.revokedAt);
    if (!binding) { res.status(404).json({ error: 'Binding not found' }); return; }
    binding.revokedAt = nowIso();
    binding.updatedAt = nowIso();
    for (const forward of await listPersonalPortForwards(ownerId, binding.id)) {
      await closePersonalPortForward(ownerId, forward.id).catch(() => undefined);
    }
    await persist();
    res.json({ revoked: true, bindingId: binding.id });
  });

  router.post('/tool-call', async (req, res) => {
    await ensureLoaded();
    const binding = findBindingByToken(parseBearer(req));
    if (!binding) { res.status(401).json({ error: { code: 'INVALID_BINDING', message: 'Personal Chrome binding is invalid or revoked.' } }); return; }
    const toolName = String(req.body?.toolName || '') as PersonalChromeToolName;
    const args = req.body?.arguments && typeof req.body.arguments === 'object' && !Array.isArray(req.body.arguments)
      ? req.body.arguments as Record<string, unknown> : {};
    const tool = findPersonalChromeTool(toolName);
    if (!tool) {
      res.status(400).json({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown personal Chrome tool: ${toolName}` } });
      return;
    }
    const argumentError = validatePersonalChromeToolArguments(tool, args);
    if (argumentError) {
      res.status(400).json({ ok: false, error: { code: 'INVALID_ARGUMENT', message: argumentError } });
      return;
    }
    if (toolName === 'browser_upload' && typeof args.base64 === 'string' && args.base64.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Browser upload payload is limited to 6MB.' } });
      return;
    }
    try {
      const result = await dispatchTool(binding, toolName, args);
      res.json({ ok: true, result });
    } catch (error: any) {
      const code = error?.code || 'TOOL_FAILED';
      const status = code === 'DEVICE_OFFLINE' ? 409 : code === 'SCOPE_DENIED' || code === 'APPROVAL_REJECTED' ? 403 : 400;
      res.status(status).json({ ok: false, error: { code, message: error?.message || 'Personal Chrome tool failed.', details: error?.details } });
    }
  });

  return router;
}
