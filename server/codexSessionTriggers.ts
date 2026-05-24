import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionTrigger {
  id: string;
  profileId: string;
  sessionId: string;
  label: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt: string | null;
  lastPayloadPreview: string | null;
}

interface CodexSessionTriggersState {
  triggersBySessionKey: Record<string, CodexSessionTrigger>;
  sessionKeyByTriggerId: Record<string, string>;
}

const TRIGGERS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-triggers.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexSessionTriggersState = {
  triggersBySessionKey: {},
  sessionKeyByTriggerId: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildSessionKey(profileId: string, sessionId: string): string {
  return `${profileId}:${sessionId}`;
}

function cloneTrigger(trigger: CodexSessionTrigger): CodexSessionTrigger {
  return { ...trigger };
}

function normalizeLabel(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('Trigger label is required');
  }
  return normalized.slice(0, 80);
}

function generateToken(): string {
  return randomBytes(24).toString('hex');
}

function buildPayloadPreview(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 220
    ? `${normalized.slice(0, 219).trimEnd()}…`
    : normalized;
}

async function ensureStorageRoot() {
  await fs.mkdir(CODEX_APP_CONFIG.storageRoot, { recursive: true });
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await ensureStorageRoot();
    await fs.writeFile(TRIGGERS_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

async function loadState() {
  await ensureStorageRoot();

  try {
    const raw = await fs.readFile(TRIGGERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CodexSessionTriggersState>;
    state = {
      triggersBySessionKey: parsed.triggersBySessionKey && typeof parsed.triggersBySessionKey === 'object'
        ? parsed.triggersBySessionKey as Record<string, CodexSessionTrigger>
        : {},
      sessionKeyByTriggerId: parsed.sessionKeyByTriggerId && typeof parsed.sessionKeyByTriggerId === 'object'
        ? parsed.sessionKeyByTriggerId as Record<string, string>
        : {},
    };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    state = {
      triggersBySessionKey: {},
      sessionKeyByTriggerId: {},
    };
  }
}

async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }
  await stateLoadedPromise;
}

export async function getSessionTrigger(profileId: string, sessionId: string): Promise<CodexSessionTrigger | null> {
  await ensureStateLoaded();
  const key = buildSessionKey(profileId, sessionId);
  const trigger = state.triggersBySessionKey[key];
  return trigger ? cloneTrigger(trigger) : null;
}

export async function upsertSessionTrigger(
  profileId: string,
  sessionId: string,
  label: string,
  options?: {
    rotateToken?: boolean;
  }
): Promise<CodexSessionTrigger> {
  await ensureStateLoaded();

  const key = buildSessionKey(profileId, sessionId);
  const existing = state.triggersBySessionKey[key];
  const nextTrigger: CodexSessionTrigger = existing
    ? {
        ...existing,
        label: normalizeLabel(label),
        token: options?.rotateToken ? generateToken() : existing.token,
        updatedAt: nowIso(),
      }
    : {
        id: randomUUID(),
        profileId,
        sessionId,
        label: normalizeLabel(label),
        token: generateToken(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastTriggeredAt: null,
        lastPayloadPreview: null,
      };

  state.triggersBySessionKey[key] = nextTrigger;
  state.sessionKeyByTriggerId[nextTrigger.id] = key;
  await persistState();
  return cloneTrigger(nextTrigger);
}

export async function deleteSessionTrigger(profileId: string, sessionId: string): Promise<void> {
  await ensureStateLoaded();
  const key = buildSessionKey(profileId, sessionId);
  const existing = state.triggersBySessionKey[key];
  if (!existing) {
    return;
  }

  delete state.triggersBySessionKey[key];
  delete state.sessionKeyByTriggerId[existing.id];
  await persistState();
}

export async function resolveTriggerInvocation(triggerId: string, token: string): Promise<CodexSessionTrigger | null> {
  await ensureStateLoaded();
  const sessionKey = state.sessionKeyByTriggerId[triggerId];
  if (!sessionKey) {
    return null;
  }

  const trigger = state.triggersBySessionKey[sessionKey];
  if (!trigger) {
    delete state.sessionKeyByTriggerId[triggerId];
    await persistState();
    return null;
  }

  const expected = Buffer.from(trigger.token, 'utf-8');
  const provided = Buffer.from(token, 'utf-8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  return cloneTrigger(trigger);
}

export async function recordSessionTriggerInvocation(
  profileId: string,
  sessionId: string,
  payloadPreview: string | null
): Promise<void> {
  await ensureStateLoaded();
  const key = buildSessionKey(profileId, sessionId);
  const trigger = state.triggersBySessionKey[key];
  if (!trigger) {
    return;
  }

  trigger.lastTriggeredAt = nowIso();
  trigger.lastPayloadPreview = buildPayloadPreview(payloadPreview);
  trigger.updatedAt = nowIso();
  state.triggersBySessionKey[key] = trigger;
  await persistState();
}
