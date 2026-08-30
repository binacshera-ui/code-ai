import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { CODEX_APP_CONFIG } from './config.js';

const SHORT_MESSAGE_LIMIT_BYTES = 3_600;
const NTFY_ATTACHMENT_LIMIT_BYTES = 1_900_000;
const MAX_DELIVERY_ATTEMPTS = 6;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];

type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed';

interface PersistedSessionFinalNotificationDelivery {
  id: string;
  sequenceId: string;
  profileId: string;
  sessionId: string;
  preferenceSessionKey: string;
  sessionTitle: string | null;
  provider: string | null;
  finalMessage: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

interface PersistedSessionFinalNotificationState {
  version: 1;
  overridesByKey: Record<string, boolean>;
  deliveriesById: Record<string, PersistedSessionFinalNotificationDelivery>;
}

export interface CodexSessionFinalNotificationPreference {
  enabled: boolean;
  effectiveEnabled: boolean;
  defaultEnabled: boolean;
  available: boolean;
  endpointLabel: string | null;
  longResponseMode: 'attachment';
}

export interface EnqueueFinalResponseNotificationInput {
  profileId: string;
  preferenceSessionKey: string;
  sessionId: string;
  finalMessage: string;
  sessionTitle?: string | null;
  provider?: string | null;
  dedupeKey?: string | null;
}

interface ResolvedNtfyConfig {
  endpoint: string | null;
  enabled: boolean;
  defaultSessionEnabled: boolean;
  accessToken: string | null;
  publicOrigin: string;
}

export interface NtfyRequestDescription {
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  body: ArrayBuffer;
  isAttachment: boolean;
  filename: string | null;
}

interface BuildNtfyRequestInput {
  endpoint: string;
  accessToken?: string | null;
  sequenceId: string;
  profileId: string;
  sessionId: string;
  sessionTitle?: string | null;
  provider?: string | null;
  finalMessage: string;
  publicOrigin?: string;
}

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let workerStarted = false;
let workerTickInFlight = false;
let workerTimer: NodeJS.Timeout | null = null;
let state: PersistedSessionFinalNotificationState = createEmptyState();

function createEmptyState(): PersistedSessionFinalNotificationState {
  return {
    version: 1,
    overridesByKey: {},
    deliveriesById: {},
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeHttpUrl(value: string | undefined): string | null {
  const normalized = value?.trim() || '';
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function defaultPublicOrigin(): string {
  const port = Number.parseInt(process.env.PORT || '4000', 10);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 4000}`;
}

function resolveNtfyConfig(): ResolvedNtfyConfig {
  return {
    endpoint: normalizeHttpUrl(process.env.CODEX_NTFY_URL),
    enabled: parseBoolean(process.env.CODEX_NTFY_ENABLED, true),
    defaultSessionEnabled: parseBoolean(process.env.CODEX_NTFY_DEFAULT_ENABLED, true),
    accessToken: process.env.CODEX_NTFY_ACCESS_TOKEN?.trim() || null,
    publicOrigin: normalizeHttpUrl(process.env.CODEX_PUBLIC_ORIGIN)
      || defaultPublicOrigin(),
  };
}

function getStateFile(): string {
  return path.resolve(
    process.env.CODEX_NTFY_STATE_FILE?.trim()
      || path.join(CODEX_APP_CONFIG.storageRoot, 'session-final-notifications.json')
  );
}

function buildPreferenceKey(profileId: string, sessionKey: string): string {
  return JSON.stringify([profileId.trim(), sessionKey.trim()]);
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\u0000/gu, '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeDelivery(value: unknown): PersistedSessionFinalNotificationDelivery | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersistedSessionFinalNotificationDelivery>;
  const id = normalizeText(candidate.id, 128);
  const sequenceId = normalizeText(candidate.sequenceId, 64);
  const profileId = normalizeText(candidate.profileId, 240);
  const sessionId = normalizeText(candidate.sessionId, 240);
  const preferenceSessionKey = normalizeText(candidate.preferenceSessionKey, 240);
  if (!id || !sequenceId || !profileId || !sessionId || !preferenceSessionKey) return null;
  const status: DeliveryStatus = candidate.status === 'delivered'
    ? 'delivered'
    : candidate.status === 'failed'
      ? 'failed'
      : 'pending';
  return {
    id,
    sequenceId,
    profileId,
    sessionId,
    preferenceSessionKey,
    sessionTitle: normalizeText(candidate.sessionTitle, 240),
    provider: normalizeText(candidate.provider, 40),
    finalMessage: typeof candidate.finalMessage === 'string' ? candidate.finalMessage : null,
    status,
    attempts: Number.isInteger(candidate.attempts) ? Math.max(0, Number(candidate.attempts)) : 0,
    nextAttemptAt: normalizeText(candidate.nextAttemptAt, 80) || nowIso(),
    createdAt: normalizeText(candidate.createdAt, 80) || nowIso(),
    updatedAt: normalizeText(candidate.updatedAt, 80) || nowIso(),
    deliveredAt: normalizeText(candidate.deliveredAt, 80),
    lastError: normalizeText(candidate.lastError, 1_000),
  };
}

async function ensureStateLoaded(): Promise<void> {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }
  stateLoadedPromise = (async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(getStateFile(), 'utf8')) as Partial<PersistedSessionFinalNotificationState>;
      const overridesByKey = parsed.overridesByKey && typeof parsed.overridesByKey === 'object'
        ? Object.fromEntries(
          Object.entries(parsed.overridesByKey)
            .filter(([key, enabled]) => Boolean(key) && typeof enabled === 'boolean')
        )
        : {};
      const deliveriesById: Record<string, PersistedSessionFinalNotificationDelivery> = {};
      if (parsed.deliveriesById && typeof parsed.deliveriesById === 'object') {
        for (const value of Object.values(parsed.deliveriesById)) {
          const delivery = normalizeDelivery(value);
          if (delivery) deliveriesById[delivery.id] = delivery;
        }
      }
      state = { version: 1, overridesByKey, deliveriesById };
      pruneDeliveredRecords();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      state = createEmptyState();
    }
  })();
  return stateLoadedPromise;
}

function pruneDeliveredRecords(): void {
  const cutoff = Date.now() - DELIVERY_RETENTION_MS;
  for (const [id, delivery] of Object.entries(state.deliveriesById)) {
    if (
      (delivery.status === 'delivered' || delivery.status === 'failed')
      && new Date(delivery.updatedAt).getTime() < cutoff
    ) {
      delete state.deliveriesById[id];
    }
  }
}

async function persistState(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2);
  const stateFile = getStateFile();
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temporaryFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryFile, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryFile, stateFile);
    } finally {
      await fs.unlink(temporaryFile).catch(() => undefined);
    }
  });
  await persistTail;
}

function endpointLabel(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export async function getSessionFinalNotificationPreference(
  profileId: string,
  sessionKey: string
): Promise<CodexSessionFinalNotificationPreference> {
  await ensureStateLoaded();
  const config = resolveNtfyConfig();
  const override = state.overridesByKey[buildPreferenceKey(profileId, sessionKey)];
  const enabled = typeof override === 'boolean' ? override : config.defaultSessionEnabled;
  return {
    enabled,
    effectiveEnabled: Boolean(config.endpoint) && config.enabled && enabled,
    defaultEnabled: config.defaultSessionEnabled,
    available: Boolean(config.endpoint),
    endpointLabel: endpointLabel(config.endpoint),
    longResponseMode: 'attachment',
  };
}

export async function setSessionFinalNotificationPreference(
  profileId: string,
  sessionKey: string,
  enabled: boolean
): Promise<CodexSessionFinalNotificationPreference> {
  await ensureStateLoaded();
  const key = buildPreferenceKey(profileId, sessionKey);
  const config = resolveNtfyConfig();
  if (enabled === config.defaultSessionEnabled) {
    delete state.overridesByKey[key];
  } else {
    state.overridesByKey[key] = enabled;
  }
  await persistState();
  return getSessionFinalNotificationPreference(profileId, sessionKey);
}

export async function rebindSessionFinalNotificationPreference(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string
): Promise<void> {
  await ensureStateLoaded();
  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) return;
  const fromKey = buildPreferenceKey(profileId, fromSessionKey);
  if (typeof state.overridesByKey[fromKey] !== 'boolean') return;
  state.overridesByKey[buildPreferenceKey(profileId, toSessionKey)] = state.overridesByKey[fromKey];
  delete state.overridesByKey[fromKey];
  await persistState();
}

export async function copySessionFinalNotificationPreference(
  sourceProfileId: string,
  sourceSessionKey: string,
  targetProfileId: string,
  targetSessionKey: string
): Promise<void> {
  await ensureStateLoaded();
  const value = state.overridesByKey[buildPreferenceKey(sourceProfileId, sourceSessionKey)];
  if (typeof value !== 'boolean') return;
  state.overridesByKey[buildPreferenceKey(targetProfileId, targetSessionKey)] = value;
  await persistState();
}

export async function deleteSessionFinalNotificationPreference(
  profileId: string,
  sessionKey: string
): Promise<void> {
  await ensureStateLoaded();
  const key = buildPreferenceKey(profileId, sessionKey);
  if (typeof state.overridesByKey[key] !== 'boolean') return;
  delete state.overridesByKey[key];
  await persistState();
}

function sanitizeHeaderText(value: string, maxLength: number): string {
  return value.replace(/[\r\n\u0000]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}

export function encodeNtfyHeader(value: string): string {
  const sanitized = sanitizeHeaderText(value, 1_200);
  if (/^[\x20-\x7e]*$/u.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, 'utf8').toString('base64')}?=`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) lower = middle;
    else upper = middle - 1;
  }
  return value.slice(0, lower).trimEnd();
}

function buildSessionLink(publicOrigin: string, profileId: string, sessionId: string): string {
  return `${publicOrigin.replace(/\/$/u, '')}/session/${encodeURIComponent(profileId)}/${encodeURIComponent(sessionId)}`;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'session';
}

function buildNotificationTitle(sessionTitle: string | null | undefined, provider: string | null | undefined): string {
  const title = sanitizeHeaderText(sessionTitle || '', 100);
  const providerLabel = provider === 'claude' ? 'Claude' : provider === 'gemini' ? 'Gemini' : 'Codex';
  return title ? `${providerLabel} סיים · ${title}` : `${providerLabel} סיים את המשימה`;
}

function buildAttachmentPreview(finalMessage: string): string {
  const normalized = finalMessage.replace(/\s+/gu, ' ').trim();
  const preview = truncateUtf8(normalized, 700);
  return `התשובה הסופית המלאה מצורפת כקובץ טקסט.\n\n${preview}${preview.length < normalized.length ? '…' : ''}`;
}

function toRequestBody(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function buildNtfyRequest(input: BuildNtfyRequestInput): NtfyRequestDescription {
  const finalMessage = input.finalMessage;
  if (!finalMessage.trim()) throw new Error('Cannot send an empty final response to ntfy');
  const publicOrigin = normalizeHttpUrl(input.publicOrigin) || defaultPublicOrigin();
  const commonHeaders: Record<string, string> = {
    Title: encodeNtfyHeader(buildNotificationTitle(input.sessionTitle, input.provider)),
    Tags: 'white_check_mark,robot_face',
    Click: buildSessionLink(publicOrigin, input.profileId, input.sessionId),
    'X-Sequence-ID': input.sequenceId,
  };
  if (input.accessToken?.trim()) {
    commonHeaders.Authorization = `Bearer ${input.accessToken.trim()}`;
  }

  const plainBytes = Buffer.from(finalMessage, 'utf8');
  if (plainBytes.length <= SHORT_MESSAGE_LIMIT_BYTES) {
    return {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'text/markdown; charset=utf-8',
        Markdown: 'yes',
      },
      body: toRequestBody(plainBytes),
      isAttachment: false,
      filename: null,
    };
  }

  let attachmentBytes = plainBytes;
  let filename = `codex-response-${safeFilenamePart(input.sessionId)}.txt`;
  let contentType = 'text/plain; charset=utf-8';
  let preview = buildAttachmentPreview(finalMessage);
  if (attachmentBytes.length > NTFY_ATTACHMENT_LIMIT_BYTES) {
    attachmentBytes = gzipSync(attachmentBytes, { level: 9 });
    filename = `${filename}.gz`;
    contentType = 'application/gzip';
    preview = `התשובה הסופית המלאה מצורפת כקובץ טקסט דחוס.\n\n${truncateUtf8(finalMessage.replace(/\s+/gu, ' '), 650)}…`;
  }
  if (attachmentBytes.length > NTFY_ATTACHMENT_LIMIT_BYTES) {
    throw new Error('The final response is too large for the configured ntfy attachment limit');
  }

  return {
    method: 'PUT',
    headers: {
      ...commonHeaders,
      'Content-Type': contentType,
      Filename: filename,
      Message: encodeNtfyHeader(preview),
    },
    body: toRequestBody(attachmentBytes),
    isAttachment: true,
    filename,
  };
}

async function deliverNotification(
  delivery: PersistedSessionFinalNotificationDelivery,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const config = resolveNtfyConfig();
  if (!config.endpoint || !config.enabled) {
    throw new Error('ntfy delivery is not configured or is globally disabled');
  }
  if (!delivery.finalMessage) {
    throw new Error('Persisted ntfy delivery is missing its final response');
  }
  const request = buildNtfyRequest({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    sequenceId: delivery.sequenceId,
    profileId: delivery.profileId,
    sessionId: delivery.sessionId,
    sessionTitle: delivery.sessionTitle,
    provider: delivery.provider,
    finalMessage: delivery.finalMessage,
    publicOrigin: config.publicOrigin,
  });
  const response = await fetchImpl(config.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/gu, ' ').trim().slice(0, 500);
    throw new Error(`ntfy returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

function scheduleWorker(delayMs: number): void {
  if (!workerStarted) return;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = setTimeout(() => {
    workerTimer = null;
    void tickWorker();
  }, Math.max(0, delayMs));
  workerTimer.unref();
}

function nextRetryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempts - 1), RETRY_DELAYS_MS.length - 1)];
}

async function tickWorker(): Promise<void> {
  if (!workerStarted || workerTickInFlight) return;
  workerTickInFlight = true;
  try {
    await ensureStateLoaded();
    const now = Date.now();
    const delivery = Object.values(state.deliveriesById)
      .filter((candidate) => (
        candidate.status === 'pending'
        && candidate.attempts < MAX_DELIVERY_ATTEMPTS
        && new Date(candidate.nextAttemptAt).getTime() <= now
      ))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0];

    if (!delivery) {
      const next = Object.values(state.deliveriesById)
        .filter((candidate) => candidate.status === 'pending' && candidate.attempts < MAX_DELIVERY_ATTEMPTS)
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))[0];
      scheduleWorker(next ? Math.max(1_000, new Date(next.nextAttemptAt).getTime() - now) : 60_000);
      return;
    }

    delivery.status = 'sending';
    delivery.attempts += 1;
    delivery.updatedAt = nowIso();
    await persistState();
    try {
      await deliverNotification(delivery);
      delivery.status = 'delivered';
      delivery.deliveredAt = nowIso();
      delivery.updatedAt = delivery.deliveredAt;
      delivery.lastError = null;
      delivery.finalMessage = null;
    } catch (error: any) {
      delivery.lastError = String(error?.message || error).slice(0, 1_000);
      delivery.updatedAt = nowIso();
      if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
        delivery.status = 'failed';
        delivery.finalMessage = null;
        console.error(`❌ ntfy final notification failed permanently (${delivery.id}):`, delivery.lastError);
      } else {
        delivery.status = 'pending';
        delivery.nextAttemptAt = new Date(Date.now() + nextRetryDelay(delivery.attempts)).toISOString();
        console.warn(`⚠️ ntfy final notification will retry (${delivery.id}):`, delivery.lastError);
      }
    }
    pruneDeliveredRecords();
    await persistState();
    scheduleWorker(0);
  } finally {
    workerTickInFlight = false;
  }
}

export async function enqueueFinalResponseNotification(
  input: EnqueueFinalResponseNotificationInput
): Promise<{ queued: boolean; reason: 'queued' | 'disabled' | 'duplicate' }> {
  await ensureStateLoaded();
  const preference = await getSessionFinalNotificationPreference(input.profileId, input.preferenceSessionKey);
  if (!preference.effectiveEnabled || !input.finalMessage.trim()) {
    return { queued: false, reason: 'disabled' };
  }
  const dedupeSource = input.dedupeKey?.trim()
    || `${input.profileId}:${input.sessionId}:${randomUUID()}`;
  const id = createHash('sha256').update(`final-notification:${dedupeSource}`).digest('hex');
  if (state.deliveriesById[id]) {
    return { queued: false, reason: 'duplicate' };
  }
  const timestamp = nowIso();
  state.deliveriesById[id] = {
    id,
    sequenceId: `code-ai-${id.slice(0, 24)}`,
    profileId: input.profileId,
    sessionId: input.sessionId,
    preferenceSessionKey: input.preferenceSessionKey,
    sessionTitle: normalizeText(input.sessionTitle, 240),
    provider: normalizeText(input.provider, 40),
    finalMessage: input.finalMessage,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    deliveredAt: null,
    lastError: null,
  };
  pruneDeliveredRecords();
  await persistState();
  scheduleWorker(0);
  return { queued: true, reason: 'queued' };
}

export async function startCodexFinalNotificationWorker(): Promise<void> {
  await ensureStateLoaded();
  let changed = false;
  for (const delivery of Object.values(state.deliveriesById)) {
    if (delivery.status === 'sending') {
      delivery.status = 'pending';
      delivery.nextAttemptAt = nowIso();
      changed = true;
    }
  }
  if (changed) await persistState();
  workerStarted = true;
  scheduleWorker(0);
}

export async function deliverNtfyRequestForTest(
  input: BuildNtfyRequestInput,
  fetchImpl: typeof fetch
): Promise<void> {
  const request = buildNtfyRequest(input);
  const response = await fetchImpl(input.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  if (!response.ok) throw new Error(`ntfy returned ${response.status}`);
}

export function resetCodexFinalNotificationRuntimeForTests(): void {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  workerStarted = false;
  workerTickInFlight = false;
  stateLoadedPromise = null;
  persistTail = Promise.resolve();
  state = createEmptyState();
}
