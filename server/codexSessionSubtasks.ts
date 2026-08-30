import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionSubtask {
  id: string;
  profileId: string;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface SessionSubtasksState {
  subtasks: CodexSessionSubtask[];
}

const SUBTASKS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-subtasks.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionSubtasksState = {
  subtasks: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('Session task title is required');
  }

  return normalized.slice(0, 240);
}

function normalizeSubtask(value: unknown): CodexSessionSubtask | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const subtask = value as Partial<CodexSessionSubtask>;
  if (
    typeof subtask.id !== 'string'
    || typeof subtask.profileId !== 'string'
    || typeof subtask.sessionId !== 'string'
    || typeof subtask.title !== 'string'
    || typeof subtask.createdAt !== 'string'
    || typeof subtask.updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: subtask.id,
    profileId: subtask.profileId,
    sessionId: subtask.sessionId,
    title: subtask.title,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
    completedAt: typeof subtask.completedAt === 'string' && subtask.completedAt.trim()
      ? subtask.completedAt
      : null,
  };
}

function cloneSubtask(subtask: CodexSessionSubtask): CodexSessionSubtask {
  return { ...subtask };
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(SUBTASKS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SessionSubtasksState>;
      state = {
        subtasks: Array.isArray(parsed.subtasks)
          ? parsed.subtasks
            .map((subtask) => normalizeSubtask(subtask))
            .filter((subtask): subtask is CodexSessionSubtask => Boolean(subtask))
          : [],
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        subtasks: [],
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(SUBTASKS_FILE), { recursive: true });
    await fs.writeFile(SUBTASKS_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

function sortSubtasks(subtasks: CodexSessionSubtask[]): CodexSessionSubtask[] {
  return subtasks.slice().sort((left, right) => {
    const leftCompleted = Boolean(left.completedAt);
    const rightCompleted = Boolean(right.completedAt);
    if (leftCompleted !== rightCompleted) {
      return leftCompleted ? 1 : -1;
    }

    return right.createdAt.localeCompare(left.createdAt);
  });
}

function findSubtask(profileId: string, subtaskId: string): CodexSessionSubtask {
  const subtask = state.subtasks.find((candidate) => candidate.profileId === profileId && candidate.id === subtaskId);
  if (!subtask) {
    throw new Error('Session task was not found');
  }

  return subtask;
}

export async function listSessionSubtasks(profileId: string, sessionId?: string): Promise<CodexSessionSubtask[]> {
  await ensureStateLoaded();
  return sortSubtasks(state.subtasks.filter((subtask) => (
    subtask.profileId === profileId
    && (!sessionId || subtask.sessionId === sessionId)
  ))).map(cloneSubtask);
}

export async function createSessionSubtask(
  profileId: string,
  sessionId: string,
  title: string
): Promise<CodexSessionSubtask> {
  await ensureStateLoaded();

  const subtask: CodexSessionSubtask = {
    id: randomUUID(),
    profileId,
    sessionId,
    title: normalizeTitle(title),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
  };

  state.subtasks.push(subtask);
  await persistState();
  return cloneSubtask(subtask);
}

export async function setSessionSubtaskCompletion(
  profileId: string,
  subtaskId: string,
  completed: boolean
): Promise<CodexSessionSubtask> {
  await ensureStateLoaded();

  const subtask = findSubtask(profileId, subtaskId);
  subtask.completedAt = completed ? nowIso() : null;
  subtask.updatedAt = nowIso();
  await persistState();
  return cloneSubtask(subtask);
}

export async function deleteSessionSubtask(profileId: string, subtaskId: string): Promise<void> {
  await ensureStateLoaded();
  const nextSubtasks = state.subtasks.filter((subtask) => !(subtask.profileId === profileId && subtask.id === subtaskId));
  if (nextSubtasks.length === state.subtasks.length) {
    throw new Error('Session task was not found');
  }

  state.subtasks = nextSubtasks;
  await persistState();
}

export async function removeSessionSubtasks(profileId: string, sessionId: string): Promise<void> {
  await ensureStateLoaded();
  const nextSubtasks = state.subtasks.filter((subtask) => !(subtask.profileId === profileId && subtask.sessionId === sessionId));
  if (nextSubtasks.length === state.subtasks.length) {
    return;
  }

  state.subtasks = nextSubtasks;
  await persistState();
}
