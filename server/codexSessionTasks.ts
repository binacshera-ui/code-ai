import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionTaskAssignment {
  sessionId: string;
  addedAt: string;
  completedAt: string | null;
}

export interface CodexSessionTask {
  id: string;
  profileId: string;
  title: string;
  description: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  sessions: CodexSessionTaskAssignment[];
}

interface SessionTasksState {
  tasks: CodexSessionTask[];
}

const TASKS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-tasks.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionTasksState = {
  tasks: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string, fieldLabel: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error(`${fieldLabel} is required`);
  }

  return normalized.slice(0, limit);
}

function normalizeDescription(value: string): string {
  return value.replace(/\r\n/g, '\n').trim().slice(0, 4000);
}

function normalizeDueAt(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Task due date is invalid');
  }

  return new Date(timestamp).toISOString();
}

function normalizeAssignment(value: unknown): CodexSessionTaskAssignment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const assignment = value as Partial<CodexSessionTaskAssignment>;
  if (
    typeof assignment.sessionId !== 'string'
    || typeof assignment.addedAt !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: assignment.sessionId,
    addedAt: assignment.addedAt,
    completedAt: typeof assignment.completedAt === 'string' && assignment.completedAt.trim()
      ? assignment.completedAt
      : null,
  };
}

function normalizeTask(value: unknown): CodexSessionTask | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const task = value as Partial<CodexSessionTask>;
  if (
    typeof task.id !== 'string'
    || typeof task.profileId !== 'string'
    || typeof task.title !== 'string'
    || typeof task.description !== 'string'
    || typeof task.createdAt !== 'string'
    || typeof task.updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: task.id,
    profileId: task.profileId,
    title: task.title,
    description: task.description,
    dueAt: typeof task.dueAt === 'string' && task.dueAt.trim() ? task.dueAt : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    sessions: Array.isArray(task.sessions)
      ? task.sessions
        .map((assignment) => normalizeAssignment(assignment))
        .filter((assignment): assignment is CodexSessionTaskAssignment => Boolean(assignment))
      : [],
  };
}

function cloneTask(task: CodexSessionTask): CodexSessionTask {
  return {
    ...task,
    sessions: task.sessions.map((assignment) => ({ ...assignment })),
  };
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(TASKS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SessionTasksState>;
      state = {
        tasks: Array.isArray(parsed.tasks)
          ? parsed.tasks
            .map((task) => normalizeTask(task))
            .filter((task): task is CodexSessionTask => Boolean(task))
          : [],
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        tasks: [],
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true });
    await fs.writeFile(TASKS_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

function sortAssignments(assignments: CodexSessionTaskAssignment[]): CodexSessionTaskAssignment[] {
  return assignments.slice().sort((left, right) => {
    const leftCompleted = Boolean(left.completedAt);
    const rightCompleted = Boolean(right.completedAt);
    if (leftCompleted !== rightCompleted) {
      return leftCompleted ? 1 : -1;
    }

    return right.addedAt.localeCompare(left.addedAt);
  });
}

function sortTasks(tasks: CodexSessionTask[]): CodexSessionTask[] {
  return tasks.slice().sort((left, right) => {
    if (left.dueAt && right.dueAt) {
      const dueSort = left.dueAt.localeCompare(right.dueAt);
      if (dueSort !== 0) {
        return dueSort;
      }
    } else if (left.dueAt) {
      return -1;
    } else if (right.dueAt) {
      return 1;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function findTask(profileId: string, taskId: string): CodexSessionTask {
  const task = state.tasks.find((candidate) => candidate.id === taskId && candidate.profileId === profileId);
  if (!task) {
    throw new Error('Task was not found');
  }

  return task;
}

export async function listSessionTasks(profileId: string): Promise<CodexSessionTask[]> {
  await ensureStateLoaded();
  return sortTasks(state.tasks.filter((task) => task.profileId === profileId)).map(cloneTask);
}

export async function createSessionTask(
  profileId: string,
  input: {
    title: string;
    description?: string;
    dueAt?: string | null;
  }
): Promise<CodexSessionTask> {
  await ensureStateLoaded();

  const task: CodexSessionTask = {
    id: randomUUID(),
    profileId,
    title: normalizeText(input.title, 'Task title', 140),
    description: normalizeDescription(input.description || ''),
    dueAt: normalizeDueAt(input.dueAt),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sessions: [],
  };

  state.tasks.push(task);
  await persistState();
  return cloneTask(task);
}

export async function updateSessionTask(
  profileId: string,
  taskId: string,
  input: {
    title?: string;
    description?: string;
    dueAt?: string | null;
  }
): Promise<CodexSessionTask> {
  await ensureStateLoaded();

  const task = findTask(profileId, taskId);
  if (typeof input.title === 'string') {
    task.title = normalizeText(input.title, 'Task title', 140);
  }
  if (typeof input.description === 'string') {
    task.description = normalizeDescription(input.description);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'dueAt')) {
    task.dueAt = normalizeDueAt(input.dueAt);
  }
  task.updatedAt = nowIso();

  await persistState();
  return cloneTask(task);
}

export async function deleteSessionTask(profileId: string, taskId: string): Promise<void> {
  await ensureStateLoaded();

  const nextTasks = state.tasks.filter((task) => !(task.id === taskId && task.profileId === profileId));
  if (nextTasks.length === state.tasks.length) {
    return;
  }

  state.tasks = nextTasks;
  await persistState();
}

export async function setTaskSessionAssignment(
  profileId: string,
  taskId: string,
  sessionId: string,
  assigned: boolean
): Promise<CodexSessionTask> {
  await ensureStateLoaded();

  const task = findTask(profileId, taskId);
  const existingIndex = task.sessions.findIndex((assignment) => assignment.sessionId === sessionId);

  if (assigned) {
    if (existingIndex === -1) {
      task.sessions.unshift({
        sessionId,
        addedAt: nowIso(),
        completedAt: null,
      });
    }
  } else if (existingIndex !== -1) {
    task.sessions.splice(existingIndex, 1);
  }

  task.sessions = sortAssignments(task.sessions);
  task.updatedAt = nowIso();
  await persistState();
  return cloneTask(task);
}

export async function setTaskSessionCompletion(
  profileId: string,
  taskId: string,
  sessionId: string,
  completed: boolean
): Promise<CodexSessionTask> {
  await ensureStateLoaded();

  const task = findTask(profileId, taskId);
  const assignment = task.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!assignment) {
    throw new Error('Task session assignment was not found');
  }

  assignment.completedAt = completed ? nowIso() : null;
  task.sessions = sortAssignments(task.sessions);
  task.updatedAt = nowIso();
  await persistState();
  return cloneTask(task);
}

export async function removeSessionFromTasks(profileId: string, sessionId: string): Promise<void> {
  await ensureStateLoaded();

  let changed = false;
  state.tasks = state.tasks.map((task) => {
    if (task.profileId !== profileId) {
      return task;
    }

    const nextAssignments = task.sessions.filter((assignment) => assignment.sessionId !== sessionId);
    if (nextAssignments.length === task.sessions.length) {
      return task;
    }

    changed = true;
    return {
      ...task,
      updatedAt: nowIso(),
      sessions: sortAssignments(nextAssignments),
    };
  });

  if (!changed) {
    return;
  }

  await persistState();
}
