import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionWorkspaceOverride {
  profileId: string;
  sessionId: string;
  cwd: string;
  updatedAt: string;
}

interface CodexSessionWorkspaceState {
  assignments: Record<string, CodexSessionWorkspaceOverride>;
}

const WORKSPACES_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-workspaces.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexSessionWorkspaceState = {
  assignments: {},
};

function assignmentKey(profileId: string, sessionId: string): string {
  return `${profileId}:${sessionId}`;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

async function ensureStorageRoot(): Promise<void> {
  await fs.mkdir(CODEX_APP_CONFIG.storageRoot, { recursive: true });
}

async function persistState(): Promise<void> {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await ensureStorageRoot();
    const temporaryPath = `${WORKSPACES_FILE}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(temporaryPath, snapshot, 'utf8');
    await fs.rename(temporaryPath, WORKSPACES_FILE);
  });
  await persistTail;
}

async function loadState(): Promise<void> {
  await ensureStorageRoot();
  try {
    const raw = await fs.readFile(WORKSPACES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CodexSessionWorkspaceState>;
    state = {
      assignments: parsed.assignments && typeof parsed.assignments === 'object'
        ? parsed.assignments as Record<string, CodexSessionWorkspaceOverride>
        : {},
    };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    state = { assignments: {} };
  }
}

async function ensureStateLoaded(): Promise<void> {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }
  await stateLoadedPromise;
}

export function buildWorkspaceMovePrompt(cwd: string): string {
  const normalizedCwd = normalizeRequired(cwd, 'Workspace path');
  return [
    'שים לב: עברנו למקור תיקייה פעילה חדשה.',
    `הנתיב הפעיל הוא: ${normalizedCwd}`,
    'מעתה יש להתייחס לתיקייה זו כ-workspace הפעיל של השיחה, אלא אם המשתמש יבקש אחרת.',
  ].join('\n');
}

export async function getSessionWorkspaceOverride(
  profileId: string,
  sessionId: string,
): Promise<CodexSessionWorkspaceOverride | null> {
  await ensureStateLoaded();
  const record = state.assignments[assignmentKey(profileId, sessionId)];
  return record ? { ...record } : null;
}

export async function getSessionWorkspaceMap(
  profileId: string,
): Promise<Record<string, CodexSessionWorkspaceOverride>> {
  await ensureStateLoaded();
  const prefix = `${profileId}:`;
  const result: Record<string, CodexSessionWorkspaceOverride> = {};
  for (const [key, record] of Object.entries(state.assignments)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    result[record.sessionId] = { ...record };
  }
  return result;
}

export async function setSessionWorkspaceOverride(
  profileId: string,
  sessionId: string,
  cwd: string,
): Promise<CodexSessionWorkspaceOverride> {
  await ensureStateLoaded();
  const normalizedProfileId = normalizeRequired(profileId, 'Profile id');
  const normalizedSessionId = normalizeRequired(sessionId, 'Session id');
  const normalizedCwd = normalizeRequired(cwd, 'Workspace path');
  const record: CodexSessionWorkspaceOverride = {
    profileId: normalizedProfileId,
    sessionId: normalizedSessionId,
    cwd: normalizedCwd,
    updatedAt: new Date().toISOString(),
  };
  state.assignments[assignmentKey(normalizedProfileId, normalizedSessionId)] = record;
  await persistState();
  return { ...record };
}

export async function setSessionWorkspaceOverrides(
  profileId: string,
  sessionIds: string[],
  cwd: string,
): Promise<CodexSessionWorkspaceOverride[]> {
  await ensureStateLoaded();
  const normalizedProfileId = normalizeRequired(profileId, 'Profile id');
  const normalizedCwd = normalizeRequired(cwd, 'Workspace path');
  const updatedAt = new Date().toISOString();
  const records = [...new Set(sessionIds.map((sessionId) => normalizeRequired(sessionId, 'Session id')))]
    .map((sessionId): CodexSessionWorkspaceOverride => ({
      profileId: normalizedProfileId,
      sessionId,
      cwd: normalizedCwd,
      updatedAt,
    }));

  for (const record of records) {
    state.assignments[assignmentKey(normalizedProfileId, record.sessionId)] = record;
  }
  if (records.length > 0) {
    await persistState();
  }
  return records.map((record) => ({ ...record }));
}

export async function deleteSessionWorkspaceOverride(
  profileId: string,
  sessionId: string,
): Promise<void> {
  await ensureStateLoaded();
  const key = assignmentKey(profileId, sessionId);
  if (!state.assignments[key]) {
    return;
  }
  delete state.assignments[key];
  await persistState();
}

export async function rebindSessionWorkspaceOverride(
  profileId: string,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<CodexSessionWorkspaceOverride | null> {
  const source = await getSessionWorkspaceOverride(profileId, sourceSessionId);
  if (!source || sourceSessionId === targetSessionId) {
    return source;
  }
  return setSessionWorkspaceOverride(profileId, targetSessionId, source.cwd);
}
