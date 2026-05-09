import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

interface CodexSessionTitlesState {
  titles: Record<string, string>;
}

const SESSION_TITLES_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-titles.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexSessionTitlesState = {
  titles: {},
};

async function ensureStorageRoot() {
  await fs.mkdir(CODEX_APP_CONFIG.storageRoot, { recursive: true });
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await ensureStorageRoot();
    await fs.writeFile(SESSION_TITLES_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

async function loadState() {
  await ensureStorageRoot();

  try {
    const raw = await fs.readFile(SESSION_TITLES_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CodexSessionTitlesState>;
    state = {
      titles: parsed.titles && typeof parsed.titles === 'object'
        ? parsed.titles as Record<string, string>
        : {},
    };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    state = {
      titles: {},
    };
  }
}

async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }

  await stateLoadedPromise;
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 120);
}

function makeSessionKey(profileId: string, sessionId: string): string {
  return `${profileId}:${sessionId}`;
}

export async function setSessionCustomTitle(
  profileId: string,
  sessionId: string,
  title: string | null
): Promise<string | null> {
  await ensureStateLoaded();

  if (title === null) {
    delete state.titles[makeSessionKey(profileId, sessionId)];
    await persistState();
    return null;
  }

  const normalized = normalizeTitle(title);
  if (!normalized) {
    delete state.titles[makeSessionKey(profileId, sessionId)];
    await persistState();
    return null;
  }

  state.titles[makeSessionKey(profileId, sessionId)] = normalized;
  await persistState();
  return normalized;
}

export async function getSessionTitleMap(profileId: string): Promise<Record<string, string>> {
  await ensureStateLoaded();

  const result: Record<string, string> = {};
  const prefix = `${profileId}:`;

  for (const [key, title] of Object.entries(state.titles)) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    const sessionId = key.slice(prefix.length);
    if (!sessionId || !title) {
      continue;
    }

    result[sessionId] = title;
  }

  return result;
}
