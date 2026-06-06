import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionTopic {
  id: string;
  profileId: string;
  cwd: string;
  name: string;
  icon: string;
  colorKey: string;
  createdAt: string;
  updatedAt: string;
  assignedSessionCount?: number;
}

interface CodexSessionTopicsState {
  topics: CodexSessionTopic[];
  assignments: Record<string, string>;
}

const TOPICS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-topics.json');
const ALLOWED_COLOR_KEYS = new Set([
  'rose',
  'orange',
  'amber',
  'emerald',
  'sky',
  'indigo',
  'violet',
  'slate',
]);

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexSessionTopicsState = {
  topics: [],
  assignments: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTopicCwd(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function topicBelongsToCwd(topicCwd: string, cwd: string): boolean {
  return normalizeTopicCwd(topicCwd) === normalizeTopicCwd(cwd);
}

function normalizeTopicIdentityName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildTopicIdentity(topic: Pick<CodexSessionTopic, 'profileId' | 'cwd' | 'name' | 'icon' | 'colorKey'>): string {
  return [
    topic.profileId,
    normalizeTopicCwd(topic.cwd),
    normalizeTopicIdentityName(topic.name),
    topic.icon.trim(),
    topic.colorKey.trim().toLowerCase(),
  ].join('::');
}

function cloneTopic(topic: CodexSessionTopic): CodexSessionTopic {
  return { ...topic };
}

function dedupeTopicState(currentState: CodexSessionTopicsState): CodexSessionTopicsState {
  const seen = new Map<string, CodexSessionTopic>();
  const reassignedTopicIds = new Map<string, string>();
  const dedupedTopics: CodexSessionTopic[] = [];

  for (const topic of currentState.topics) {
    const key = buildTopicIdentity(topic);
    const existing = seen.get(key);
    if (existing) {
      reassignedTopicIds.set(topic.id, existing.id);
      continue;
    }

    seen.set(key, topic);
    dedupedTopics.push(topic);
  }

  if (reassignedTopicIds.size === 0) {
    return currentState;
  }

  const dedupedAssignments = Object.fromEntries(
    Object.entries(currentState.assignments).map(([assignmentKey, topicId]) => [
      assignmentKey,
      reassignedTopicIds.get(topicId) || topicId,
    ])
  );

  return {
    topics: dedupedTopics,
    assignments: dedupedAssignments,
  };
}

function countAssignedSessions(profileId: string, topicId: string): number {
  const prefix = `${profileId}:`;
  let count = 0;
  for (const [assignmentKey, assignedTopicId] of Object.entries(state.assignments)) {
    if (!assignmentKey.startsWith(prefix)) {
      continue;
    }
    if (assignedTopicId === topicId) {
      count += 1;
    }
  }
  return count;
}

async function ensureStorageRoot() {
  await fs.mkdir(CODEX_APP_CONFIG.storageRoot, { recursive: true });
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await ensureStorageRoot();
    await fs.writeFile(TOPICS_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

async function loadState() {
  await ensureStorageRoot();

  try {
    const raw = await fs.readFile(TOPICS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CodexSessionTopicsState>;
    state = {
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      assignments: parsed.assignments && typeof parsed.assignments === 'object'
        ? parsed.assignments as Record<string, string>
        : {},
    };
    state = dedupeTopicState(state);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    state = {
      topics: [],
      assignments: {},
    };
  }
}

async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }

  await stateLoadedPromise;
}

function normalizeName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('Topic name is required');
  }

  return normalized.slice(0, 60);
}

function normalizeIcon(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Topic icon is required');
  }

  return [...normalized].slice(0, 2).join('');
}

function normalizeColorKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_COLOR_KEYS.has(normalized)) {
    throw new Error('Topic color is invalid');
  }

  return normalized;
}

export async function listSessionTopics(profileId: string, cwd: string): Promise<CodexSessionTopic[]> {
  await ensureStateLoaded();
  return state.topics
    .filter((topic) => topic.profileId === profileId && topicBelongsToCwd(topic.cwd, cwd))
    .sort((left, right) => left.name.localeCompare(right.name, 'he'))
    .map((topic) => ({
      ...cloneTopic(topic),
      assignedSessionCount: countAssignedSessions(profileId, topic.id),
    }));
}

export async function createSessionTopic(
  profileId: string,
  cwd: string,
  input: {
    name: string;
    icon: string;
    colorKey: string;
  }
): Promise<CodexSessionTopic> {
  await ensureStateLoaded();
  const normalizedName = normalizeName(input.name);
  const normalizedIcon = normalizeIcon(input.icon);
  const normalizedColorKey = normalizeColorKey(input.colorKey);

  const existingTopic = state.topics.find((candidate) => (
    candidate.profileId === profileId
    && topicBelongsToCwd(candidate.cwd, cwd)
    && normalizeTopicIdentityName(candidate.name) === normalizedName
    && candidate.icon.trim() === normalizedIcon
    && candidate.colorKey.trim().toLowerCase() === normalizedColorKey
  ));

  if (existingTopic) {
    return {
      ...cloneTopic(existingTopic),
      assignedSessionCount: countAssignedSessions(profileId, existingTopic.id),
    };
  }

  const topic: CodexSessionTopic = {
    id: randomUUID(),
    profileId,
    cwd: path.normalize(path.resolve(cwd)),
    name: normalizedName,
    icon: normalizedIcon,
    colorKey: normalizedColorKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  state.topics.push(topic);
  await persistState();
  return {
    ...cloneTopic(topic),
    assignedSessionCount: countAssignedSessions(profileId, topic.id),
  };
}

export async function setSessionTopic(
  profileId: string,
  sessionId: string,
  topicId: string | null,
  cwd?: string | null
): Promise<CodexSessionTopic | null> {
  await ensureStateLoaded();

  if (!topicId) {
    delete state.assignments[`${profileId}:${sessionId}`];
    await persistState();
    return null;
  }

  const topic = state.topics.find((candidate) => (
    candidate.id === topicId
    && candidate.profileId === profileId
  ));

  if (!topic) {
    throw new Error('Topic was not found');
  }

  if (cwd && !topicBelongsToCwd(topic.cwd, cwd)) {
    throw new Error('Topic does not belong to this folder');
  }

  state.assignments[`${profileId}:${sessionId}`] = topic.id;
  await persistState();
  return {
    ...cloneTopic(topic),
    assignedSessionCount: countAssignedSessions(profileId, topic.id),
  };
}

export async function getSessionTopicMap(profileId: string): Promise<Record<string, CodexSessionTopic>> {
  await ensureStateLoaded();
  const topicIndex = new Map(state.topics.map((topic) => [topic.id, topic]));
  const result: Record<string, CodexSessionTopic> = {};
  const prefix = `${profileId}:`;

  for (const [assignmentKey, topicId] of Object.entries(state.assignments)) {
    if (!assignmentKey.startsWith(prefix)) {
      continue;
    }

    const sessionId = assignmentKey.slice(prefix.length);
    if (!sessionId) {
      continue;
    }

    const topic = topicIndex.get(topicId);
    if (!topic) {
      continue;
    }

    result[sessionId] = cloneTopic(topic);
  }

  return result;
}

export async function listTopicAssignmentSessionIds(profileId: string, topicId: string): Promise<string[]> {
  await ensureStateLoaded();
  const prefix = `${profileId}:`;
  const sessionIds: string[] = [];

  for (const [assignmentKey, assignedTopicId] of Object.entries(state.assignments)) {
    if (!assignmentKey.startsWith(prefix) || assignedTopicId !== topicId) {
      continue;
    }

    const sessionId = assignmentKey.slice(prefix.length);
    if (sessionId) {
      sessionIds.push(sessionId);
    }
  }

  return sessionIds;
}

export async function deleteSessionTopic(
  profileId: string,
  topicId: string
): Promise<{ topic: CodexSessionTopic; affectedSessionIds: string[] }> {
  await ensureStateLoaded();

  const topicIndex = state.topics.findIndex((candidate) => (
    candidate.id === topicId
    && candidate.profileId === profileId
  ));

  if (topicIndex < 0) {
    throw new Error('Topic was not found');
  }

  const topic = state.topics[topicIndex]!;
  const affectedSessionIds = await listTopicAssignmentSessionIds(profileId, topicId);
  state.topics.splice(topicIndex, 1);

  for (const assignmentKey of Object.keys(state.assignments)) {
    if (state.assignments[assignmentKey] === topicId && assignmentKey.startsWith(`${profileId}:`)) {
      delete state.assignments[assignmentKey];
    }
  }

  await persistState();
  return {
    topic: cloneTopic(topic),
    affectedSessionIds,
  };
}

export async function deleteSessionTopicAssignment(profileId: string, sessionId: string): Promise<void> {
  await ensureStateLoaded();
  const assignmentKey = `${profileId}:${sessionId}`;
  if (!state.assignments[assignmentKey]) {
    return;
  }

  delete state.assignments[assignmentKey];
  await persistState();
}
