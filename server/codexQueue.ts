import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
  type CodexExecutionConfig,
  type CodexSessionDetail,
  type CodexUploadedAttachment,
} from './codexService.js';
import {
  cancelAgentRun,
  getAgentSessionDetail,
  isAgentRunCancelledError,
  runAgentPrompt,
} from './agentService.js';
import {
  deleteForkDraftSession,
  recordForkSessionMetadata,
  type CodexForkContext,
  type CodexForkTimelineEntry,
} from './codexForkSessions.js';
import { CODEX_APP_CONFIG } from './config.js';
import { rebindSessionInstruction } from './codexSessionInstructions.js';
import { listHiddenSessionIds, setSessionHidden } from './codexSessionVisibility.js';
import { getSessionTopicMap, setSessionTopic } from './codexSessionTopics.js';
import { getSessionTitleMap, setSessionCustomTitle } from './codexSessionTitles.js';

export type CodexQueueItemStatus =
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CodexQueueScheduleMode = 'once' | 'recurring';
export type CodexQueueRecurringFrequency = 'daily' | 'weekly';
export type CodexQueueLastRunStatus = 'completed' | 'failed';

export interface CodexQueueItem {
  id: string;
  profileId: string;
  queueKey: string;
  clientRequestId?: string | null;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string;
  promptPreview: string;
  contextPrefix?: string | null;
  sessionInstruction?: string | null;
  forkContext?: CodexForkContext | null;
  attachments: CodexUploadedAttachment[];
  status: CodexQueueItemStatus;
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  finalMessage: string | null;
  error: string | null;
  attempts: number;
  scheduleMode: CodexQueueScheduleMode;
  recurringFrequency: CodexQueueRecurringFrequency | null;
  recurringTimeZone: string | null;
  lastRunAt: string | null;
  lastRunStatus: CodexQueueLastRunStatus | null;
}

interface CodexQueueState {
  items: CodexQueueItem[];
  sessionBindings: Record<string, string>;
}

interface EnqueueCodexQueueInput {
  profileId: string;
  queueKey: string;
  clientRequestId?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  prompt: string;
  promptPreview?: string | null;
  contextPrefix?: string | null;
  sessionInstruction?: string | null;
  forkContext?: unknown;
  scheduledAt?: string | null;
  attachments?: CodexUploadedAttachment[];
  recurrence?: {
    frequency: CodexQueueRecurringFrequency;
    timeZone: string;
  } | null;
}

const QUEUE_ROOT = CODEX_APP_CONFIG.queueRoot;
const STATE_FILE = path.join(QUEUE_ROOT, 'state.json');
const WORKER_POLL_MS = 1500;
const MAX_PARALLEL_QUEUE_ITEMS = 6;
const QUEUE_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexQueueState = {
  items: [],
  sessionBindings: {},
};
let workerStarted = false;
let workerTickInFlight = false;
let activeWorkerItemIds = new Set<string>();
let activeWorkerQueueKeys = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function isDraftSessionKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('draft:');
}

function cloneQueueItem(item: CodexQueueItem): CodexQueueItem {
  return {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
  };
}

function trimPreview(text: string, limit = 140): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function isTerminalStatus(status: CodexQueueItemStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isRecurringFrequency(value: unknown): value is CodexQueueRecurringFrequency {
  return value === 'daily' || value === 'weekly';
}

function isLastRunStatus(value: unknown): value is CodexQueueLastRunStatus {
  return value === 'completed' || value === 'failed';
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
    kind: value.kind === 'prompt' || value.kind === 'commentary' || value.kind === 'final' || value.kind === 'transfer'
      ? value.kind
      : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
    toolName: typeof value.toolName === 'string' ? value.toolName : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    subtitle: typeof value.subtitle === 'string' ? value.subtitle : value.subtitle === null ? null : undefined,
    callId: typeof value.callId === 'string' ? value.callId : value.callId === null ? null : undefined,
    status: typeof value.status === 'string' ? value.status : value.status === null ? null : undefined,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : value.exitCode === null ? null : undefined,
  };
}

function normalizeForkContext(value: unknown): CodexForkContext | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceSessionId !== 'string'
    || typeof candidate.sourceTitle !== 'string'
    || typeof candidate.forkEntryId !== 'string'
    || !Array.isArray(candidate.timeline)
  ) {
    return null;
  }

  const timeline = candidate.timeline
    .map((entry) => sanitizeForkTimelineEntry(entry))
    .filter((entry): entry is CodexForkTimelineEntry => Boolean(entry));

  if (timeline.length === 0) {
    return null;
  }

  return {
    sourceSessionId: candidate.sourceSessionId.trim(),
    sourceTitle: candidate.sourceTitle.trim(),
    sourceCwd: typeof candidate.sourceCwd === 'string' && candidate.sourceCwd.trim()
      ? candidate.sourceCwd.trim()
      : null,
    forkEntryId: candidate.forkEntryId.trim(),
    transferSourceProvider: candidate.transferSourceProvider === 'codex'
      || candidate.transferSourceProvider === 'claude'
      || candidate.transferSourceProvider === 'gemini'
      ? candidate.transferSourceProvider
      : null,
    transferTargetProvider: candidate.transferTargetProvider === 'codex'
      || candidate.transferTargetProvider === 'claude'
      || candidate.transferTargetProvider === 'gemini'
      ? candidate.transferTargetProvider
      : null,
    timeline,
  };
}

function isRecurringItem(
  item: Pick<CodexQueueItem, 'scheduleMode' | 'recurringFrequency' | 'recurringTimeZone'>
): boolean {
  return (
    item.scheduleMode === 'recurring'
    && isRecurringFrequency(item.recurringFrequency)
    && typeof item.recurringTimeZone === 'string'
    && item.recurringTimeZone.length > 0
  );
}

function normalizeScheduledAt(value?: string | null): string {
  if (!value) {
    return nowIso();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Scheduled time is invalid');
  }

  return date.toISOString();
}

function normalizeRecurringTimeZone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Recurring timezone is required');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
  } catch {
    throw new Error('Recurring timezone is invalid');
  }

  return trimmed;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedFormatter(timeZone: string) {
  let formatter = zonedFormatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    zonedFormatterCache.set(timeZone, formatter);
  }

  return formatter;
}

function getOffsetFormatter(timeZone: string) {
  let formatter = offsetFormatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    offsetFormatterCache.set(timeZone, formatter);
  }

  return formatter;
}

function readNumericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const raw = parts.find((part) => part.type === type)?.value;
  const parsed = Number.parseInt(raw || '', 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to read ${type} from timezone formatter`);
  }

  return parsed;
}

function getZonedDateTimeParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const parts = getZonedFormatter(timeZone).formatToParts(date);
  return {
    year: readNumericPart(parts, 'year'),
    month: readNumericPart(parts, 'month'),
    day: readNumericPart(parts, 'day'),
    hour: readNumericPart(parts, 'hour'),
    minute: readNumericPart(parts, 'minute'),
    second: readNumericPart(parts, 'second'),
  };
}

function parseShortOffsetMinutes(rawOffset: string): number {
  if (rawOffset === 'GMT' || rawOffset === 'UTC') {
    return 0;
  }

  const match = rawOffset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Unsupported timezone offset format: ${rawOffset}`);
  }

  const [, sign, hours, minutes = '00'] = match;
  const totalMinutes = Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10);
  return sign === '-' ? -totalMinutes : totalMinutes;
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = getOffsetFormatter(timeZone).formatToParts(date);
  const offsetName = parts.find((part) => part.type === 'timeZoneName')?.value;

  if (!offsetName) {
    throw new Error('Unable to resolve timezone offset');
  }

  return parseShortOffsetMinutes(offsetName);
}

function addCalendarDays(
  year: number,
  month: number,
  day: number,
  incrementDays: number
): Pick<ZonedDateTimeParts, 'year' | 'month' | 'day'> {
  const nextDate = new Date(Date.UTC(year, month - 1, day + incrementDays));
  return {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };
}

function zonedLocalDateTimeToUtc(parts: ZonedDateTimeParts, timeZone: string): Date {
  const localUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  let resolvedUtcMs = localUtcMs;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(resolvedUtcMs), timeZone);
    const adjustedUtcMs = localUtcMs - (offsetMinutes * 60 * 1000);

    if (adjustedUtcMs === resolvedUtcMs) {
      break;
    }

    resolvedUtcMs = adjustedUtcMs;
  }

  return new Date(resolvedUtcMs);
}

function computeNextRecurringScheduledAt(
  item: Pick<CodexQueueItem, 'scheduledAt' | 'scheduleMode' | 'recurringFrequency' | 'recurringTimeZone'>,
  referenceMs = Date.now()
): string {
  if (!isRecurringItem(item)) {
    throw new Error('Recurring configuration is missing');
  }

  const recurringTimeZone = item.recurringTimeZone as string;
  const recurringFrequency = item.recurringFrequency as CodexQueueRecurringFrequency;

  const anchorParts = getZonedDateTimeParts(new Date(item.scheduledAt), recurringTimeZone);
  const incrementDays = recurringFrequency === 'daily' ? 1 : 7;

  let candidateParts = { ...anchorParts };
  let candidate = zonedLocalDateTimeToUtc(candidateParts, recurringTimeZone);

  while (candidate.getTime() <= referenceMs) {
    candidateParts = {
      ...candidateParts,
      ...addCalendarDays(candidateParts.year, candidateParts.month, candidateParts.day, incrementDays),
    };
    candidate = zonedLocalDateTimeToUtc(candidateParts, recurringTimeZone);
  }

  return candidate.toISOString();
}

function sortQueueItems(items: CodexQueueItem[]): CodexQueueItem[] {
  const readAnchorTime = (item: CodexQueueItem) => {
    const scheduledMs = new Date(item.scheduledAt || item.createdAt).getTime();
    if (!Number.isNaN(scheduledMs)) {
      return scheduledMs;
    }

    return new Date(item.createdAt).getTime();
  };

  return [...items].sort((left, right) => {
    const leftAnchor = readAnchorTime(left);
    const rightAnchor = readAnchorTime(right);
    if (rightAnchor !== leftAnchor) {
      return rightAnchor - leftAnchor;
    }

    const leftCreated = new Date(left.createdAt).getTime();
    const rightCreated = new Date(right.createdAt).getTime();
    return rightCreated - leftCreated;
  });
}

async function ensureQueueRoot() {
  await fs.mkdir(QUEUE_ROOT, { recursive: true });
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  persistTail = persistTail.then(async () => {
    await ensureQueueRoot();
    await fs.writeFile(STATE_FILE, snapshot, 'utf-8');
  });
  await persistTail;
}

async function loadState() {
  await ensureQueueRoot();

  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CodexQueueState>;
    state = {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      sessionBindings: parsed.sessionBindings && typeof parsed.sessionBindings === 'object'
        ? parsed.sessionBindings as Record<string, string>
        : {},
    };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    state = {
      items: [],
      sessionBindings: {},
    };
  }

  const now = Date.now();
  let changed = false;

  state.items = state.items
    .filter((item) => {
      if (!isTerminalStatus(item.status)) {
        return true;
      }

      const completedAt = item.completedAt || item.updatedAt || item.createdAt;
      return now - new Date(completedAt).getTime() <= QUEUE_RETENTION_MS;
    })
    .map((item) => {
      const next: CodexQueueItem = {
        ...cloneQueueItem(item as CodexQueueItem),
        clientRequestId: typeof item.clientRequestId === 'string' && item.clientRequestId.trim()
          ? item.clientRequestId.trim()
          : null,
        cwd: typeof item.cwd === 'string' && item.cwd.trim()
          ? item.cwd.trim()
          : null,
        model: typeof item.model === 'string' && item.model.trim()
          ? item.model.trim()
          : null,
        reasoningEffort: typeof item.reasoningEffort === 'string' && item.reasoningEffort.trim()
          ? item.reasoningEffort.trim()
          : null,
        promptPreview: typeof item.promptPreview === 'string' && item.promptPreview.trim()
          ? item.promptPreview.trim()
          : trimPreview(item.prompt || ''),
        contextPrefix: typeof item.contextPrefix === 'string' && item.contextPrefix.trim()
          ? item.contextPrefix.trim()
          : null,
        sessionInstruction: typeof item.sessionInstruction === 'string' && item.sessionInstruction.trim()
          ? item.sessionInstruction.trim()
          : null,
        forkContext: normalizeForkContext(item.forkContext),
        scheduleMode: item.scheduleMode === 'recurring' ? 'recurring' : 'once',
        recurringFrequency: isRecurringFrequency(item.recurringFrequency) ? item.recurringFrequency : null,
        recurringTimeZone: typeof item.recurringTimeZone === 'string' && item.recurringTimeZone
          ? item.recurringTimeZone
          : null,
        lastRunAt: typeof item.lastRunAt === 'string' ? item.lastRunAt : null,
        lastRunStatus: isLastRunStatus(item.lastRunStatus) ? item.lastRunStatus : null,
      };

      if (next.scheduleMode === 'recurring' && !isRecurringItem(next)) {
        next.scheduleMode = 'once';
        next.recurringFrequency = null;
        next.recurringTimeZone = null;
        changed = true;
      }

      if (next.status === 'running') {
        if (isRecurringItem(next)) {
          applyRecurringResult(next, 'failed', {
            sessionId: next.sessionId,
            error: 'Interrupted by server restart before completion.',
          });
        } else {
          const interruptedAt = nowIso();
          next.status = 'failed';
          next.completedAt = interruptedAt;
          next.updatedAt = interruptedAt;
          next.error = 'Interrupted by server restart before completion.';
        }
        changed = true;
      }

      if (next.status === 'cancelling') {
        next.status = 'cancelled';
        next.completedAt = nowIso();
        next.updatedAt = next.completedAt;
        next.error = null;
        next.finalMessage = null;
        changed = true;
      }

      if (next.status === 'scheduled' && new Date(next.scheduledAt).getTime() <= now) {
        next.status = 'queued';
        changed = true;
      }

      return next;
    });

  if (changed) {
    await persistState();
  }
}

async function ensureStateLoaded() {
  if (!stateLoadedPromise) {
    stateLoadedPromise = loadState();
  }

  await stateLoadedPromise;
}

async function refreshDueItems() {
  await ensureStateLoaded();

  let changed = false;
  const now = Date.now();

  for (const item of state.items) {
    if (item.status === 'scheduled' && new Date(item.scheduledAt).getTime() <= now) {
      item.status = 'queued';
      item.updatedAt = nowIso();
      changed = true;
    }
  }

  if (changed) {
    await persistState();
  }
}

function hasBlockingPreviousItem(candidate: CodexQueueItem): boolean {
  const now = Date.now();

  return state.items.some((item) => {
    if (item.id === candidate.id) {
      return false;
    }

    if (item.queueKey !== candidate.queueKey) {
      return false;
    }

    if (isTerminalStatus(item.status)) {
      return false;
    }

    if (item.status === 'scheduled' && new Date(item.scheduledAt).getTime() > now) {
      return false;
    }

    return new Date(item.createdAt).getTime() < new Date(candidate.createdAt).getTime();
  });
}

function applyRecurringResult(
  item: CodexQueueItem,
  lastRunStatus: CodexQueueLastRunStatus,
  options: {
    sessionId?: string | null;
    finalMessage?: string | null;
    error?: string | null;
  } = {}
) {
  if (!isRecurringItem(item)) {
    throw new Error('Recurring result cannot be applied to a one-time queue item');
  }

  const finishedAt = nowIso();

  if (options.sessionId) {
    item.sessionId = options.sessionId;
    state.sessionBindings[item.queueKey] = options.sessionId;
  }

  item.lastRunAt = finishedAt;
  item.lastRunStatus = lastRunStatus;
  item.completedAt = finishedAt;
  item.updatedAt = finishedAt;
  item.finalMessage = lastRunStatus === 'completed' ? options.finalMessage || null : null;
  item.error = lastRunStatus === 'failed' ? options.error || 'Recurring Codex job failed' : null;
  item.scheduledAt = computeNextRecurringScheduledAt(item, Date.now());
  item.status = 'scheduled';
}

function pickRunnableItems(limit: number): CodexQueueItem[] {
  if (limit <= 0) {
    return [];
  }

  const reservedQueueKeys = new Set(activeWorkerQueueKeys);
  const dueItems = state.items
    .filter((item) => item.status === 'queued')
    .sort((left, right) => {
      const leftScheduled = new Date(left.scheduledAt).getTime();
      const rightScheduled = new Date(right.scheduledAt).getTime();
      if (leftScheduled !== rightScheduled) {
        return leftScheduled - rightScheduled;
      }

      return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    });

  const pickedItems: CodexQueueItem[] = [];

  for (const item of dueItems) {
    if (pickedItems.length >= limit) {
      break;
    }

    if (activeWorkerItemIds.has(item.id) || reservedQueueKeys.has(item.queueKey)) {
      continue;
    }

    if (!hasBlockingPreviousItem(item)) {
      pickedItems.push(item);
      reservedQueueKeys.add(item.queueKey);
    }
  }

  return pickedItems;
}

function launchQueueItem(item: CodexQueueItem) {
  if (activeWorkerItemIds.has(item.id) || activeWorkerQueueKeys.has(item.queueKey)) {
    return;
  }

  const workerQueueKey = item.queueKey;
  activeWorkerItemIds.add(item.id);
  activeWorkerQueueKeys.add(workerQueueKey);

  void processQueueItem(item).finally(() => {
    activeWorkerItemIds.delete(item.id);
    activeWorkerQueueKeys.delete(workerQueueKey);
    scheduleImmediateTick();
  });
}

async function rebindQueueItemsToSession(profileId: string, queueKey: string, sessionId: string) {
  if (!queueKey || !sessionId) {
    return;
  }

  state.sessionBindings[queueKey] = sessionId;
  state.sessionBindings[sessionId] = sessionId;
  await rebindSessionInstruction(profileId, queueKey, sessionId);

  for (const candidate of state.items) {
    if (candidate.queueKey !== queueKey) {
      continue;
    }

    if (candidate.sessionId && candidate.sessionId !== sessionId) {
      continue;
    }

    candidate.queueKey = sessionId;
    candidate.sessionId = sessionId;
  }
}

async function processQueueItem(item: CodexQueueItem) {
  item.status = 'running';
  item.startedAt = nowIso();
  item.updatedAt = item.startedAt;
  item.error = null;
  item.attempts += 1;
  await persistState();

  const resolvedSessionId = item.sessionId || state.sessionBindings[item.queueKey] || undefined;
  const shouldApplyForkPromptPrefix = isDraftSessionKey(item.sessionId) || isDraftSessionKey(item.queueKey);
  const promptWithForkContext = shouldApplyForkPromptPrefix && item.contextPrefix
    ? `${item.contextPrefix}\n\nהודעת ההמשך החדשה:\n${item.prompt}`
    : item.prompt;
  const runPrompt = item.sessionInstruction
    ? `${promptWithForkContext}\n\nהוראה קבועה לסשן זה. יש ליישם אותה גם אם המשתמש לא חזר עליה בהודעה הנוכחית:\n${item.sessionInstruction}`
    : promptWithForkContext;
  const executionConfig: CodexExecutionConfig = {
    model: item.model,
    reasoningEffort: item.reasoningEffort,
  };
  const shouldDeleteDraftFork = item.queueKey.startsWith('draft:');
  const transferDraftSidebarMetadataToRealSession = async (nextSessionId: string) => {
    if (!shouldDeleteDraftFork) {
      return;
    }

    const [hiddenIds, topicMap, titleMap] = await Promise.all([
      listHiddenSessionIds(item.profileId),
      getSessionTopicMap(item.profileId),
      getSessionTitleMap(item.profileId),
    ]);

    if (hiddenIds.has(item.queueKey)) {
      await setSessionHidden(item.profileId, nextSessionId, true);
      await setSessionHidden(item.profileId, item.queueKey, false);
    }

    const draftTopic = topicMap[item.queueKey];
    if (draftTopic) {
      await setSessionTopic(item.profileId, nextSessionId, draftTopic.id, item.cwd || draftTopic.cwd);
      await setSessionTopic(item.profileId, item.queueKey, null);
    }

    const draftTitle = titleMap[item.queueKey];
    if (draftTitle) {
      await setSessionCustomTitle(item.profileId, nextSessionId, draftTitle);
      await setSessionCustomTitle(item.profileId, item.queueKey, null);
    }
  };

  try {
    const result = await runAgentPrompt(
      runPrompt,
      resolvedSessionId,
      item.profileId,
      item.attachments,
      {
        runId: item.id,
        cwd: item.cwd || undefined,
        injectDirectoryContext: !resolvedSessionId,
        executionConfig,
      }
    );

    await rebindQueueItemsToSession(item.profileId, item.queueKey, result.sessionId);

    if (isRecurringItem(item)) {
      applyRecurringResult(item, 'completed', {
        sessionId: result.sessionId,
        finalMessage: result.finalMessage,
      });
      await transferDraftSidebarMetadataToRealSession(result.sessionId);
      if (item.forkContext) {
        await recordForkSessionMetadata({
          sessionId: result.sessionId,
          profileId: item.profileId,
          sourceSessionId: item.forkContext.sourceSessionId,
          sourceTitle: item.forkContext.sourceTitle,
          sourceCwd: item.forkContext.sourceCwd,
          forkEntryId: item.forkContext.forkEntryId,
          transferSourceProvider: item.forkContext.transferSourceProvider || null,
          transferTargetProvider: item.forkContext.transferTargetProvider || null,
          promptPreview: item.prompt.trim() || item.promptPreview,
          timeline: item.forkContext.timeline,
          createdAt: nowIso(),
        });
      }
      if (shouldDeleteDraftFork) {
        await deleteForkDraftSession(item.queueKey);
      }
      await persistState();
      return;
    }

    item.status = 'completed';
    item.sessionId = result.sessionId;
    item.finalMessage = result.finalMessage;
    item.completedAt = nowIso();
    item.updatedAt = item.completedAt;
    item.error = null;
    state.sessionBindings[item.queueKey] = result.sessionId;
    await transferDraftSidebarMetadataToRealSession(result.sessionId);
    if (item.forkContext) {
      await recordForkSessionMetadata({
        sessionId: result.sessionId,
        profileId: item.profileId,
        sourceSessionId: item.forkContext.sourceSessionId,
        sourceTitle: item.forkContext.sourceTitle,
        sourceCwd: item.forkContext.sourceCwd,
        forkEntryId: item.forkContext.forkEntryId,
        transferSourceProvider: item.forkContext.transferSourceProvider || null,
        transferTargetProvider: item.forkContext.transferTargetProvider || null,
        promptPreview: item.prompt.trim() || item.promptPreview,
        timeline: item.forkContext.timeline,
        createdAt: nowIso(),
      });
    }
    if (shouldDeleteDraftFork) {
      await deleteForkDraftSession(item.queueKey);
    }
    await persistState();
  } catch (error: any) {
    if (isAgentRunCancelledError(error)) {
      item.status = 'cancelled';
      item.completedAt = nowIso();
      item.updatedAt = item.completedAt;
      item.error = null;
      item.finalMessage = null;
      await persistState();
      return;
    }

    if (isRecurringItem(item)) {
      applyRecurringResult(item, 'failed', {
        error: error?.message || 'Codex job failed',
      });
      await persistState();
      return;
    }

    item.status = 'failed';
    item.error = error?.message || 'Codex job failed';
    item.completedAt = nowIso();
    item.updatedAt = item.completedAt;
    await persistState();
  }
}

async function tickWorker() {
  if (workerTickInFlight) {
    return;
  }

  workerTickInFlight = true;

  try {
    await refreshDueItems();

    const availableSlots = Math.max(0, MAX_PARALLEL_QUEUE_ITEMS - activeWorkerItemIds.size);
    if (availableSlots === 0) {
      return;
    }

    const nextItems = pickRunnableItems(availableSlots);
    if (nextItems.length === 0) {
      return;
    }

    nextItems.forEach(launchQueueItem);
  } finally {
    workerTickInFlight = false;
  }
}

function scheduleImmediateTick() {
  setTimeout(() => {
    void tickWorker();
  }, 0);
}

export async function startCodexQueueWorker() {
  await ensureStateLoaded();

  if (workerStarted) {
    return;
  }

  workerStarted = true;
  setInterval(() => {
    void tickWorker();
  }, WORKER_POLL_MS);
  scheduleImmediateTick();
}

export async function listCodexQueueItems(profileId?: string): Promise<CodexQueueItem[]> {
  await refreshDueItems();

  const filtered = profileId
    ? state.items.filter((item) => item.profileId === profileId)
    : state.items;

  return sortQueueItems(filtered).map(cloneQueueItem);
}

export async function getCodexQueueItem(itemId: string): Promise<CodexQueueItem | null> {
  await refreshDueItems();
  const item = state.items.find((entry) => entry.id === itemId);
  return item ? cloneQueueItem(item) : null;
}

export async function getCodexQueueItemSession(itemId: string): Promise<CodexSessionDetail | null> {
  const item = await getCodexQueueItem(itemId);
  if (!item?.sessionId) {
    return null;
  }

  try {
    return await getAgentSessionDetail(item.sessionId, item.profileId);
  } catch {
    return null;
  }
}

export async function enqueueCodexQueueItem(input: EnqueueCodexQueueInput): Promise<CodexQueueItem> {
  await ensureStateLoaded();

  if (input.recurrence && !input.scheduledAt) {
    throw new Error('Recurring queue items require a scheduled time');
  }

  const clientRequestId = typeof input.clientRequestId === 'string' && input.clientRequestId.trim()
    ? input.clientRequestId.trim()
    : null;

  if (clientRequestId) {
    const existingItem = state.items.find((item) => (
      item.profileId === input.profileId
      && item.clientRequestId === clientRequestId
    ));

    if (existingItem) {
      return cloneQueueItem(existingItem);
    }
  }

  const recurrence = input.recurrence
    ? {
      frequency: input.recurrence.frequency,
      timeZone: normalizeRecurringTimeZone(input.recurrence.timeZone),
    }
    : null;
  let scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const now = nowIso();
  const item: CodexQueueItem = {
    id: randomUUID(),
    profileId: input.profileId,
    queueKey: input.queueKey,
    clientRequestId,
    sessionId: input.sessionId || state.sessionBindings[input.queueKey] || null,
    cwd: input.cwd?.trim() || null,
    model: typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : null,
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()
      ? input.reasoningEffort.trim()
      : null,
    prompt: input.prompt.trim(),
    promptPreview: typeof input.promptPreview === 'string' && input.promptPreview.trim()
      ? input.promptPreview.trim()
      : trimPreview(input.prompt),
    contextPrefix: typeof input.contextPrefix === 'string' && input.contextPrefix.trim()
      ? input.contextPrefix.trim()
      : null,
    sessionInstruction: typeof input.sessionInstruction === 'string' && input.sessionInstruction.trim()
      ? input.sessionInstruction.trim()
      : null,
    forkContext: normalizeForkContext(input.forkContext),
    attachments: (input.attachments || []).map((attachment) => ({ ...attachment })),
    status: new Date(scheduledAt).getTime() > Date.now() ? 'scheduled' : 'queued',
    scheduledAt,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    finalMessage: null,
    error: null,
    attempts: 0,
    scheduleMode: recurrence ? 'recurring' : 'once',
    recurringFrequency: recurrence?.frequency || null,
    recurringTimeZone: recurrence?.timeZone || null,
    lastRunAt: null,
    lastRunStatus: null,
  };

  if (isRecurringItem(item)) {
    scheduledAt = computeNextRecurringScheduledAt(item, Date.now());
    item.scheduledAt = scheduledAt;
    item.status = 'scheduled';
  }

  if (!item.prompt && item.attachments.length === 0) {
    throw new Error('Queue item must contain prompt text or attachments');
  }

  if (item.sessionId) {
    state.sessionBindings[item.queueKey] = item.sessionId;
  }

  state.items.push(item);
  await persistState();
  scheduleImmediateTick();
  return cloneQueueItem(item);
}

export async function cancelCodexQueueItem(itemId: string): Promise<CodexQueueItem> {
  await ensureStateLoaded();
  const item = state.items.find((entry) => entry.id === itemId);

  if (!item) {
    throw new Error('Queue item was not found');
  }

  if (item.status === 'cancelling') {
    throw new Error('Queue item is already stopping');
  }

  if (item.status === 'running') {
    if (!cancelAgentRun(item.id, item.profileId)) {
      throw new Error('Running queue item could not be stopped');
    }

    item.status = 'cancelling';
    item.updatedAt = nowIso();
    item.error = null;
    await persistState();
    return cloneQueueItem(item);
  }

  if (isTerminalStatus(item.status) && item.status !== 'failed') {
    throw new Error('Queue item cannot be cancelled');
  }

  item.status = 'cancelled';
  item.updatedAt = nowIso();
  item.completedAt = item.updatedAt;
  await persistState();
  return cloneQueueItem(item);
}

export async function retryCodexQueueItem(
  itemId: string,
  scheduledAt?: string | null
): Promise<CodexQueueItem> {
  await ensureStateLoaded();
  const item = state.items.find((entry) => entry.id === itemId);

  if (!item) {
    throw new Error('Queue item was not found');
  }

  if (item.status !== 'failed' && item.status !== 'cancelled') {
    throw new Error('Only failed or cancelled queue items can be retried');
  }

  if (isRecurringItem(item)) {
    const nextScheduledAt = normalizeScheduledAt(scheduledAt || item.scheduledAt);
    item.scheduledAt = nextScheduledAt;
    item.scheduledAt = computeNextRecurringScheduledAt(item, Date.now());
    item.status = 'scheduled';
  } else {
    const nextScheduledAt = normalizeScheduledAt(scheduledAt);
    item.status = new Date(nextScheduledAt).getTime() > Date.now() ? 'scheduled' : 'queued';
    item.scheduledAt = nextScheduledAt;
    item.finalMessage = null;
    item.error = null;
  }

  item.updatedAt = nowIso();
  item.startedAt = null;
  item.completedAt = null;
  await persistState();
  scheduleImmediateTick();
  return cloneQueueItem(item);
}

export async function deleteCodexQueueItem(itemId: string): Promise<void> {
  await ensureStateLoaded();
  const index = state.items.findIndex((entry) => entry.id === itemId);

  if (index === -1) {
    throw new Error('Queue item was not found');
  }

  if (state.items[index].status !== 'cancelled' && state.items[index].status !== 'failed') {
    throw new Error('Only failed or cancelled queue items can be deleted');
  }

  state.items.splice(index, 1);
  await persistState();
}
