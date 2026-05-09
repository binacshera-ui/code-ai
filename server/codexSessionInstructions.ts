import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

interface SessionInstructionsState {
  instructionsByKey: Record<string, string>;
}

const INSTRUCTIONS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-instructions.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionInstructionsState = {
  instructionsByKey: {},
};

function buildInstructionKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

function normalizeInstruction(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(INSTRUCTIONS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      state = {
        instructionsByKey: parsed.instructionsByKey && typeof parsed.instructionsByKey === 'object'
          ? parsed.instructionsByKey as Record<string, string>
          : {},
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        instructionsByKey: {},
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(INSTRUCTIONS_FILE), { recursive: true });
    await fs.writeFile(INSTRUCTIONS_FILE, JSON.stringify(state, null, 2), 'utf-8');
  });

  await persistTail;
}

export async function getSessionInstruction(profileId: string, sessionKey: string): Promise<string | null> {
  await ensureStateLoaded();
  const instruction = state.instructionsByKey[buildInstructionKey(profileId, sessionKey)];
  return instruction || null;
}

export async function setSessionInstruction(
  profileId: string,
  sessionKey: string,
  instruction: string | null
): Promise<string | null> {
  await ensureStateLoaded();
  const key = buildInstructionKey(profileId, sessionKey);
  const normalized = typeof instruction === 'string' ? normalizeInstruction(instruction) : '';

  if (!normalized) {
    delete state.instructionsByKey[key];
    await persistState();
    return null;
  }

  state.instructionsByKey[key] = normalized;
  await persistState();
  return normalized;
}

export async function rebindSessionInstruction(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return;
  }

  const fromKey = buildInstructionKey(profileId, fromSessionKey);
  const toKey = buildInstructionKey(profileId, toSessionKey);
  const value = state.instructionsByKey[fromKey];

  if (!value) {
    return;
  }

  state.instructionsByKey[toKey] = value;
  delete state.instructionsByKey[fromKey];
  await persistState();
}
