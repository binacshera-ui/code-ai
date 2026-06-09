import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionContextSelection {
  anchorIds: string[];
  skillIds: string[];
  reminderIds: string[];
  agentSessionDraftId: string | null;
  professionalMode: boolean;
  actionRestriction: CodexSessionActionRestriction | null;
}

export interface CodexSessionActionRestriction {
  enabled: boolean;
  targetPath: string;
  targetKind: 'file' | 'directory';
}

interface SessionContextSelectionsState {
  selectionsByKey: Record<string, CodexSessionContextSelection>;
}

const SELECTIONS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-context-selections.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionContextSelectionsState = {
  selectionsByKey: {},
};

function buildSelectionKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }

  return [...deduped];
}

function cloneSelection(selection: CodexSessionContextSelection): CodexSessionContextSelection {
  return {
    anchorIds: [...selection.anchorIds],
    skillIds: [...selection.skillIds],
    reminderIds: [...selection.reminderIds],
    agentSessionDraftId: selection.agentSessionDraftId || null,
    professionalMode: selection.professionalMode === true,
    actionRestriction: selection.actionRestriction
      ? {
        enabled: selection.actionRestriction.enabled === true,
        targetPath: selection.actionRestriction.targetPath,
        targetKind: selection.actionRestriction.targetKind,
      }
      : null,
  };
}

function normalizeActionRestriction(value: unknown): CodexSessionActionRestriction | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const targetPath = typeof (value as any).targetPath === 'string'
    ? (value as any).targetPath.trim()
    : '';
  const targetKind = (value as any).targetKind === 'file' || (value as any).targetKind === 'directory'
    ? (value as any).targetKind
    : null;

  if (!targetPath || !targetKind) {
    return null;
  }

  return {
    enabled: typeof (value as any).enabled === 'boolean'
      ? (value as any).enabled
      : true,
    targetPath,
    targetKind,
  };
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(SELECTIONS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SessionContextSelectionsState>;
      const selectionsByKey = parsed.selectionsByKey && typeof parsed.selectionsByKey === 'object'
        ? Object.fromEntries(
          Object.entries(parsed.selectionsByKey)
            .filter(([key]) => Boolean(key))
            .map(([key, value]) => {
              const selection = value as Partial<CodexSessionContextSelection> | null | undefined;
	              return [
	                key,
	                {
	                  anchorIds: normalizeIdList(selection?.anchorIds),
	                  skillIds: normalizeIdList(selection?.skillIds),
	                  reminderIds: normalizeIdList(selection?.reminderIds),
	                  agentSessionDraftId: typeof selection?.agentSessionDraftId === 'string' && selection.agentSessionDraftId.trim()
	                    ? selection.agentSessionDraftId.trim()
	                    : null,
	                  professionalMode: selection?.professionalMode === true,
	                  actionRestriction: normalizeActionRestriction(selection?.actionRestriction),
	                },
	              ];
            })
        )
        : {};
      state = {
        selectionsByKey,
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        selectionsByKey: {},
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(SELECTIONS_FILE), { recursive: true });
    await fs.writeFile(SELECTIONS_FILE, snapshot, 'utf-8');
  });

  await persistTail;
}

export async function getSessionContextSelection(
  profileId: string,
  sessionKey: string
): Promise<CodexSessionContextSelection> {
  await ensureStateLoaded();
  const selection = state.selectionsByKey[buildSelectionKey(profileId, sessionKey)];
  return selection
    ? cloneSelection(selection)
    : {
      anchorIds: [],
      skillIds: [],
      reminderIds: [],
      agentSessionDraftId: null,
      professionalMode: false,
      actionRestriction: null,
    };
}

export async function setSessionContextSelection(
  profileId: string,
  sessionKey: string,
  selection: Partial<CodexSessionContextSelection> | null
): Promise<CodexSessionContextSelection> {
  await ensureStateLoaded();
  const key = buildSelectionKey(profileId, sessionKey);
  const normalized: CodexSessionContextSelection = {
    anchorIds: normalizeIdList(selection?.anchorIds),
    skillIds: normalizeIdList(selection?.skillIds),
    reminderIds: normalizeIdList(selection?.reminderIds),
    agentSessionDraftId: typeof selection?.agentSessionDraftId === 'string' && selection.agentSessionDraftId.trim()
      ? selection.agentSessionDraftId.trim()
      : null,
    professionalMode: selection?.professionalMode === true,
    actionRestriction: normalizeActionRestriction(selection?.actionRestriction),
  };

  if (
    normalized.anchorIds.length === 0
    && normalized.skillIds.length === 0
    && normalized.reminderIds.length === 0
    && !normalized.agentSessionDraftId
    && !normalized.professionalMode
    && !normalized.actionRestriction
  ) {
    delete state.selectionsByKey[key];
    await persistState();
    return {
      anchorIds: [],
      skillIds: [],
      reminderIds: [],
      agentSessionDraftId: null,
      professionalMode: false,
      actionRestriction: null,
    };
  }

  state.selectionsByKey[key] = normalized;
  await persistState();
  return cloneSelection(normalized);
}

export async function rebindSessionContextSelection(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return;
  }

  const fromKey = buildSelectionKey(profileId, fromSessionKey);
  const toKey = buildSelectionKey(profileId, toSessionKey);
  const value = state.selectionsByKey[fromKey];

  if (!value) {
    return;
  }

  state.selectionsByKey[toKey] = cloneSelection(value);
  delete state.selectionsByKey[fromKey];
  await persistState();
}

export async function deleteSessionContextSelection(
  profileId: string,
  sessionKey: string
): Promise<void> {
  await ensureStateLoaded();
  const key = buildSelectionKey(profileId, sessionKey);
  if (!state.selectionsByKey[key]) {
    return;
  }

  const current = state.selectionsByKey[key];
  if (current?.actionRestriction) {
    state.selectionsByKey[key] = {
      anchorIds: [],
      skillIds: [],
      reminderIds: [],
      agentSessionDraftId: null,
      professionalMode: false,
      actionRestriction: {
        enabled: current.actionRestriction.enabled === true,
        targetPath: current.actionRestriction.targetPath,
        targetKind: current.actionRestriction.targetKind,
      },
    };
  } else {
    delete state.selectionsByKey[key];
  }
  await persistState();
}

export async function clearSessionContextSelection(
  profileId: string,
  sessionKey: string
): Promise<void> {
  await ensureStateLoaded();
  const key = buildSelectionKey(profileId, sessionKey);
  if (!state.selectionsByKey[key]) {
    return;
  }

  delete state.selectionsByKey[key];
  await persistState();
}
