import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

interface SessionVisibilityState {
  hiddenByProfile: Record<string, string[]>;
}

const VISIBILITY_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-visibility.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionVisibilityState = {
  hiddenByProfile: {},
};

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(VISIBILITY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      state = {
        hiddenByProfile: parsed.hiddenByProfile && typeof parsed.hiddenByProfile === 'object'
          ? parsed.hiddenByProfile as Record<string, string[]>
          : {},
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      state = { hiddenByProfile: {} };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(VISIBILITY_FILE), { recursive: true });
    await fs.writeFile(VISIBILITY_FILE, JSON.stringify(state, null, 2), 'utf-8');
  });

  await persistTail;
}

export async function listHiddenSessionIds(profileId: string): Promise<Set<string>> {
  await ensureStateLoaded();
  return new Set(state.hiddenByProfile[profileId] || []);
}

export async function setSessionHidden(
  profileId: string,
  sessionId: string,
  hidden: boolean
): Promise<boolean> {
  await ensureStateLoaded();

  const next = new Set(state.hiddenByProfile[profileId] || []);
  if (hidden) {
    next.add(sessionId);
  } else {
    next.delete(sessionId);
  }

  state.hiddenByProfile[profileId] = [...next];
  await persistState();
  return hidden;
}
