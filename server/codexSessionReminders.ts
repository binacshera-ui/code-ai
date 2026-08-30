import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

export interface CodexSessionReminder {
  id: string;
  name: string;
  content: string;
  sourceEntryId: string | null;
  sourceRole: 'user' | 'assistant' | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRemindersState {
  remindersByKey: Record<string, CodexSessionReminder[]>;
}

const REMINDERS_FILE = path.join(CODEX_APP_CONFIG.storageRoot, 'session-reminders.json');

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: SessionRemindersState = {
  remindersByKey: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildReminderKey(profileId: string, sessionKey: string): string {
  return `${profileId}:${sessionKey}`;
}

function cloneReminder(reminder: CodexSessionReminder): CodexSessionReminder {
  return { ...reminder };
}

function normalizeReminderName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new Error('Reminder name is required');
  }

  return normalized.slice(0, 120);
}

function normalizeReminderContent(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('Reminder content is required');
  }

  return normalized.slice(0, 16000);
}

function normalizeSourceRole(value: unknown): 'user' | 'assistant' | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function normalizeReminderRecord(value: unknown): CodexSessionReminder | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const reminder = value as Partial<CodexSessionReminder>;
  if (
    typeof reminder.id !== 'string'
    || typeof reminder.name !== 'string'
    || typeof reminder.content !== 'string'
    || typeof reminder.createdAt !== 'string'
    || typeof reminder.updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    id: reminder.id,
    name: reminder.name,
    content: reminder.content,
    sourceEntryId: typeof reminder.sourceEntryId === 'string' && reminder.sourceEntryId.trim()
      ? reminder.sourceEntryId.trim()
      : null,
    sourceRole: normalizeSourceRole(reminder.sourceRole),
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}

async function ensureStateLoaded() {
  if (stateLoadedPromise) {
    return stateLoadedPromise;
  }

  stateLoadedPromise = (async () => {
    try {
      const raw = await fs.readFile(REMINDERS_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SessionRemindersState>;
      const remindersByKey = parsed.remindersByKey && typeof parsed.remindersByKey === 'object'
        ? Object.fromEntries(
          Object.entries(parsed.remindersByKey)
            .filter(([key]) => Boolean(key))
            .map(([key, value]) => {
              const reminders = Array.isArray(value)
                ? value
                  .map((item) => normalizeReminderRecord(item))
                  .filter((item): item is CodexSessionReminder => Boolean(item))
                : [];
              return [key, reminders];
            })
        )
        : {};
      state = {
        remindersByKey,
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      state = {
        remindersByKey: {},
      };
    }
  })();

  return stateLoadedPromise;
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await fs.mkdir(path.dirname(REMINDERS_FILE), { recursive: true });
    await fs.writeFile(REMINDERS_FILE, snapshot, 'utf-8');
  });

  await persistTail;
}

function getReminderList(profileId: string, sessionKey: string): CodexSessionReminder[] {
  return state.remindersByKey[buildReminderKey(profileId, sessionKey)] || [];
}

function setReminderList(profileId: string, sessionKey: string, reminders: CodexSessionReminder[]) {
  const key = buildReminderKey(profileId, sessionKey);
  if (reminders.length === 0) {
    delete state.remindersByKey[key];
    return;
  }

  state.remindersByKey[key] = reminders;
}

export async function listSessionReminders(
  profileId: string,
  sessionKey: string
): Promise<CodexSessionReminder[]> {
  await ensureStateLoaded();
  return getReminderList(profileId, sessionKey)
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(cloneReminder);
}

export async function getSessionRemindersByIds(
  profileId: string,
  sessionKey: string,
  reminderIds: string[]
): Promise<CodexSessionReminder[]> {
  await ensureStateLoaded();
  if (!Array.isArray(reminderIds) || reminderIds.length === 0) {
    return [];
  }

  const remindersById = new Map(getReminderList(profileId, sessionKey).map((reminder) => [reminder.id, reminder]));
  return reminderIds
    .map((reminderId) => remindersById.get(reminderId))
    .filter((reminder): reminder is CodexSessionReminder => Boolean(reminder))
    .map(cloneReminder);
}

export async function createSessionReminder(
  profileId: string,
  sessionKey: string,
  input: {
    name: string;
    content: string;
    sourceEntryId?: string | null;
    sourceRole?: 'user' | 'assistant' | null;
  }
): Promise<CodexSessionReminder> {
  await ensureStateLoaded();

  const reminder: CodexSessionReminder = {
    id: randomUUID(),
    name: normalizeReminderName(input.name),
    content: normalizeReminderContent(input.content),
    sourceEntryId: typeof input.sourceEntryId === 'string' && input.sourceEntryId.trim()
      ? input.sourceEntryId.trim()
      : null,
    sourceRole: normalizeSourceRole(input.sourceRole),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const reminders = getReminderList(profileId, sessionKey).slice();
  reminders.unshift(reminder);
  setReminderList(profileId, sessionKey, reminders);
  await persistState();
  return cloneReminder(reminder);
}

export async function deleteSessionReminder(
  profileId: string,
  sessionKey: string,
  reminderId: string
): Promise<void> {
  await ensureStateLoaded();

  const reminders = getReminderList(profileId, sessionKey);
  const nextReminders = reminders.filter((reminder) => reminder.id !== reminderId);
  if (nextReminders.length === reminders.length) {
    return;
  }

  setReminderList(profileId, sessionKey, nextReminders);
  await persistState();
}

export async function copySessionReminders(
  sourceProfileId: string,
  sourceSessionKey: string,
  targetProfileId: string,
  targetSessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  const sourceReminders = getReminderList(sourceProfileId, sourceSessionKey);
  if (sourceReminders.length === 0) {
    return;
  }

  const targetReminders = getReminderList(targetProfileId, targetSessionKey);
  const mergedById = new Map<string, CodexSessionReminder>();

  for (const reminder of targetReminders) {
    mergedById.set(reminder.id, cloneReminder(reminder));
  }
  for (const reminder of sourceReminders) {
    mergedById.set(reminder.id, cloneReminder(reminder));
  }

  setReminderList(
    targetProfileId,
    targetSessionKey,
    [...mergedById.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );
  await persistState();
}

export async function rebindSessionReminders(
  profileId: string,
  fromSessionKey: string,
  toSessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  if (!fromSessionKey || !toSessionKey || fromSessionKey === toSessionKey) {
    return;
  }

  const sourceKey = buildReminderKey(profileId, fromSessionKey);
  const targetKey = buildReminderKey(profileId, toSessionKey);
  const sourceReminders = state.remindersByKey[sourceKey];
  if (!sourceReminders || sourceReminders.length === 0) {
    return;
  }

  const targetReminders = state.remindersByKey[targetKey] || [];
  const mergedById = new Map<string, CodexSessionReminder>();
  for (const reminder of targetReminders) {
    mergedById.set(reminder.id, cloneReminder(reminder));
  }
  for (const reminder of sourceReminders) {
    mergedById.set(reminder.id, cloneReminder(reminder));
  }

  state.remindersByKey[targetKey] = [...mergedById.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  delete state.remindersByKey[sourceKey];
  await persistState();
}

export async function deleteSessionReminders(
  profileId: string,
  sessionKey: string
): Promise<void> {
  await ensureStateLoaded();

  const key = buildReminderKey(profileId, sessionKey);
  if (!state.remindersByKey[key]) {
    return;
  }

  delete state.remindersByKey[key];
  await persistState();
}
