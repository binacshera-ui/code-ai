import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

interface SessionInstructionsState {
  instructionsByKey: Record<string, string | SessionInstructionRecord>;
}

export interface SessionInstructionRecord {
  instruction: string;
  enabled: boolean;
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

function normalizeSessionInstructionRecord(
  value: unknown
): SessionInstructionRecord | null {
  if (typeof value === 'string') {
    const normalizedInstruction = normalizeInstruction(value);
    if (!normalizedInstruction) {
      return null;
    }

    return {
      instruction: normalizedInstruction,
      enabled: true,
    };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const rawInstruction = typeof (value as any).instruction === 'string'
    ? (value as any).instruction
    : '';
  const normalizedInstruction = normalizeInstruction(rawInstruction);
  if (!normalizedInstruction) {
    return null;
  }

  return {
    instruction: normalizedInstruction,
    enabled: typeof (value as any).enabled === 'boolean'
      ? (value as any).enabled
      : true,
  };
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(INSTRUCTIONS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const nextInstructionsByKey: Record<string, SessionInstructionRecord> = {};
      const parsedInstructionsByKey = parsed.instructionsByKey && typeof parsed.instructionsByKey === 'object'
        ? parsed.instructionsByKey as Record<string, unknown>
        : {};

      for (const [key, value] of Object.entries(parsedInstructionsByKey)) {
        const normalizedRecord = normalizeSessionInstructionRecord(value);
        if (normalizedRecord) {
          nextInstructionsByKey[key] = normalizedRecord;
        }
      }

      state = {
        instructionsByKey: nextInstructionsByKey,
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
  const record = await getSessionInstructionRecord(profileId, sessionKey);
  if (!record.instruction || !record.enabled) {
    return null;
  }

  return record.instruction;
}

export async function getSessionInstructionRecord(
  profileId: string,
  sessionKey: string
): Promise<{ instruction: string | null; enabled: boolean }> {
  await ensureStateLoaded();
  const record = normalizeSessionInstructionRecord(
    state.instructionsByKey[buildInstructionKey(profileId, sessionKey)]
  );

  return {
    instruction: record?.instruction || null,
    enabled: record?.enabled ?? true,
  };
}

export async function setSessionInstruction(
  profileId: string,
  sessionKey: string,
  instruction: string | null,
  enabled = true
): Promise<SessionInstructionRecord | null> {
  await ensureStateLoaded();
  const key = buildInstructionKey(profileId, sessionKey);
  const normalized = typeof instruction === 'string' ? normalizeInstruction(instruction) : '';

  if (!normalized) {
    delete state.instructionsByKey[key];
    await persistState();
    return null;
  }

  const nextRecord: SessionInstructionRecord = {
    instruction: normalized,
    enabled,
  };
  state.instructionsByKey[key] = nextRecord;
  await persistState();
  return nextRecord;
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
  const value = normalizeSessionInstructionRecord(state.instructionsByKey[fromKey]);

  if (!value) {
    return;
  }

  state.instructionsByKey[toKey] = value;
  delete state.instructionsByKey[fromKey];
  await persistState();
}

export async function deleteSessionInstruction(
  profileId: string,
  sessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  const key = buildInstructionKey(profileId, sessionKey);
  if (!state.instructionsByKey[key]) {
    return;
  }

  delete state.instructionsByKey[key];
  await persistState();
}
