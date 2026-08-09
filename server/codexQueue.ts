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
import {
  rebindSessionContextSelection,
  type CodexSessionActionRestriction,
} from './codexSessionContextSelections.js';
import { rebindSessionInstruction } from './codexSessionInstructions.js';
import { rebindSessionReminders } from './codexSessionReminders.js';
import {
  buildSessionBrowserModePromptAdditions,
  consumeSessionBrowserModeAfterDispatch,
  rebindSessionBrowserMode,
  type CodexSessionBrowserMode,
} from './codexBrowserMode.js';
import {
  buildSessionDesignModePromptAdditions,
  consumeSessionDesignModeAfterDispatch,
  rebindSessionDesignMode,
  type CodexSessionDesignMode,
} from './codexDesignMode.js';
import {
  buildSessionUxModePromptAdditions,
  consumeSessionUxModeAfterDispatch,
  rebindSessionUxMode,
  type CodexSessionUxMode,
} from './codexUxMode.js';
import {
  buildSessionPersonalChromePromptAdditions,
  consumeSessionPersonalChromeModeAfterDispatch,
  rebindSessionPersonalChromeMode,
  type CodexSessionPersonalChromeMode,
} from './codexPersonalChromeMode.js';
import { listHiddenSessionIds, setSessionHidden } from './codexSessionVisibility.js';
import { getSessionTopicMap, setSessionTopic } from './codexSessionTopics.js';
import { getSessionTitleMap, setSessionCustomTitle } from './codexSessionTitles.js';
import { rebindSupportSessionRecord } from './supportAgentService.js';
import { rebindSessionFinalNotificationPreference } from './codexFinalNotifications.js';
import {
  getAgentSessionRecord,
  recordAgentSessionLinkedSession,
  saveAgentSessionPlan,
  updateAgentRuntimeStatus,
} from './codexAgentSessions.js';
import { buildActionRestrictionPromptAdditions } from './sessionPromptAdditions.js';
import {
  buildConditionalStopDecisionPrompt,
  buildStoppedTaskContinuationPrompt,
  cloneCodexQueueStopPolicy,
  createCodexQueueStopPolicy,
  normalizeCodexQueueStopPolicy,
  readConditionalStopDecision,
  type CodexQueueStopMode,
  type CodexQueueStopPolicy,
} from './codexQueueStopPolicy.js';

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

export interface CodexQueueGoalMode {
  chainId: string;
  stepIndex: number;
  totalSteps: number;
}

export interface CodexQueueItem {
  id: string;
  profileId: string;
  sourceProfileId: string | null;
  queueKey: string;
  clientRequestId?: string | null;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  permissionModeId: string | null;
  prompt: string;
  promptPreview: string;
  contextPrefix?: string | null;
  sessionInstruction?: string | null;
  actionRestriction: CodexSessionActionRestriction | null;
  browserMode: CodexSessionBrowserMode | null;
  personalChromeMode: CodexSessionPersonalChromeMode | null;
  designMode: CodexSessionDesignMode | null;
  uxMode: CodexSessionUxMode | null;
  goalMode: CodexQueueGoalMode | null;
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
  agentSessionId: string | null;
  agentId: string | null;
  agentLinkKind: 'planner' | 'agent' | null;
  priority: number;
  stopPolicy: CodexQueueStopPolicy | null;
  stopDecisionForItemId: string | null;
  continuationOfItemId: string | null;
}

interface CodexQueueState {
  items: CodexQueueItem[];
  sessionBindings: Record<string, string>;
}

interface EnqueueCodexQueueInput {
  profileId: string;
  sourceProfileId?: string | null;
  queueKey: string;
  clientRequestId?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionModeId?: string | null;
  prompt: string;
  promptPreview?: string | null;
  contextPrefix?: string | null;
  sessionInstruction?: string | null;
  actionRestriction?: CodexSessionActionRestriction | null;
  browserMode?: CodexSessionBrowserMode | null;
  personalChromeMode?: CodexSessionPersonalChromeMode | null;
  designMode?: CodexSessionDesignMode | null;
  uxMode?: CodexSessionUxMode | null;
  goalMode?: CodexQueueGoalMode | null;
  forkContext?: unknown;
  scheduledAt?: string | null;
  attachments?: CodexUploadedAttachment[];
  recurrence?: {
    frequency: CodexQueueRecurringFrequency;
    timeZone: string;
  } | null;
  agentSessionId?: string | null;
  agentId?: string | null;
  agentLinkKind?: 'planner' | 'agent' | null;
  priority?: number;
  stopPolicy?: CodexQueueStopPolicy | null;
  stopDecisionForItemId?: string | null;
  continuationOfItemId?: string | null;
}

const QUEUE_ROOT = CODEX_APP_CONFIG.queueRoot;
const STATE_FILE = path.join(QUEUE_ROOT, 'state.json');
const STATE_BACKUP_FILE = `${STATE_FILE}.bak`;
const WORKER_POLL_MS = 1500;
const MAX_PARALLEL_QUEUE_ITEMS = 6;
const QUEUE_RETENTION_MS = 21 * 24 * 60 * 60 * 1000;
const STOP_DECISION_PRIORITY = 100;
const STOP_CONTINUATION_PRIORITY = 90;
const MAX_SCHEDULED_STOP_ATTEMPTS = 3;
const QUEUE_EXECUTION_DISABLED = process.env.CODEX_QUEUE_DISABLE_EXECUTION === '1';

let stateLoadedPromise: Promise<void> | null = null;
let persistTail: Promise<void> = Promise.resolve();
let state: CodexQueueState = {
  items: [],
  sessionBindings: {},
};
let workerStarted = false;
let workerTickInFlight = false;
let workerInterval: NodeJS.Timeout | null = null;
let stopPolicyRefreshPromise: Promise<void> | null = null;
let activeWorkerItemIds = new Set<string>();
let activeWorkerQueueKeys = new Set<string>();
let activeWorkerQueueKeyByItemId = new Map<string, string>();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSessionBindingKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveSessionBindingFromState(
  value: string | null | undefined,
  options: {
    fallbackToSelf?: boolean;
  } = {}
): string | null {
  const normalized = normalizeSessionBindingKey(value);
  if (!normalized) {
    return null;
  }

  const seen = new Set<string>();
  let current = normalized;

  while (!seen.has(current)) {
    seen.add(current);
    const next = normalizeSessionBindingKey(state.sessionBindings[current]);
    if (!next) {
      return options.fallbackToSelf ? current : null;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }

  return current;
}

function resolveQueueItemSessionId(
  sessionId: string | null | undefined,
  queueKey: string | null | undefined
): string | null {
  return (
    resolveSessionBindingFromState(sessionId, { fallbackToSelf: true })
    || resolveSessionBindingFromState(queueKey, { fallbackToSelf: false })
    || null
  );
}

export async function resolveCodexQueueSessionId(
  sessionId: string | null | undefined
): Promise<string | null> {
  await ensureStateLoaded();
  return resolveSessionBindingFromState(sessionId, { fallbackToSelf: true });
}

function isDraftSessionKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('draft:');
}

function cloneQueueItem(item: CodexQueueItem): CodexQueueItem {
  return {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    actionRestriction: item.actionRestriction
      ? {
        enabled: item.actionRestriction.enabled === true,
        targetPath: item.actionRestriction.targetPath,
        targetKind: item.actionRestriction.targetKind,
      }
      : null,
    browserMode: item.browserMode
      ? {
        enabled: item.browserMode.enabled === true,
        headless: item.browserMode.headless !== false,
        profileSeed: item.browserMode.profileSeed === 'empty'
          ? 'empty'
          : item.browserMode.profileSeed === 'custom'
            ? 'custom'
            : 'seeded',
        customProfileDir: item.browserMode.profileSeed === 'custom'
          ? item.browserMode.customProfileDir || null
          : null,
      }
      : null,
    personalChromeMode: item.personalChromeMode
      ? { ...item.personalChromeMode }
      : null,
    designMode: item.designMode
      ? {
        enabled: item.designMode.enabled === true,
        geminiProfileId: item.designMode.geminiProfileId,
        quality: item.designMode.quality === 'balanced' ? 'balanced' : 'deep',
        brief: item.designMode.brief,
        canvasAvailable: item.designMode.canvasAvailable === true,
        canvasUpdatedAt: item.designMode.canvasUpdatedAt || null,
      }
      : null,
    uxMode: item.uxMode
      ? {
        enabled: item.uxMode.enabled === true,
        geminiProfileId: item.uxMode.geminiProfileId,
        depth: item.uxMode.depth === 'focused' ? 'focused' : 'deep',
        productBrief: item.uxMode.productBrief,
        targetAudience: item.uxMode.targetAudience,
        primaryOutcome: item.uxMode.primaryOutcome,
      }
      : null,
    goalMode: item.goalMode
      ? {
        chainId: item.goalMode.chainId,
        stepIndex: item.goalMode.stepIndex,
        totalSteps: item.goalMode.totalSteps,
      }
      : null,
    stopPolicy: cloneCodexQueueStopPolicy(item.stopPolicy),
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
    enabled: (value as any).enabled === true,
    targetPath,
    targetKind,
  };
}

function normalizeBrowserMode(value: unknown): CodexSessionBrowserMode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    enabled: (value as any).enabled === true,
    headless: (value as any).headless !== false,
    profileSeed: (value as any).profileSeed === 'empty'
      ? 'empty'
      : (value as any).profileSeed === 'custom'
        ? 'custom'
        : 'seeded',
    customProfileDir: (value as any).profileSeed === 'custom'
      && typeof (value as any).customProfileDir === 'string'
      && (value as any).customProfileDir.trim()
      ? (value as any).customProfileDir.trim()
      : null,
  };
}

function normalizePersonalChromeMode(value: unknown): CodexSessionPersonalChromeMode | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CodexSessionPersonalChromeMode>;
  const tabId = Number(candidate.tabId);
  return {
    enabled: candidate.enabled === true,
    deviceId: typeof candidate.deviceId === 'string' ? candidate.deviceId.trim() : '',
    deviceName: typeof candidate.deviceName === 'string' ? candidate.deviceName.trim() : '',
    tabId: Number.isInteger(tabId) && tabId >= 0 ? tabId : null,
    approvalPolicy: candidate.approvalPolicy === 'always' || candidate.approvalPolicy === 'never'
      ? candidate.approvalPolicy
      : 'risky',
    allowJavascript: candidate.allowJavascript === true,
    allowUploads: candidate.allowUploads !== false,
    allowPorts: candidate.allowPorts !== false,
    bindingId: typeof candidate.bindingId === 'string' && candidate.bindingId.trim()
      ? candidate.bindingId.trim()
      : null,
  };
}

function normalizeDesignMode(value: unknown): CodexSessionDesignMode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const geminiProfileId = typeof (value as any).geminiProfileId === 'string'
    ? (value as any).geminiProfileId.trim()
    : '';
  return {
    enabled: (value as any).enabled === true,
    geminiProfileId,
    quality: (value as any).quality === 'balanced' ? 'balanced' : 'deep',
    brief: typeof (value as any).brief === 'string' ? (value as any).brief : '',
    canvasAvailable: (value as any).canvasAvailable === true,
    canvasUpdatedAt: typeof (value as any).canvasUpdatedAt === 'string'
      ? (value as any).canvasUpdatedAt
      : null,
  };
}

function normalizeUxMode(value: unknown): CodexSessionUxMode | null {
  if (!value || typeof value !== 'object') return null;
  const field = (name: string) => typeof (value as any)[name] === 'string' ? (value as any)[name] : '';
  return {
    enabled: (value as any).enabled === true,
    geminiProfileId: field('geminiProfileId').trim(),
    depth: (value as any).depth === 'focused' ? 'focused' : 'deep',
    productBrief: field('productBrief'),
    targetAudience: field('targetAudience'),
    primaryOutcome: field('primaryOutcome'),
  };
}

function normalizeGoalMode(value: unknown): CodexQueueGoalMode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const chainId = typeof (value as any).chainId === 'string'
    ? (value as any).chainId.trim()
    : '';
  const stepIndex = Number.isInteger((value as any).stepIndex)
    ? Number((value as any).stepIndex)
    : 0;
  const totalSteps = Number.isInteger((value as any).totalSteps)
    ? Number((value as any).totalSteps)
    : 0;

  if (!chainId || stepIndex <= 0 || totalSteps <= 0) {
    return null;
  }

  return {
    chainId,
    stepIndex,
    totalSteps,
  };
}

function isGoalModeFinished(finalMessage: string | null | undefined): boolean {
  if (typeof finalMessage !== 'string' || !finalMessage.trim()) {
    return false;
  }

  const candidates: string[] = [];
  for (const match of finalMessage.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (typeof match[1] === 'string' && match[1].trim()) {
      candidates.push(match[1].trim());
    }
  }

  let depth = 0;
  let startIndex = -1;
  for (let index = 0; index < finalMessage.length; index += 1) {
    const character = finalMessage[index];
    if (character === '{') {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (character !== '}' || depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth === 0 && startIndex >= 0) {
      const candidate = finalMessage.slice(startIndex, index + 1).trim();
      if (candidate) {
        candidates.push(candidate);
      }
      startIndex = -1;
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const finishValue = parsed.finish;
      if (finishValue === true) {
        return true;
      }
      if (typeof finishValue === 'string') {
        const normalized = finishValue.trim().toLowerCase();
        if (normalized === 'true' || normalized === 'yes' || normalized === 'done' || normalized === 'completed') {
          return true;
        }
      }
    } catch {
      // Ignore invalid JSON snippets and continue scanning.
    }
  }

  return false;
}

function cancelRemainingGoalModeItems(completedItem: CodexQueueItem) {
  if (!completedItem.goalMode) {
    return;
  }

  const cancelledAt = nowIso();
  for (const candidate of state.items) {
    if (
      candidate.id === completedItem.id
      || !candidate.goalMode
      || candidate.goalMode.chainId !== completedItem.goalMode.chainId
    ) {
      continue;
    }

    if (candidate.status !== 'queued' && candidate.status !== 'scheduled') {
      continue;
    }

    candidate.status = 'cancelled';
    candidate.updatedAt = cancelledAt;
    candidate.completedAt = cancelledAt;
    candidate.error = 'Goal mode stopped automatically after a previous step reported {"finish": "yes"}.';
    candidate.finalMessage = null;
  }
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

function compareQueueExecutionOrder(left: CodexQueueItem, right: CodexQueueItem): number {
  const priorityDifference = (right.priority || 0) - (left.priority || 0);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const leftScheduled = new Date(left.scheduledAt).getTime();
  const rightScheduled = new Date(right.scheduledAt).getTime();
  if (leftScheduled !== rightScheduled) {
    return leftScheduled - rightScheduled;
  }

  const createdDifference = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  if (createdDifference !== 0) {
    return createdDifference;
  }

  return left.id.localeCompare(right.id);
}

async function ensureQueueRoot() {
  await fs.mkdir(QUEUE_ROOT, { recursive: true });
}

function parseQueueState(raw: string): CodexQueueState {
  const parsed = JSON.parse(raw) as Partial<CodexQueueState> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Codex queue state must be a JSON object');
  }

  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    sessionBindings: parsed.sessionBindings && typeof parsed.sessionBindings === 'object'
      ? parsed.sessionBindings as Record<string, string>
      : {},
  };
}

function recoverCompleteQueueItems(raw: string): CodexQueueItem[] | null {
  const itemsMatch = /"items"\s*:\s*\[/.exec(raw);
  if (!itemsMatch) {
    return null;
  }

  const recovered: CodexQueueItem[] = [];
  let objectStart = -1;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;

  for (let index = itemsMatch.index + itemsMatch[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (objectDepth === 0) {
        objectStart = index;
      }
      objectDepth += 1;
      continue;
    }
    if (character !== '}' || objectDepth === 0) {
      continue;
    }

    objectDepth -= 1;
    if (objectDepth !== 0 || objectStart < 0) {
      continue;
    }

    try {
      const item = JSON.parse(raw.slice(objectStart, index + 1)) as CodexQueueItem;
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        recovered.push(item);
      }
    } catch {
      break;
    }
    objectStart = -1;
  }

  return recovered;
}

function rebuildSessionBindings(
  items: CodexQueueItem[],
  base: Record<string, string> = {}
): Record<string, string> {
  const bindings = { ...base };
  for (const item of items) {
    const queueKey = normalizeSessionBindingKey(item.queueKey);
    const sessionId = normalizeSessionBindingKey(item.sessionId);
    if (!queueKey || !sessionId) {
      continue;
    }
    bindings[queueKey] = sessionId;
    bindings[sessionId] = sessionId;
  }
  return bindings;
}

async function syncQueueDirectory(): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    directoryHandle = await fs.open(QUEUE_ROOT, 'r');
    await directoryHandle.sync();
  } catch (error: any) {
    if (error?.code !== 'EINVAL' && error?.code !== 'ENOTSUP' && error?.code !== 'EPERM') {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function preserveCurrentStateAsBackup(): Promise<void> {
  const temporaryBackup = `${STATE_BACKUP_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.link(STATE_FILE, temporaryBackup);
    try {
      await fs.rename(temporaryBackup, STATE_BACKUP_FILE);
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') {
        throw error;
      }
      await fs.rm(STATE_BACKUP_FILE, { force: true });
      await fs.rename(temporaryBackup, STATE_BACKUP_FILE);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  } finally {
    await fs.rm(temporaryBackup, { force: true }).catch(() => undefined);
  }
}

async function writeStateSnapshot(snapshot: string): Promise<void> {
  await ensureQueueRoot();
  const temporaryState = `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  try {
    handle = await fs.open(temporaryState, 'wx', 0o660);
    await handle.writeFile(snapshot, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;

    await preserveCurrentStateAsBackup();
    await fs.rename(temporaryState, STATE_FILE);
    await syncQueueDirectory();
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryState, { force: true }).catch(() => undefined);
  }
}

async function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  const operation = persistTail
    .catch(() => undefined)
    .then(() => writeStateSnapshot(snapshot));
  persistTail = operation;
  await operation;
}

async function loadState() {
  await ensureQueueRoot();
  let recoveredFromCorruption = false;
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    try {
      state = parseQueueState(raw);
    } catch (primaryError: any) {
      let backupState: CodexQueueState | null = null;
      try {
        backupState = parseQueueState(await fs.readFile(STATE_BACKUP_FILE, 'utf-8'));
      } catch {
        backupState = null;
      }

      const recoveredItems = recoverCompleteQueueItems(raw);
      if (backupState) {
        state = {
          items: backupState.items,
          sessionBindings: rebuildSessionBindings(backupState.items, backupState.sessionBindings),
        };
      } else if (recoveredItems) {
        state = {
          items: recoveredItems,
          sessionBindings: rebuildSessionBindings(recoveredItems),
        };
      } else {
        throw primaryError;
      }

      const corruptPath = `${STATE_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      await fs.rename(STATE_FILE, corruptPath);
      recoveredFromCorruption = true;
      console.error('[codex-queue] Recovered invalid queue state', {
        source: backupState ? STATE_BACKUP_FILE : 'complete-items-prefix',
        recoveredItems: state.items.length,
        corruptPath,
        error: primaryError?.message || String(primaryError),
      });
    }
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
  let changed = recoveredFromCorruption;

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
        sourceProfileId: typeof item.sourceProfileId === 'string' && item.sourceProfileId.trim()
          ? item.sourceProfileId.trim()
          : null,
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
        permissionModeId: typeof item.permissionModeId === 'string' && item.permissionModeId.trim()
          ? item.permissionModeId.trim()
          : null,
        promptPreview: typeof item.promptPreview === 'string' && item.promptPreview.trim()
          ? item.promptPreview.trim()
          : trimPreview(item.prompt || ''),
        contextPrefix: typeof item.contextPrefix === 'string' && item.contextPrefix.trim()
          ? item.contextPrefix.trim()
          : null,
        sessionInstruction: typeof item.sessionInstruction === 'string' && item.sessionInstruction.trim()
          ? item.sessionInstruction
          : null,
        actionRestriction: normalizeActionRestriction(item.actionRestriction),
        browserMode: normalizeBrowserMode(item.browserMode),
        personalChromeMode: normalizePersonalChromeMode(item.personalChromeMode),
        designMode: normalizeDesignMode(item.designMode),
        uxMode: normalizeUxMode(item.uxMode),
        goalMode: normalizeGoalMode(item.goalMode),
        forkContext: normalizeForkContext(item.forkContext),
        scheduleMode: item.scheduleMode === 'recurring' ? 'recurring' : 'once',
        recurringFrequency: isRecurringFrequency(item.recurringFrequency) ? item.recurringFrequency : null,
        recurringTimeZone: typeof item.recurringTimeZone === 'string' && item.recurringTimeZone
          ? item.recurringTimeZone
          : null,
        lastRunAt: typeof item.lastRunAt === 'string' ? item.lastRunAt : null,
        lastRunStatus: isLastRunStatus(item.lastRunStatus) ? item.lastRunStatus : null,
        agentSessionId: typeof item.agentSessionId === 'string' && item.agentSessionId.trim()
          ? item.agentSessionId.trim()
          : null,
        agentId: typeof item.agentId === 'string' && item.agentId.trim()
          ? item.agentId.trim()
          : null,
        agentLinkKind: item.agentLinkKind === 'planner' || item.agentLinkKind === 'agent'
          ? item.agentLinkKind
          : null,
        priority: Number.isFinite(item.priority) ? Number(item.priority) : 0,
        stopPolicy: normalizeCodexQueueStopPolicy(item.stopPolicy),
        stopDecisionForItemId: typeof item.stopDecisionForItemId === 'string' && item.stopDecisionForItemId.trim()
          ? item.stopDecisionForItemId.trim()
          : null,
        continuationOfItemId: typeof item.continuationOfItemId === 'string' && item.continuationOfItemId.trim()
          ? item.continuationOfItemId.trim()
          : null,
      };

      if (next.scheduleMode === 'recurring' && !isRecurringItem(next)) {
        next.scheduleMode = 'once';
        next.recurringFrequency = null;
        next.recurringTimeZone = null;
        changed = true;
      }

      if (next.status === 'running') {
        const wasScheduledStopInProgress = next.stopPolicy?.status === 'stopping';
        if (isRecurringItem(next)) {
          if (wasScheduledStopInProgress) {
            const interruptedAt = nowIso();
            next.status = 'cancelled';
            next.completedAt = interruptedAt;
            next.updatedAt = interruptedAt;
            next.error = null;
            next.finalMessage = null;
          } else {
            applyRecurringResult(next, 'failed', {
              sessionId: next.sessionId,
              error: 'Interrupted by server restart before completion.',
            });
          }
        } else {
          const interruptedAt = nowIso();
          next.status = wasScheduledStopInProgress ? 'cancelled' : 'failed';
          next.completedAt = interruptedAt;
          next.updatedAt = interruptedAt;
          next.error = wasScheduledStopInProgress ? null : 'Interrupted by server restart before completion.';
          next.finalMessage = null;
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

    return compareQueueExecutionOrder(item, candidate) < 0;
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

function markStopPolicyNotNeeded(item: CodexQueueItem) {
  const policy = item.stopPolicy;
  if (!policy || (policy.status !== 'armed' && policy.status !== 'stopping')) {
    return;
  }

  const resolvedAt = nowIso();
  policy.status = 'not-needed';
  policy.resolvedAt = resolvedAt;
  policy.decision = null;
  policy.outcome = 'completed-before-stop';
  policy.error = null;
}

function markHardStopResolved(item: CodexQueueItem) {
  const policy = item.stopPolicy;
  if (!policy) {
    return;
  }

  const resolvedAt = nowIso();
  policy.status = 'stopped';
  policy.resolvedAt = resolvedAt;
  policy.decision = false;
  policy.outcome = 'hard-stopped';
  policy.error = null;
}

function markQueueItemStopped(item: CodexQueueItem) {
  const stoppedAt = nowIso();
  item.status = 'cancelled';
  item.updatedAt = stoppedAt;
  item.completedAt = stoppedAt;
  item.finalMessage = null;
  item.error = null;
}

function findStopDecisionItem(sourceItemId: string): CodexQueueItem | null {
  return state.items.find((candidate) => candidate.stopDecisionForItemId === sourceItemId) || null;
}

function findStopContinuationItem(sourceItemId: string): CodexQueueItem | null {
  return state.items.find((candidate) => candidate.continuationOfItemId === sourceItemId) || null;
}

async function createStopContinuationItem(
  sourceItem: CodexQueueItem,
  decisionSessionId: string | null
): Promise<CodexQueueItem> {
  const existing = findStopContinuationItem(sourceItem.id);
  if (existing) {
    return existing;
  }

  const policy = sourceItem.stopPolicy;
  if (!policy?.triggeredAt) {
    throw new Error('Scheduled stop trigger metadata is missing');
  }

  const resolvedSessionId = resolveQueueItemSessionId(
    decisionSessionId || sourceItem.sessionId,
    sourceItem.queueKey
  );
  const needsDraftContext = !resolvedSessionId;
  return enqueueCodexQueueItem({
    profileId: sourceItem.profileId,
    sourceProfileId: sourceItem.sourceProfileId,
    queueKey: sourceItem.queueKey,
    clientRequestId: `stop-continuation:${sourceItem.id}:${policy.triggeredAt}`,
    sessionId: resolvedSessionId,
    cwd: sourceItem.cwd,
    model: sourceItem.model,
    reasoningEffort: sourceItem.reasoningEffort,
    permissionModeId: sourceItem.permissionModeId,
    prompt: buildStoppedTaskContinuationPrompt({
      originalTask: sourceItem.prompt,
      taskHadStarted: sourceItem.attempts > 0,
    }),
    promptPreview: `המשך משימה שנעצרה · ${sourceItem.promptPreview}`,
    contextPrefix: needsDraftContext ? sourceItem.contextPrefix : null,
    sessionInstruction: sourceItem.sessionInstruction,
    actionRestriction: sourceItem.actionRestriction,
    browserMode: sourceItem.browserMode,
    personalChromeMode: sourceItem.personalChromeMode,
    designMode: sourceItem.designMode,
    uxMode: sourceItem.uxMode,
    goalMode: sourceItem.goalMode,
    forkContext: needsDraftContext ? sourceItem.forkContext : null,
    attachments: sourceItem.attachments,
    priority: STOP_CONTINUATION_PRIORITY,
    continuationOfItemId: sourceItem.id,
    agentSessionId: sourceItem.agentSessionId,
    agentId: sourceItem.agentId,
    agentLinkKind: sourceItem.agentLinkKind,
  });
}

async function resolveConditionalStopDecision(
  decisionItem: CodexQueueItem,
  finalMessage: string | null,
  decisionSessionId: string | null
) {
  if (!decisionItem.stopDecisionForItemId) {
    return;
  }

  const sourceItem = state.items.find((candidate) => candidate.id === decisionItem.stopDecisionForItemId);
  const policy = sourceItem?.stopPolicy;
  if (!sourceItem || !policy || policy.mode !== 'conditional') {
    return;
  }
  if (policy.status === 'continued' || policy.status === 'stopped' || policy.status === 'failed') {
    return;
  }

  const decision = readConditionalStopDecision(finalMessage);
  policy.decisionItemId = decisionItem.id;
  policy.resolvedAt = nowIso();
  policy.decision = decision === true;
  policy.error = null;

  if (decision !== true) {
    policy.status = 'stopped';
    policy.outcome = decision === false ? 'continue-declined' : 'invalid-decision';
    await persistState();
    return;
  }

  try {
    const continuationItem = await createStopContinuationItem(sourceItem, decisionSessionId);
    policy.continuationItemId = continuationItem.id;
    policy.status = 'continued';
    policy.outcome = 'continue-approved';
    await persistState();
  } catch (error: any) {
    policy.status = 'failed';
    policy.outcome = 'decision-failed';
    policy.error = error?.message || 'Failed to enqueue the stopped task continuation';
    await persistState();
  }
}

async function failConditionalStopDecision(decisionItem: CodexQueueItem, errorMessage: string) {
  if (!decisionItem.stopDecisionForItemId) {
    return;
  }

  const sourceItem = state.items.find((candidate) => candidate.id === decisionItem.stopDecisionForItemId);
  const policy = sourceItem?.stopPolicy;
  if (!sourceItem || !policy || policy.mode !== 'conditional') {
    return;
  }
  if (policy.status === 'continued' || policy.status === 'stopped') {
    return;
  }

  policy.decisionItemId = decisionItem.id;
  policy.status = 'failed';
  policy.resolvedAt = nowIso();
  policy.decision = false;
  policy.outcome = 'decision-failed';
  policy.error = errorMessage;
}

async function ensureConditionalStopDecisionItem(sourceItem: CodexQueueItem) {
  const policy = sourceItem.stopPolicy;
  if (!policy || policy.mode !== 'conditional' || !policy.question) {
    return;
  }
  if (policy.status === 'continued' || policy.status === 'stopped' || policy.status === 'failed') {
    return;
  }

  const existing = findStopDecisionItem(sourceItem.id);
  if (existing) {
    policy.decisionItemId = existing.id;
    if (existing.status === 'completed') {
      await resolveConditionalStopDecision(existing, existing.finalMessage, existing.sessionId);
    } else if (existing.status === 'failed' || existing.status === 'cancelled') {
      await failConditionalStopDecision(
        existing,
        existing.error || 'The scheduled continuation decision did not complete successfully'
      );
      await persistState();
    } else {
      policy.status = 'awaiting-decision';
      await persistState();
    }
    return;
  }

  policy.status = 'awaiting-decision';
  await persistState();

  try {
    const decisionItem = await enqueueCodexQueueItem({
      profileId: sourceItem.profileId,
      sourceProfileId: sourceItem.sourceProfileId,
      queueKey: sourceItem.queueKey,
      clientRequestId: `stop-decision:${sourceItem.id}:${policy.triggeredAt || policy.stopAt}`,
      sessionId: resolveQueueItemSessionId(sourceItem.sessionId, sourceItem.queueKey),
      cwd: sourceItem.cwd,
      model: sourceItem.model,
      reasoningEffort: sourceItem.reasoningEffort,
      permissionModeId: sourceItem.permissionModeId,
      prompt: buildConditionalStopDecisionPrompt({
        question: policy.question,
        originalTask: sourceItem.prompt,
      }),
      promptPreview: `בדיקת המשך לאחר עצירה · ${policy.question}`,
      attachments: [],
      priority: STOP_DECISION_PRIORITY,
      stopDecisionForItemId: sourceItem.id,
    });
    policy.decisionItemId = decisionItem.id;
    await persistState();
  } catch (error: any) {
    policy.status = 'failed';
    policy.resolvedAt = nowIso();
    policy.decision = false;
    policy.outcome = 'decision-failed';
    policy.error = error?.message || 'Failed to enqueue the scheduled continuation decision';
    await persistState();
  }
}

async function refreshDueStopPolicies() {
  await ensureStateLoaded();

  const now = Date.now();
  let changed = false;
  const decisionSources: CodexQueueItem[] = [];

  for (const item of state.items) {
    const policy = item.stopPolicy;
    if (!policy) {
      continue;
    }

    if (
      (policy.status === 'stopping' || policy.status === 'awaiting-decision')
      && item.status === 'cancelled'
      && policy.mode === 'conditional'
    ) {
      decisionSources.push(item);
      continue;
    }

    if (policy.status !== 'armed') {
      continue;
    }

    if (isTerminalStatus(item.status)) {
      markStopPolicyNotNeeded(item);
      changed = true;
      continue;
    }

    if (new Date(policy.stopAt).getTime() > now) {
      continue;
    }

    const triggeredAt = nowIso();
    policy.triggeredAt = policy.triggeredAt || triggeredAt;
    policy.stopAttempts += 1;
    policy.lastStopAttemptAt = triggeredAt;
    policy.error = null;

    if (item.status === 'scheduled' || item.status === 'queued') {
      policy.status = 'stopping';
      markQueueItemStopped(item);
      if (policy.mode === 'hard') {
        markHardStopResolved(item);
      } else {
        decisionSources.push(item);
      }
      changed = true;
      continue;
    }

    if (item.status === 'running') {
      if (cancelAgentRun(item.id, item.profileId)) {
        item.status = 'cancelling';
        item.updatedAt = triggeredAt;
        item.error = null;
        policy.status = 'stopping';
      } else if (policy.stopAttempts < MAX_SCHEDULED_STOP_ATTEMPTS) {
        policy.status = 'armed';
        policy.error = `Stop request is retrying (${policy.stopAttempts}/${MAX_SCHEDULED_STOP_ATTEMPTS})`;
      } else {
        policy.status = 'failed';
        policy.resolvedAt = triggeredAt;
        policy.decision = false;
        policy.outcome = 'stop-failed';
        policy.error = 'The running task could not be stopped at its scheduled time';
      }
      changed = true;
      continue;
    }

    if (item.status === 'cancelling') {
      policy.status = 'stopping';
      changed = true;
    }
  }

  if (changed) {
    await persistState();
  }

  for (const sourceItem of decisionSources) {
    await ensureConditionalStopDecisionItem(sourceItem);
  }
}

async function refreshQueueState() {
  if (!stopPolicyRefreshPromise) {
    stopPolicyRefreshPromise = (async () => {
      await refreshDueStopPolicies();
      await refreshDueItems();
    })().finally(() => {
      stopPolicyRefreshPromise = null;
    });
  }

  await stopPolicyRefreshPromise;
}

function pickRunnableItems(limit: number): CodexQueueItem[] {
  if (limit <= 0) {
    return [];
  }

  const reservedQueueKeys = new Set(activeWorkerQueueKeys);
  const dueItems = state.items
    .filter((item) => item.status === 'queued')
    .sort(compareQueueExecutionOrder);

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
  activeWorkerQueueKeyByItemId.set(item.id, workerQueueKey);

  void processQueueItem(item).finally(() => {
    const currentWorkerQueueKey = activeWorkerQueueKeyByItemId.get(item.id);
    activeWorkerItemIds.delete(item.id);
    activeWorkerQueueKeys.delete(workerQueueKey);
    if (currentWorkerQueueKey) {
      activeWorkerQueueKeys.delete(currentWorkerQueueKey);
    }
    activeWorkerQueueKeyByItemId.delete(item.id);
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
  await rebindSessionContextSelection(profileId, queueKey, sessionId);
  await rebindSessionReminders(profileId, queueKey, sessionId);
  await rebindSupportSessionRecord(profileId, queueKey, sessionId).catch(() => undefined);

  for (const candidate of state.items) {
    if (candidate.queueKey !== queueKey) {
      continue;
    }

    if (candidate.sessionId && candidate.sessionId !== sessionId) {
      continue;
    }

    if (activeWorkerItemIds.has(candidate.id)) {
      const activeQueueKey = activeWorkerQueueKeyByItemId.get(candidate.id) || candidate.queueKey;
      activeWorkerQueueKeys.delete(activeQueueKey);
      activeWorkerQueueKeys.add(sessionId);
      activeWorkerQueueKeyByItemId.set(candidate.id, sessionId);
    }

    candidate.queueKey = sessionId;
    candidate.sessionId = sessionId;
  }
}

async function copySessionSidebarMetadataToRecoveredSession(
  profileId: string,
  sourceSessionId: string,
  targetSessionId: string
) {
  if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) {
    return;
  }

  const sourceSession = await getAgentSessionDetail(sourceSessionId, profileId, { tail: 1 }).catch(() => null);
  if (!sourceSession) {
    return;
  }

  const [hiddenIds, topicMap, titleMap] = await Promise.all([
    listHiddenSessionIds(profileId),
    getSessionTopicMap(profileId),
    getSessionTitleMap(profileId),
  ]);

  if (hiddenIds.has(sourceSessionId)) {
    await setSessionHidden(profileId, targetSessionId, true);
  }

  const sourceTopic = topicMap[sourceSessionId];
  if (sourceTopic) {
    await setSessionTopic(profileId, targetSessionId, sourceTopic.id, sourceSession.cwd || sourceTopic.cwd);
  }

  const sourceTitle = titleMap[sourceSessionId];
  if (sourceTitle) {
    await setSessionCustomTitle(profileId, targetSessionId, sourceTitle);
  }
}

async function persistPlannerOutputFromDisk(item: CodexQueueItem, sessionId: string) {
  if (!item.agentSessionId || item.agentLinkKind !== 'planner') {
    return;
  }

  const record = await getAgentSessionRecord(item.agentSessionId);
  if (!record) {
    throw new Error('Agent session draft was not found while saving planner output');
  }

  const rawPlan = await fs.readFile(record.planPath, 'utf-8').catch((error: any) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`Agent planner did not create the required plan file: ${record.planPath}`);
    }
    throw error;
  });
  const parsedPlan = JSON.parse(rawPlan);
  const savedRecord = await saveAgentSessionPlan(item.agentSessionId, parsedPlan, {
    plannerSessionId: sessionId,
    plannerProfileId: item.profileId,
  });

  await recordAgentSessionLinkedSession({
    sessionId,
    agentSessionId: savedRecord.id,
    sourceProfileId: item.sourceProfileId || savedRecord.sourceProfileId,
    profileId: item.profileId,
    provider: savedRecord.plannerProvider,
    kind: 'planner',
    agentId: null,
    createdAt: nowIso(),
  });
}

async function recordAgentRuntimeCompletion(
  item: CodexQueueItem,
  sessionId: string,
  finalMessage: string
) {
  if (!item.agentSessionId || item.agentLinkKind !== 'agent' || !item.agentId) {
    return;
  }

  await recordAgentSessionLinkedSession({
    sessionId,
    agentSessionId: item.agentSessionId,
    sourceProfileId: item.sourceProfileId || item.profileId,
    profileId: item.profileId,
    provider: getProviderForQueueItem(item.profileId),
    kind: 'agent',
    agentId: item.agentId,
    createdAt: nowIso(),
  });
  await updateAgentRuntimeStatus(item.agentSessionId, item.agentId, {
    runtimeStatus: 'completed',
    linkedSessionId: sessionId,
    queueItemId: item.id,
    lastMessage: finalMessage,
    lastError: null,
  });
}

function getProviderForQueueItem(profileId: string): 'codex' | 'claude' | 'gemini' {
  if (profileId.startsWith('agent-claude') || profileId.startsWith('support-claude') || profileId.startsWith('claude-')) {
    return 'claude';
  }
  if (profileId.startsWith('agent-gemini') || profileId.startsWith('support-gemini') || profileId.startsWith('gemini-')) {
    return 'gemini';
  }
  return 'codex';
}

async function processQueueItem(item: CodexQueueItem) {
  const reboundSessionId = resolveQueueItemSessionId(item.sessionId, item.queueKey);
  if (reboundSessionId && item.sessionId !== reboundSessionId) {
    item.sessionId = reboundSessionId;
  }

  item.status = 'running';
  item.startedAt = nowIso();
  item.updatedAt = item.startedAt;
  item.error = null;
  item.attempts += 1;
  await persistState();

  if (item.agentSessionId && item.agentLinkKind === 'agent' && item.agentId) {
    await updateAgentRuntimeStatus(item.agentSessionId, item.agentId, {
      runtimeStatus: 'running',
      queueItemId: item.id,
      lastError: null,
    });
  }

  const resolvedSessionId = resolveQueueItemSessionId(item.sessionId, item.queueKey) || undefined;
  const shouldApplyForkPromptPrefix = isDraftSessionKey(item.sessionId) || isDraftSessionKey(item.queueKey);
  const promptWithForkContext = shouldApplyForkPromptPrefix && item.contextPrefix
    ? `${item.contextPrefix}\n\nהודעת ההמשך החדשה:\n${item.prompt}`
    : item.prompt;
  const runPrompt = item.sessionInstruction
    ? `${promptWithForkContext}\n\nהוראה קבועה לסשן זה. יש ליישם אותה גם אם המשתמש לא חזר עליה בהודעה הנוכחית:\n${item.sessionInstruction}`
    : promptWithForkContext;
  const restrictionPrompt = item.actionRestriction?.enabled
    ? buildActionRestrictionPromptAdditions(item.actionRestriction)
    : null;
  const browserModePrompt = item.browserMode
    ? buildSessionBrowserModePromptAdditions(item.browserMode)
    : null;
  const personalChromeModePrompt = item.personalChromeMode
    ? buildSessionPersonalChromePromptAdditions(item.personalChromeMode)
    : null;
  const designModePrompt = item.designMode
    ? buildSessionDesignModePromptAdditions(item.designMode)
    : null;
  const uxModePrompt = item.uxMode
    ? buildSessionUxModePromptAdditions(item.uxMode)
    : null;
  const effectiveRunPrompt = [
    runPrompt,
    restrictionPrompt?.trim() || null,
    browserModePrompt?.trim() || null,
    personalChromeModePrompt?.trim() || null,
    designModePrompt?.trim() || null,
    uxModePrompt?.trim() || null,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n');
  const executionConfig: CodexExecutionConfig = {
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    permissionModeId: item.permissionModeId,
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
      effectiveRunPrompt,
      resolvedSessionId,
      item.profileId,
      item.attachments,
      {
        runId: item.id,
        cwd: item.cwd || undefined,
        injectDirectoryContext: !resolvedSessionId,
        executionConfig,
        actionRestriction: item.actionRestriction,
        browserMode: item.browserMode,
        browserModeProfileId: item.sourceProfileId || item.profileId,
        browserModeSessionKey: resolvedSessionId || item.queueKey,
        personalChromeMode: item.personalChromeMode,
        personalChromeModeProfileId: item.sourceProfileId || item.profileId,
        personalChromeModeSessionKey: resolvedSessionId || item.queueKey,
        designMode: item.designMode,
        designModeProfileId: item.sourceProfileId || item.profileId,
        designModeSessionKey: resolvedSessionId || item.queueKey,
        uxMode: item.uxMode,
        uxModeProfileId: item.sourceProfileId || item.profileId,
        uxModeSessionKey: resolvedSessionId || item.queueKey,
        finalNotification: {
          profileId: item.sourceProfileId || item.profileId,
          sessionKey: resolvedSessionId || item.queueKey,
          dedupeKey: isRecurringItem(item)
            ? `${item.id}:${item.startedAt || item.attempts}`
            : item.id,
        },
      }
    );

    if (resolvedSessionId && result.sessionId !== resolvedSessionId) {
      await copySessionSidebarMetadataToRecoveredSession(item.profileId, resolvedSessionId, result.sessionId);
      await rebindSessionBrowserMode(item.sourceProfileId || item.profileId, resolvedSessionId, result.sessionId);
      await rebindSessionPersonalChromeMode(item.sourceProfileId || item.profileId, resolvedSessionId, result.sessionId);
      await rebindSessionDesignMode(item.sourceProfileId || item.profileId, resolvedSessionId, result.sessionId);
      await rebindSessionUxMode(item.sourceProfileId || item.profileId, resolvedSessionId, result.sessionId);
    }

    await rebindSessionFinalNotificationPreference(
      item.sourceProfileId || item.profileId,
      resolvedSessionId || item.queueKey,
      result.sessionId
    );
    await rebindQueueItemsToSession(item.profileId, item.queueKey, result.sessionId);
    await rebindSessionBrowserMode(item.sourceProfileId || item.profileId, item.queueKey, result.sessionId);
    await rebindSessionPersonalChromeMode(item.sourceProfileId || item.profileId, item.queueKey, result.sessionId);
    await rebindSessionDesignMode(item.sourceProfileId || item.profileId, item.queueKey, result.sessionId);
    await rebindSessionUxMode(item.sourceProfileId || item.profileId, item.queueKey, result.sessionId);
    if (item.browserMode && item.browserMode.enabled !== true) {
      await consumeSessionBrowserModeAfterDispatch(item.sourceProfileId || item.profileId, result.sessionId);
    }
    if (item.personalChromeMode && item.personalChromeMode.enabled !== true) {
      await consumeSessionPersonalChromeModeAfterDispatch(item.sourceProfileId || item.profileId, result.sessionId);
    }
    if (item.designMode && item.designMode.enabled !== true) {
      await consumeSessionDesignModeAfterDispatch(item.sourceProfileId || item.profileId, result.sessionId);
    }
    if (item.uxMode && item.uxMode.enabled !== true) {
      await consumeSessionUxModeAfterDispatch(item.sourceProfileId || item.profileId, result.sessionId);
    }

    if (isRecurringItem(item) && item.stopPolicy?.status === 'stopping') {
      markQueueItemStopped(item);
      if (item.stopPolicy.mode === 'hard') {
        markHardStopResolved(item);
      }
      await persistState();
      if (item.stopPolicy.mode === 'conditional') {
        await ensureConditionalStopDecisionItem(item);
      }
      return;
    }

    if (isRecurringItem(item)) {
      applyRecurringResult(item, 'completed', {
        sessionId: result.sessionId,
        finalMessage: result.finalMessage,
      });
      if (item.agentLinkKind === 'planner') {
        await persistPlannerOutputFromDisk(item, result.sessionId);
      } else if (item.agentLinkKind === 'agent') {
        await recordAgentRuntimeCompletion(item, result.sessionId, result.finalMessage);
      }
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
    markStopPolicyNotNeeded(item);
    state.sessionBindings[item.queueKey] = result.sessionId;
    if (item.agentLinkKind === 'planner') {
      await persistPlannerOutputFromDisk(item, result.sessionId);
    } else if (item.agentLinkKind === 'agent') {
      await recordAgentRuntimeCompletion(item, result.sessionId, result.finalMessage);
    }
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
    if (item.goalMode && isGoalModeFinished(result.finalMessage)) {
      cancelRemainingGoalModeItems(item);
    }
    if (item.stopDecisionForItemId) {
      await resolveConditionalStopDecision(item, result.finalMessage, result.sessionId);
    }
    await persistState();
  } catch (error: any) {
    if (isAgentRunCancelledError(error)) {
      markQueueItemStopped(item);
      if (item.stopPolicy?.status === 'stopping') {
        if (item.stopPolicy.mode === 'hard') {
          markHardStopResolved(item);
        }
      }
      if (item.agentSessionId && item.agentLinkKind === 'agent' && item.agentId) {
        await updateAgentRuntimeStatus(item.agentSessionId, item.agentId, {
          runtimeStatus: 'cancelled',
          queueItemId: item.id,
          lastError: null,
        });
      }
      if (item.stopDecisionForItemId) {
        await failConditionalStopDecision(item, 'The scheduled continuation decision was cancelled');
      }
      await persistState();
      if (item.stopPolicy?.status === 'stopping' && item.stopPolicy.mode === 'conditional') {
        await ensureConditionalStopDecisionItem(item);
      }
      return;
    }

    if (item.stopPolicy?.status === 'stopping') {
      markQueueItemStopped(item);
      if (item.stopPolicy.mode === 'hard') {
        markHardStopResolved(item);
      }
      await persistState();
      if (item.stopPolicy.mode === 'conditional') {
        await ensureConditionalStopDecisionItem(item);
      }
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
    markStopPolicyNotNeeded(item);
    if (item.agentSessionId && item.agentLinkKind === 'agent' && item.agentId) {
      await updateAgentRuntimeStatus(item.agentSessionId, item.agentId, {
        runtimeStatus: 'failed',
        queueItemId: item.id,
        lastError: item.error,
      });
    }
    if (item.stopDecisionForItemId) {
      await failConditionalStopDecision(item, item.error || 'The scheduled continuation decision failed');
    }
    await persistState();
  }
}

async function tickWorker() {
  if (workerTickInFlight) {
    return;
  }

  workerTickInFlight = true;

  try {
    await refreshQueueState();

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
  if (QUEUE_EXECUTION_DISABLED) {
    return;
  }

  setTimeout(() => {
    void tickWorker();
  }, 0);
}

export async function startCodexQueueWorker() {
  await ensureStateLoaded();

  if (workerStarted || QUEUE_EXECUTION_DISABLED) {
    return;
  }

  workerStarted = true;
  workerInterval = setInterval(() => {
    void tickWorker();
  }, WORKER_POLL_MS);
  workerInterval.unref?.();
  scheduleImmediateTick();
}

export async function shutdownCodexQueueWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  workerStarted = false;
  await persistTail.catch(() => undefined);
}

export async function listCodexQueueItems(profileId?: string): Promise<CodexQueueItem[]> {
  await refreshQueueState();

  const filtered = profileId
    ? state.items.filter((item) => item.profileId === profileId)
    : state.items;

  return sortQueueItems(filtered).map(cloneQueueItem);
}

export async function getCodexQueueItem(itemId: string): Promise<CodexQueueItem | null> {
  await refreshQueueState();
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
  const resolvedSessionId = resolveQueueItemSessionId(
    input.sessionId || null,
    input.queueKey
  );
  const item: CodexQueueItem = {
    id: randomUUID(),
    profileId: input.profileId,
    sourceProfileId: typeof input.sourceProfileId === 'string' && input.sourceProfileId.trim()
      ? input.sourceProfileId.trim()
      : null,
    queueKey: input.queueKey,
    clientRequestId,
    sessionId: resolvedSessionId,
    cwd: input.cwd?.trim() || null,
    model: typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : null,
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()
      ? input.reasoningEffort.trim()
      : null,
    permissionModeId: typeof input.permissionModeId === 'string' && input.permissionModeId.trim()
      ? input.permissionModeId.trim()
      : null,
    prompt: input.prompt.trim(),
    promptPreview: typeof input.promptPreview === 'string' && input.promptPreview.trim()
      ? input.promptPreview.trim()
      : trimPreview(input.prompt),
    contextPrefix: typeof input.contextPrefix === 'string' && input.contextPrefix.trim()
      ? input.contextPrefix.trim()
      : null,
    sessionInstruction: typeof input.sessionInstruction === 'string' && input.sessionInstruction.trim()
      ? input.sessionInstruction
      : null,
    actionRestriction: normalizeActionRestriction(input.actionRestriction),
    browserMode: normalizeBrowserMode(input.browserMode),
    personalChromeMode: normalizePersonalChromeMode(input.personalChromeMode),
    designMode: normalizeDesignMode(input.designMode),
    uxMode: normalizeUxMode(input.uxMode),
    goalMode: normalizeGoalMode(input.goalMode),
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
    agentSessionId: typeof input.agentSessionId === 'string' && input.agentSessionId.trim()
      ? input.agentSessionId.trim()
      : null,
    agentId: typeof input.agentId === 'string' && input.agentId.trim()
      ? input.agentId.trim()
      : null,
    agentLinkKind: input.agentLinkKind === 'planner' || input.agentLinkKind === 'agent'
      ? input.agentLinkKind
      : null,
    priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
    stopPolicy: normalizeCodexQueueStopPolicy(input.stopPolicy),
    stopDecisionForItemId: typeof input.stopDecisionForItemId === 'string' && input.stopDecisionForItemId.trim()
      ? input.stopDecisionForItemId.trim()
      : null,
    continuationOfItemId: typeof input.continuationOfItemId === 'string' && input.continuationOfItemId.trim()
      ? input.continuationOfItemId.trim()
      : null,
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

export async function setCodexQueueItemStopSchedule(
  itemId: string,
  input: {
    stopAt: string;
    mode: CodexQueueStopMode;
    question?: string | null;
  }
): Promise<CodexQueueItem> {
  await ensureStateLoaded();
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error('Queue item was not found');
  }
  if (item.status !== 'scheduled' && item.status !== 'queued' && item.status !== 'running') {
    throw new Error('A stop schedule can be set only for a waiting or running task');
  }
  if (item.stopDecisionForItemId) {
    throw new Error('A stop schedule cannot be set on a continuation decision task');
  }

  item.stopPolicy = createCodexQueueStopPolicy(input);
  item.updatedAt = nowIso();
  await persistState();
  scheduleImmediateTick();
  return cloneQueueItem(item);
}

export async function clearCodexQueueItemStopSchedule(itemId: string): Promise<CodexQueueItem> {
  await ensureStateLoaded();
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error('Queue item was not found');
  }
  if (!item.stopPolicy) {
    return cloneQueueItem(item);
  }
  if (item.stopPolicy.status !== 'armed') {
    throw new Error('A stop schedule cannot be removed after its stop process has started');
  }

  item.stopPolicy = null;
  item.updatedAt = nowIso();
  await persistState();
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

    item.stopPolicy = null;
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
  item.stopPolicy = null;
  item.updatedAt = nowIso();
  item.completedAt = item.updatedAt;
  if (item.stopDecisionForItemId) {
    await failConditionalStopDecision(item, 'The scheduled continuation decision was cancelled');
  }
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
  if (item.stopPolicy) {
    item.stopPolicy = null;
  }
  if (item.stopDecisionForItemId) {
    const sourceItem = state.items.find((candidate) => candidate.id === item.stopDecisionForItemId);
    if (sourceItem?.stopPolicy?.mode === 'conditional') {
      sourceItem.stopPolicy.status = 'awaiting-decision';
      sourceItem.stopPolicy.resolvedAt = null;
      sourceItem.stopPolicy.decision = null;
      sourceItem.stopPolicy.outcome = null;
      sourceItem.stopPolicy.error = null;
    }
  }
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
