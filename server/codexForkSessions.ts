import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexForkTimelineEntry {
  id: string;
  entryType: 'message' | 'tool' | 'status';
  timestamp: string;
  role?: 'user' | 'assistant';
  kind?: 'prompt' | 'commentary' | 'final';
  text?: string;
  toolName?: string;
  title?: string;
  subtitle?: string | null;
  callId?: string | null;
  status?: string | null;
  exitCode?: number | null;
}

export interface CodexForkContext {
  sourceSessionId: string;
  sourceTitle: string;
  sourceCwd: string | null;
  forkEntryId: string;
  timeline: CodexForkTimelineEntry[];
}

export interface CodexForkSessionMetadata extends CodexForkContext {
  sessionId: string;
  profileId: string;
  promptPreview: string;
  createdAt: string;
}

export interface CodexForkDraftSession extends CodexForkContext {
  sessionId: string;
  profileId: string;
  promptPreview: string;
  promptPrefix: string;
  createdAt: string;
  updatedAt: string;
}

interface ForkSessionState {
  sessions: Record<string, CodexForkSessionMetadata>;
  drafts: Record<string, CodexForkDraftSession>;
}

const FORK_STATE_FILE = path.join(CODEX_APP_CONFIG.queueRoot, 'fork-sessions.json');

let loadPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: ForkSessionState = {
  sessions: {},
  drafts: {},
};

function cloneForkMetadata(metadata: CodexForkSessionMetadata): CodexForkSessionMetadata {
  return {
    ...metadata,
    timeline: metadata.timeline.map((entry) => ({ ...entry })),
  };
}

function cloneForkDraftSession(session: CodexForkDraftSession): CodexForkDraftSession {
  return {
    ...session,
    timeline: session.timeline.map((entry) => ({ ...entry })),
  };
}

function sanitizeForkTimelineEntry(value: any): CodexForkTimelineEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.id !== 'string' || typeof value.timestamp !== 'string') {
    return null;
  }

  if (value.entryType !== 'message' && value.entryType !== 'tool' && value.entryType !== 'status') {
    return null;
  }

  return {
    id: value.id,
    entryType: value.entryType,
    timestamp: value.timestamp,
    role: value.role === 'user' || value.role === 'assistant' ? value.role : undefined,
    kind: value.kind === 'prompt' || value.kind === 'commentary' || value.kind === 'final' ? value.kind : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
    toolName: typeof value.toolName === 'string' ? value.toolName : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    subtitle: typeof value.subtitle === 'string' ? value.subtitle : value.subtitle === null ? null : undefined,
    callId: typeof value.callId === 'string' ? value.callId : value.callId === null ? null : undefined,
    status: typeof value.status === 'string' ? value.status : value.status === null ? null : undefined,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : value.exitCode === null ? null : undefined,
  };
}

function sanitizeForkMetadata(value: any): CodexForkSessionMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (
    typeof value.sessionId !== 'string'
    || typeof value.profileId !== 'string'
    || typeof value.sourceSessionId !== 'string'
    || typeof value.sourceTitle !== 'string'
    || typeof value.forkEntryId !== 'string'
    || typeof value.promptPreview !== 'string'
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.timeline)
  ) {
    return null;
  }

  const timeline = value.timeline
    .map((entry: any) => sanitizeForkTimelineEntry(entry))
    .filter((entry: CodexForkTimelineEntry | null): entry is CodexForkTimelineEntry => Boolean(entry));

  return {
    sessionId: value.sessionId,
    profileId: value.profileId,
    sourceSessionId: value.sourceSessionId,
    sourceTitle: value.sourceTitle,
    sourceCwd: typeof value.sourceCwd === 'string' && value.sourceCwd.trim() ? value.sourceCwd.trim() : null,
    forkEntryId: value.forkEntryId,
    promptPreview: value.promptPreview.trim(),
    createdAt: value.createdAt,
    timeline,
  };
}

function sanitizeForkDraftSession(value: any): CodexForkDraftSession | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (
    typeof value.sessionId !== 'string'
    || typeof value.profileId !== 'string'
    || typeof value.sourceSessionId !== 'string'
    || typeof value.sourceTitle !== 'string'
    || typeof value.forkEntryId !== 'string'
    || typeof value.promptPreview !== 'string'
    || typeof value.promptPrefix !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.timeline)
  ) {
    return null;
  }

  const timeline = value.timeline
    .map((entry: any) => sanitizeForkTimelineEntry(entry))
    .filter((entry: CodexForkTimelineEntry | null): entry is CodexForkTimelineEntry => Boolean(entry));

  return {
    sessionId: value.sessionId,
    profileId: value.profileId,
    sourceSessionId: value.sourceSessionId,
    sourceTitle: value.sourceTitle,
    sourceCwd: typeof value.sourceCwd === 'string' && value.sourceCwd.trim() ? value.sourceCwd.trim() : null,
    forkEntryId: value.forkEntryId,
    promptPreview: value.promptPreview.trim(),
    promptPrefix: value.promptPrefix.trim(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    timeline,
  };
}

async function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = (async () => {
      await fs.mkdir(path.dirname(FORK_STATE_FILE), { recursive: true });

      try {
        const raw = await fs.readFile(FORK_STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<ForkSessionState>;
        const sessions = parsed.sessions && typeof parsed.sessions === 'object'
          ? Object.values(parsed.sessions)
            .map((entry) => sanitizeForkMetadata(entry))
            .filter((entry): entry is CodexForkSessionMetadata => Boolean(entry))
          : [];
        const drafts = parsed.drafts && typeof parsed.drafts === 'object'
          ? Object.values(parsed.drafts)
            .map((entry) => sanitizeForkDraftSession(entry))
            .filter((entry): entry is CodexForkDraftSession => Boolean(entry))
          : [];

        state = {
          sessions: Object.fromEntries(sessions.map((entry) => [entry.sessionId, entry])),
          drafts: Object.fromEntries(drafts.map((entry) => [entry.sessionId, entry])),
        };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }

        state = {
          sessions: {},
          drafts: {},
        };
      }
    })();
  }

  await loadPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(FORK_STATE_FILE), { recursive: true });
    await fs.writeFile(FORK_STATE_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

export async function recordForkSessionMetadata(metadata: CodexForkSessionMetadata) {
  await ensureLoaded();
  state.sessions[metadata.sessionId] = cloneForkMetadata(metadata);
  await persistState();
}

export async function getForkSessionMetadata(sessionId: string): Promise<CodexForkSessionMetadata | null> {
  await ensureLoaded();
  const metadata = state.sessions[sessionId];
  return metadata ? cloneForkMetadata(metadata) : null;
}

export function isForkDraftSessionId(sessionId: string): boolean {
  return sessionId.startsWith('draft:');
}

export async function createForkDraftSession(
  draft: Omit<CodexForkDraftSession, 'sessionId' | 'createdAt' | 'updatedAt'> & {
    sessionId?: string;
  }
): Promise<CodexForkDraftSession> {
  await ensureLoaded();
  const timestamp = new Date().toISOString();
  const sessionId = draft.sessionId?.trim() || `draft:${randomUUID()}`;
  const nextDraft: CodexForkDraftSession = {
    ...draft,
    sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    timeline: draft.timeline.map((entry) => ({ ...entry })),
  };
  state.drafts[nextDraft.sessionId] = cloneForkDraftSession(nextDraft);
  await persistState();
  return nextDraft;
}

export async function getForkDraftSession(sessionId: string): Promise<CodexForkDraftSession | null> {
  await ensureLoaded();
  const draft = state.drafts[sessionId];
  return draft ? cloneForkDraftSession(draft) : null;
}

export async function listForkDraftSessions(profileId?: string): Promise<CodexForkDraftSession[]> {
  await ensureLoaded();
  return Object.values(state.drafts)
    .filter((draft) => !profileId || draft.profileId === profileId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((draft) => cloneForkDraftSession(draft));
}

export async function deleteForkDraftSession(sessionId: string): Promise<void> {
  await ensureLoaded();
  if (!state.drafts[sessionId]) {
    return;
  }

  delete state.drafts[sessionId];
  await persistState();
}
