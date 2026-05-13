import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import {
  getForkDraftSession,
  getForkSessionMetadata,
  listForkDraftSessions,
  type CodexForkDraftSession,
  type CodexForkSessionMetadata,
} from './codexForkSessions.js';
import type { CodexSessionTopic } from './codexSessionTopics.js';
import { listHiddenSessionIds } from './codexSessionVisibility.js';
import { getSessionTopicMap } from './codexSessionTopics.js';

export interface CodexProfile {
  id: string;
  label: string;
  provider: AppProvider;
  mode?: 'standard' | 'support';
  codexHome: string;
  workspaceCwd: string;
  sourceProfileId?: string;
  sandboxCwd?: string;
  defaultProfile?: boolean;
}

export interface CodexUploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  isImage: boolean;
}

export interface CodexSessionMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: 'prompt' | 'commentary' | 'final' | 'transfer';
  text: string;
  timestamp: string;
}

export interface CodexTimelineEntry {
  id: string;
  entryType: 'message' | 'tool' | 'status';
  timestamp: string;
  role?: 'user' | 'assistant';
  kind?: 'prompt' | 'commentary' | 'final' | 'transfer';
  text?: string;
  toolName?: string;
  title?: string;
  subtitle?: string | null;
  callId?: string | null;
  status?: string | null;
  exitCode?: number | null;
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string | null;
  profileId: string;
  cwd: string | null;
  messageCount: number;
  preview: string;
  startPreview: string;
  endPreview: string;
  path: string;
  source: string;
  hidden?: boolean;
  topic?: CodexSessionTopic | null;
  forkSourceSessionId?: string | null;
  forkEntryId?: string | null;
  isDraft?: boolean;
  isCompactClone?: boolean;
  compactSourceSessionId?: string | null;
}

export interface CodexSessionDetail extends CodexSessionSummary {
  cwd: string | null;
  modelProvider: string | null;
  messages: CodexSessionMessage[];
  timeline: CodexTimelineEntry[];
  totalTimelineEntries: number;
  timelineWindowStart: number;
  timelineWindowEnd: number;
  hasEarlierTimeline: boolean;
  forkDraftContext?: CodexForkDraftSession | null;
}

interface SessionScanRecord {
  id: string;
  path: string;
  updatedAt: string;
  createdAt: string | null;
  cwd: string | null;
  modelProvider: string | null;
  source: string;
  forkedFromId: string | null;
}

interface SessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface PersistedRecoveredQueueState {
  items?: unknown[];
}

interface RecoveredQueueItem {
  profileId: string;
  sessionId: string;
  cwd: string | null;
  prompt: string;
  status: 'scheduled' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  scheduleMode: 'once' | 'recurring';
  recurringFrequency: 'daily' | 'weekly' | null;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  finalMessage: string | null;
  error: string | null;
}

interface RecoveredQueueSession {
  id: string;
  profileId: string;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string;
  items: RecoveredQueueItem[];
}

interface ParsedSession {
  title: string;
  messages: CodexSessionMessage[];
  preview: string;
  timeline: CodexTimelineEntry[];
  isCompactClone?: boolean;
  compactSourceSessionId?: string | null;
}

interface SessionSummaryHints {
  title: string;
  preview: string;
  startPreview: string;
  endPreview: string;
  isCompactClone?: boolean;
  compactSourceSessionId?: string | null;
}

interface CodexRunResult {
  sessionId: string;
  finalMessage: string;
}

export interface CodexExecutionConfig {
  model: string | null;
  reasoningEffort: string | null;
}

export interface CodexReasoningLevelOption {
  effort: string;
  description: string | null;
}

export interface CodexAvailableModel {
  slug: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: CodexReasoningLevelOption[];
  isConfiguredDefault: boolean;
}

export interface CodexPermissionSnapshot {
  accessLevel: 'full' | 'balanced' | 'restricted';
  accessLabel: string;
  modeLabel: string;
  summary: string;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
}

export interface CodexModelCatalog {
  models: CodexAvailableModel[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  permissions: CodexPermissionSnapshot | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
  resetsAtIso: string | null;
}

export interface CodexContextUsageSnapshot {
  modelContextWindow: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  usagePercent: number | null;
}

export interface CodexRateLimitSnapshot {
  profileId: string;
  sessionId: string | null;
  updatedAt: string | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  context: CodexContextUsageSnapshot | null;
}

interface RawCodexDebugModelsResponse {
  models?: Array<{
    slug?: string;
    display_name?: string;
    description?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{
      effort?: string;
      description?: string;
    }>;
    visibility?: string;
  }>;
}

interface RawSessionMetaPayload {
  id?: string;
  forked_from_id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  base_instructions?: unknown;
}

interface ActiveCodexRun {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
}

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_PROFILE_ID = CODEX_APP_CONFIG.defaultProfileId;
const MAX_SESSIONS = 80;
const MAX_TOOL_TEXT = 12_000;
export const CODEX_UPLOAD_ROOT = CODEX_APP_CONFIG.uploadRoot;
const QUEUE_STATE_FILE = path.join(CODEX_APP_CONFIG.queueRoot, 'state.json');

const CANDIDATE_PROFILES: CodexProfile[] = CODEX_APP_CONFIG.profiles.filter((profile) => profile.provider === 'codex');

const queueTails = new Map<string, Promise<void>>();
const activeCodexRuns = new Map<string, ActiveCodexRun>();
const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const modelCatalogCache = new Map<string, {
  expiresAt: number;
  models: CodexAvailableModel[];
}>();

function getProviderDisplayLabel(provider: AppProvider): string {
  if (provider === 'claude') {
    return 'Claude';
  }

  if (provider === 'gemini') {
    return 'Gemini';
  }

  return 'Codex';
}

function buildStartedTaskTitle(provider: AppProvider): string {
  return `${getProviderDisplayLabel(provider)} התחיל את המשימה`;
}

function isTransferForkMetadata(metadata: CodexForkSessionMetadata | null | undefined): metadata is CodexForkSessionMetadata & {
  transferSourceProvider: AppProvider;
  transferTargetProvider: AppProvider;
} {
  return Boolean(
    metadata
    && metadata.transferSourceProvider
    && metadata.transferTargetProvider
  );
}

function buildTransferDisplayText(
  metadata: CodexForkSessionMetadata & {
    transferSourceProvider: AppProvider;
    transferTargetProvider: AppProvider;
  }
): string {
  const sourceProviderLabel = getProviderDisplayLabel(metadata.transferSourceProvider);
  const targetProviderLabel = getProviderDisplayLabel(metadata.transferTargetProvider);

  return [
    `מה נכתב ל-${targetProviderLabel} לפני כל הצ'אט:`,
    metadata.sourceCwd ? `אתה קורא עכשיו את הוורקספייס: ${metadata.sourceCwd}` : 'אתה קורא עכשיו את הוורקספייס הפעיל של השיחה.',
    '[כל הצ\'אט]',
    `עד כאן השיחה עם ${sourceProviderLabel} ועכשיו תורך. המשך מאותה שיחה באופן טבעי, בלי לסכם אותה מחדש.`,
  ].join('\n');
}

export class CodexRunCancelledError extends Error {
  constructor(message = 'Codex run was stopped') {
    super(message);
    this.name = 'CodexRunCancelledError';
  }
}

function trimPreview(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function parseCompactClonePrompt(text: string): {
  sourceSessionId: string | null;
  threadTitle: string | null;
} | null {
  const normalized = text.trim();
  if (!normalized.startsWith('Compact clone of session ')) {
    return null;
  }

  const sourceSessionId = normalized.match(/^Compact clone of session\s+([0-9a-f-]+)/i)?.[1] || null;
  const threadTitle = normalized.match(/^- Thread:\s+(.+)$/m)?.[1]?.trim() || null;

  return {
    sourceSessionId,
    threadTitle,
  };
}

function clipLongText(text: string, limit = MAX_TOOL_TEXT): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}\n…`;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function normalizeExecutionSettingValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildCodexProcessEnv(profile: CodexProfile): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.dirname(profile.codexHome),
    CODEX_HOME: profile.codexHome,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  };
}

function buildFallbackCodexProcessEnv(profile: CodexProfile): NodeJS.ProcessEnv {
  const fallbackCodexHome = path.join(CODEX_APP_CONFIG.storageRoot, 'model-catalog-fallback', profile.id);

  return {
    ...process.env,
    HOME: path.dirname(fallbackCodexHome),
    CODEX_HOME: fallbackCodexHome,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  };
}

const BENIGN_CODEX_STDERR_PATTERNS = [
  /^WARNING: proceeding, even though we could not update PATH:.*$/gim,
  /^Reading additional input from stdin\.\.\.$/gim,
];

function stripBenignCodexStderr(text: string): string {
  let sanitized = text || '';

  for (const pattern of BENIGN_CODEX_STDERR_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }

  return sanitized
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildCodexHomeRepairCommand(profile: CodexProfile): string {
  const currentUser = process.env.USER?.trim() || '$(whoami)';
  return `sudo chown -R ${currentUser}:${currentUser} ${profile.codexHome}`;
}

function sanitizeCodexCliFailure(profile: CodexProfile, rawText: string, fallbackMessage: string): string {
  const sanitized = stripBenignCodexStderr(rawText);
  const failureText = sanitized || rawText || fallbackMessage;

  if (
    /Failed to create session|Codex cannot access session files|Failed to read config file|Permission denied|Operation not permitted|os error 13/i
      .test(failureText)
  ) {
    const currentUser = process.env.USER?.trim() || 'current server user';
    return [
      `Codex profile "${profile.label}" cannot use ${profile.codexHome} because that Codex home is not writable/owned correctly for the server user "${currentUser}".`,
      `Fix once with: ${buildCodexHomeRepairCommand(profile)}`,
    ].join(' ');
  }

  return failureText;
}

function shouldRetryModelCatalogLoad(result: ReturnType<typeof spawnSync>) {
  const failureText = [
    result.error?.message || '',
    stripBenignCodexStderr(result.stderr || ''),
    result.stdout || '',
  ].join('\n');

  return /Failed to read config file|Permission denied|os error 13|config\.toml/i.test(failureText);
}

function readRootTomlString(rawToml: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedMatch = rawToml.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`, 'm'));
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const bareMatch = rawToml.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*([^\\s#]+)`, 'm'));
  return bareMatch?.[1]?.trim() || null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkJsonlFiles(rootDir: string): Promise<string[]> {
  if (!(await pathExists(rootDir))) {
    return [];
  }

  const stack = [rootDir];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function readFirstLine(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      return line;
    }
    return '';
  } finally {
    lineReader.close();
    stream.destroy();
  }
}

async function readFileChunk(filePath: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readFileHead(filePath: string, maxBytes = 24 * 1024): Promise<string[]> {
  const chunk = await readFileChunk(filePath, 0, maxBytes);
  return chunk.split('\n');
}

async function readFileTail(filePath: string, maxBytes = 48 * 1024): Promise<string[]> {
  const stats = await fs.stat(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const chunk = await readFileChunk(filePath, start, maxBytes);
  const lines = chunk.split('\n');
  if (start > 0) {
    lines.shift();
  }
  return lines;
}

async function loadSessionIndexMap(profile: CodexProfile): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = path.join(profile.codexHome, 'session_index.jsonl');
  const indexMap = new Map<string, SessionIndexEntry>();

  if (!(await pathExists(indexPath))) {
    return indexMap;
  }

  const content = await fs.readFile(indexPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = safeJsonParse<SessionIndexEntry>(trimmed);
    if (!row?.id) continue;
    indexMap.set(row.id, row);
  }

  return indexMap;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function sanitizeRecoveredQueueItem(value: unknown): RecoveredQueueItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const profileId = typeof candidate.profileId === 'string' ? candidate.profileId.trim() : '';
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';

  if (!profileId || !sessionId || !prompt || sessionId.startsWith('draft:')) {
    return null;
  }

  const createdAt = normalizeIsoTimestamp(candidate.createdAt)
    || normalizeIsoTimestamp(candidate.scheduledAt)
    || normalizeIsoTimestamp(candidate.updatedAt)
    || new Date(0).toISOString();
  const updatedAt = normalizeIsoTimestamp(candidate.updatedAt)
    || normalizeIsoTimestamp(candidate.completedAt)
    || createdAt;
  const scheduledAt = normalizeIsoTimestamp(candidate.scheduledAt);
  const startedAt = normalizeIsoTimestamp(candidate.startedAt);
  const completedAt = normalizeIsoTimestamp(candidate.completedAt);
  const status = candidate.status === 'scheduled'
    || candidate.status === 'queued'
    || candidate.status === 'running'
    || candidate.status === 'cancelling'
    || candidate.status === 'completed'
    || candidate.status === 'failed'
    || candidate.status === 'cancelled'
    ? candidate.status
    : 'queued';

  return {
    profileId,
    sessionId,
    cwd: typeof candidate.cwd === 'string' && candidate.cwd.trim() ? candidate.cwd.trim() : null,
    prompt,
    status,
    scheduleMode: candidate.scheduleMode === 'recurring' ? 'recurring' : 'once',
    recurringFrequency: candidate.recurringFrequency === 'daily' || candidate.recurringFrequency === 'weekly'
      ? candidate.recurringFrequency
      : null,
    createdAt,
    updatedAt,
    scheduledAt,
    startedAt,
    completedAt,
    finalMessage: typeof candidate.finalMessage === 'string' && candidate.finalMessage.trim()
      ? candidate.finalMessage.trim()
      : null,
    error: typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error.trim() : null,
  };
}

async function loadRecoveredQueueSessions(profile: CodexProfile): Promise<Map<string, RecoveredQueueSession>> {
  if (!(await pathExists(QUEUE_STATE_FILE))) {
    return new Map();
  }

  const raw = await fs.readFile(QUEUE_STATE_FILE, 'utf-8');
  const parsed = safeJsonParse<PersistedRecoveredQueueState>(raw);
  const recovered = new Map<string, RecoveredQueueSession>();

  for (const entry of parsed?.items || []) {
    const item = sanitizeRecoveredQueueItem(entry);
    if (!item || item.profileId !== profile.id) {
      continue;
    }

    const current = recovered.get(item.sessionId) || {
      id: item.sessionId,
      profileId: item.profileId,
      cwd: item.cwd,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      items: [],
    };

    current.items.push(item);
    current.cwd = current.cwd || item.cwd;
    current.createdAt = !current.createdAt || item.createdAt < current.createdAt ? item.createdAt : current.createdAt;
    current.updatedAt = item.updatedAt > current.updatedAt ? item.updatedAt : current.updatedAt;
    recovered.set(item.sessionId, current);
  }

  for (const session of recovered.values()) {
    session.items.sort((left, right) => {
      const leftAnchor = left.createdAt || left.scheduledAt || left.updatedAt;
      const rightAnchor = right.createdAt || right.scheduledAt || right.updatedAt;
      return leftAnchor.localeCompare(rightAnchor) || left.updatedAt.localeCompare(right.updatedAt);
    });
    session.createdAt = session.items[0]?.createdAt || session.createdAt;
    session.updatedAt = session.items.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      session.updatedAt
    );
  }

  return recovered;
}

function buildRecoveredQueueParsedSession(
  sessionId: string,
  recovered: RecoveredQueueSession,
  indexEntry?: SessionIndexEntry
): ParsedSession {
  const messages: CodexSessionMessage[] = [];
  const timeline: CodexTimelineEntry[] = [];
  let derivedTitle = indexEntry?.thread_name?.trim() || '';
  let preview = '';

  const pushStatus = (
    timestamp: string | null,
    title: string,
    status: string,
    subtitle?: string | null
  ) => {
    if (!timestamp) {
      return;
    }

    timeline.push({
      id: `${sessionId}-recovered-status-${timeline.length}`,
      entryType: 'status',
      timestamp,
      title,
      subtitle: subtitle || null,
      status,
    });
  };

  for (const item of recovered.items) {
    const promptTimestamp = item.createdAt || item.scheduledAt || item.updatedAt;
    const promptEntryId = `${sessionId}-user-${messages.length}`;

    messages.push({
      id: promptEntryId,
      role: 'user',
      kind: 'prompt',
      text: item.prompt,
      timestamp: promptTimestamp,
    });

    timeline.push({
      id: promptEntryId,
      entryType: 'message',
      role: 'user',
      kind: 'prompt',
      text: item.prompt,
      timestamp: promptTimestamp,
    });

    if (!derivedTitle) {
      derivedTitle = trimPreview(item.prompt, 72);
    }

    if (item.startedAt) {
      pushStatus(item.startedAt, buildStartedTaskTitle('codex'), 'started');
    }

    if (item.finalMessage) {
      const assistantTimestamp = item.completedAt || item.updatedAt;
      const assistantEntryId = `${sessionId}-assistant-${messages.length}`;

      messages.push({
        id: assistantEntryId,
        role: 'assistant',
        kind: 'final',
        text: item.finalMessage,
        timestamp: assistantTimestamp,
      });

      timeline.push({
        id: assistantEntryId,
        entryType: 'message',
        role: 'assistant',
        kind: 'final',
        text: item.finalMessage,
        timestamp: assistantTimestamp,
      });

      preview = item.finalMessage;
    }

    if (item.status === 'completed') {
      pushStatus(item.completedAt || item.updatedAt, 'המשימה הושלמה', 'completed');
      continue;
    }

    if (item.status === 'failed') {
      pushStatus(item.completedAt || item.updatedAt, 'המשימה נכשלה', 'failed', item.error);
      continue;
    }

    if (item.status === 'cancelled') {
      pushStatus(item.completedAt || item.updatedAt, 'המשימה בוטלה', 'cancelled');
      continue;
    }

    if (item.status === 'cancelling') {
      pushStatus(item.updatedAt, 'ביטול בתהליך', 'cancelling');
    }
  }

  if (!preview) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    preview = lastAssistant?.text || messages[messages.length - 1]?.text || '';
  }

  return {
    title: derivedTitle || `שיחת Codex ${sessionId.slice(0, 8)}`,
    messages,
    preview: trimPreview(preview || derivedTitle || sessionId),
    timeline,
    isCompactClone: false,
    compactSourceSessionId: null,
  };
}

async function scanSessionFiles(profile: CodexProfile): Promise<SessionScanRecord[]> {
  const roots = [
    path.join(profile.codexHome, 'sessions'),
    path.join(profile.codexHome, 'archived_sessions'),
  ];

  const seen = new Set<string>();
  const rows: SessionScanRecord[] = [];

  for (const rootDir of roots) {
    const files = await walkJsonlFiles(rootDir);

    for (const filePath of files) {
      const firstLine = await readFirstLine(filePath);
      const metaRow = safeJsonParse<{
        payload?: {
          id?: string;
          forked_from_id?: string;
          timestamp?: string;
          cwd?: string;
          source?: string;
          model_provider?: string;
        };
      }>(firstLine);

      const sessionId = metaRow?.payload?.id;
      if (!sessionId || seen.has(sessionId)) {
        continue;
      }

      seen.add(sessionId);
      const stats = await fs.stat(filePath);

      rows.push({
        id: sessionId,
        path: filePath,
        updatedAt: stats.mtime.toISOString(),
        createdAt: metaRow?.payload?.timestamp || null,
        cwd: metaRow?.payload?.cwd || null,
        modelProvider: metaRow?.payload?.model_provider || null,
        source: metaRow?.payload?.source || 'unknown',
        forkedFromId: metaRow?.payload?.forked_from_id || null,
      });
    }
  }

  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return rows;
}

function parseRateLimitNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const windowValue = value as {
    used_percent?: unknown;
    window_minutes?: unknown;
    resets_at?: unknown;
  };

  const usedPercent = parseRateLimitNumber(windowValue.used_percent);
  const windowMinutes = parseRateLimitNumber(windowValue.window_minutes);
  const resetsAt = parseRateLimitNumber(windowValue.resets_at);

  if (usedPercent === null && windowMinutes === null && resetsAt === null) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    resetsAtIso: resetsAt !== null ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

function parseContextUsageSnapshot(value: unknown): CodexContextUsageSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const infoValue = value as {
    model_context_window?: unknown;
    last_token_usage?: {
      input_tokens?: unknown;
      cached_input_tokens?: unknown;
    };
  };

  const modelContextWindow = parseRateLimitNumber(infoValue.model_context_window);
  const inputTokens = parseRateLimitNumber(infoValue.last_token_usage?.input_tokens);
  const cachedInputTokens = parseRateLimitNumber(infoValue.last_token_usage?.cached_input_tokens);

  if (modelContextWindow === null && inputTokens === null && cachedInputTokens === null) {
    return null;
  }

  const usagePercent = (
    modelContextWindow !== null
    && modelContextWindow > 0
    && inputTokens !== null
  )
    ? Math.min(100, Math.max(0, (inputTokens / modelContextWindow) * 100))
    : null;

  return {
    modelContextWindow,
    inputTokens,
    cachedInputTokens,
    usagePercent,
  };
}

async function readRateLimitSnapshotFromSessionRecord(
  profile: CodexProfile,
  sessionRecord: SessionScanRecord
): Promise<CodexRateLimitSnapshot | null> {
  const tailLines = await readFileTail(sessionRecord.path, 96 * 1024);

  for (const line of [...tailLines].reverse()) {
    const row = safeJsonParse<any>(line);
    if (!row || row.type !== 'event_msg') {
      continue;
    }

    const payload = row.payload || {};
    if (payload.type !== 'token_count' || !payload.rate_limits || typeof payload.rate_limits !== 'object') {
      continue;
    }

    const rateLimits = payload.rate_limits as {
      plan_type?: unknown;
      rate_limit_reached_type?: unknown;
      primary?: unknown;
      secondary?: unknown;
    };

    return {
      profileId: profile.id,
      sessionId: sessionRecord.id,
      updatedAt: sessionRecord.updatedAt || null,
      planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : null,
      rateLimitReachedType: typeof rateLimits.rate_limit_reached_type === 'string'
        ? rateLimits.rate_limit_reached_type
        : null,
      primary: parseRateLimitWindow(rateLimits.primary),
      secondary: parseRateLimitWindow(rateLimits.secondary),
      context: parseContextUsageSnapshot(payload.info),
    };
  }

  return null;
}

async function extractSessionSummaryHints(
  sessionPath: string,
  sessionId: string,
  indexEntry?: SessionIndexEntry
): Promise<SessionSummaryHints> {
  let title = indexEntry?.thread_name?.trim() || '';
  let preview = '';
  let startPreview = '';
  let endPreview = '';
  let isCompactClone = false;
  let compactSourceSessionId: string | null = null;

  const headLines = await readFileHead(sessionPath);
  for (const line of headLines) {
    const row = safeJsonParse<any>(line);
    if (!row || row.type !== 'event_msg') {
      continue;
    }

    const payload = row.payload || {};
    const eventType = payload.type;

    if (
      eventType === 'thread_name_updated'
      && typeof payload.thread_name === 'string'
      && payload.thread_name.trim()
    ) {
      title = payload.thread_name.trim();
    }

    if (eventType === 'user_message' && typeof payload.message === 'string') {
      const text = payload.message.trim();
      const compactClone = parseCompactClonePrompt(text);
      if (compactClone) {
        isCompactClone = true;
        compactSourceSessionId = compactClone.sourceSessionId;
        if (!title && compactClone.threadTitle) {
          title = trimPreview(compactClone.threadTitle, 72);
        }
      }
      if (!title) {
        title = trimPreview(text, 72);
      }
      if (!startPreview) {
        startPreview = trimPreview(text);
      }
    }
  }

  const tailLines = await readFileTail(sessionPath);
  for (const line of [...tailLines].reverse()) {
    const row = safeJsonParse<any>(line);
    if (!row || row.type !== 'event_msg') {
      continue;
    }

    const payload = row.payload || {};
    const eventType = payload.type;

    if (eventType === 'task_complete' && typeof payload.last_agent_message === 'string') {
      endPreview = trimPreview(payload.last_agent_message.trim());
      break;
    }

    if (eventType === 'agent_message' && typeof payload.message === 'string') {
      endPreview = trimPreview(payload.message.trim());
      break;
    }

    if (eventType === 'user_message' && typeof payload.message === 'string') {
      endPreview = trimPreview(payload.message.trim());
      break;
    }
  }

  preview = endPreview || startPreview || title || sessionId;

  return {
    title: title || trimPreview(startPreview || preview || `שיחת Codex ${sessionId.slice(0, 8)}`, 72),
    preview,
    startPreview: startPreview || title || sessionId,
    endPreview: endPreview || startPreview || title || sessionId,
    isCompactClone,
    compactSourceSessionId,
  };
}

function summarizeToolName(name: string): string {
  if (name === 'functions.exec_command' || name === 'exec_command') return 'Terminal';
  if (name === 'functions.write_stdin' || name === 'write_stdin') return 'Terminal Input';
  if (name === 'functions.apply_patch' || name === 'apply_patch') return 'Patch';
  if (name === 'functions.update_plan' || name === 'update_plan') return 'Plan';
  if (name === 'functions.request_user_input' || name === 'request_user_input') return 'Ask User';
  if (name === 'functions.view_image' || name === 'view_image') return 'Image Viewer';
  if (name === 'functions.spawn_agent' || name === 'spawn_agent') return 'Spawn Agent';
  if (name === 'functions.send_input' || name === 'send_input') return 'Agent Input';
  if (name === 'functions.wait_agent' || name === 'wait_agent') return 'Wait Agent';
  if (name === 'functions.close_agent' || name === 'close_agent') return 'Close Agent';
  if (name === 'exec_command') return 'Terminal';
  if (name === 'apply_patch') return 'Patch';
  if (name === 'web.search_query') return 'Web Search';
  if (name === 'web.open') return 'Web Open';
  if (name === 'multi_tool_use.parallel') return 'Parallel Tools';
  if (name.startsWith('mcp__codex_apps__adobe_photoshop.')) {
    return `Photoshop ${name.split('.').pop()?.replaceAll('_', ' ') || 'tool'}`.trim();
  }
  if (name.startsWith('mcp__codex_apps__canva.')) {
    return `Canva ${name.split('.').pop()?.replaceAll('_', ' ') || 'tool'}`.trim();
  }
  if (name.startsWith('functions.')) {
    return name.slice('functions.'.length).replaceAll('_', ' ');
  }
  return name.replaceAll('_', ' ');
}

function summarizeCommand(command: unknown): string | null {
  if (!Array.isArray(command) || command.length === 0) {
    return null;
  }

  const last = command[command.length - 1];
  if (typeof last === 'string' && last.trim()) {
    return last.trim();
  }

  return command
    .map((part) => (typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join(' ')
    .trim() || null;
}

function summarizeFunctionArguments(toolName: string, rawArguments: string | undefined): string | null {
  if (!rawArguments?.trim()) {
    return null;
  }

  const parsed = safeJsonParse<any>(rawArguments);
  if (!parsed) {
    return clipLongText(rawArguments, 1000);
  }

  if (toolName === 'exec_command' && typeof parsed.cmd === 'string') {
    return parsed.cmd;
  }

  if (toolName === 'web.search_query' && Array.isArray(parsed.search_query)) {
    return parsed.search_query.map((entry: any) => entry?.q).filter(Boolean).join(' | ');
  }

  if (toolName === 'multi_tool_use.parallel' && Array.isArray(parsed.tool_uses)) {
    return parsed.tool_uses
      .map((entry: any) => entry?.recipient_name)
      .filter(Boolean)
      .join(', ');
  }

  return clipLongText(JSON.stringify(parsed, null, 2), 1000);
}

function formatPatchChanges(changes: unknown): string | null {
  if (!Array.isArray(changes) || changes.length === 0) {
    return null;
  }

  const lines = changes.map((change: any) => {
    const pathText = change?.path || change?.file || 'unknown';
    const statusText = change?.status || 'updated';
    return `- ${statusText}: ${pathText}`;
  });

  return lines.join('\n');
}

function timelineEntryToMessage(entry: CodexTimelineEntry): CodexSessionMessage | null {
  if (entry.entryType !== 'message' || !entry.role || !entry.kind || typeof entry.text !== 'string') {
    return null;
  }

  return {
    id: entry.id,
    role: entry.role,
    kind: entry.kind,
    text: entry.text,
    timestamp: entry.timestamp,
  };
}

function buildParsedDraftSession(draft: CodexForkDraftSession): ParsedSession {
  const messages = draft.timeline
    .map((entry) => timelineEntryToMessage(entry))
    .filter((entry): entry is CodexSessionMessage => Boolean(entry));
  const compactClone = parseCompactClonePrompt(messages[0]?.text || '');

  return {
    title: trimPreview(
      draft.transferSourceProvider && draft.transferTargetProvider
        ? draft.sourceTitle
        : `מזלג: ${draft.sourceTitle}`,
      72
    ),
    messages,
    preview: trimPreview(draft.promptPreview || draft.sourceTitle),
    timeline: draft.timeline.map((entry) => ({ ...entry })),
    isCompactClone: Boolean(compactClone),
    compactSourceSessionId: compactClone?.sourceSessionId || null,
  };
}

function cloneForkDraftContext(draft: CodexForkDraftSession): CodexForkDraftSession {
  return {
    ...draft,
    timeline: draft.timeline.map((entry) => ({ ...entry })),
  };
}

function applyForkSessionOverlay(
  parsed: ParsedSession,
  metadata: CodexForkSessionMetadata | null
): ParsedSession {
  if (!metadata) {
    return parsed;
  }

  let firstPromptPatched = false;
  const overlayMessages = parsed.messages.map((message) => {
    if (!firstPromptPatched && message.role === 'user' && message.kind === 'prompt') {
      firstPromptPatched = true;
      if (isTransferForkMetadata(metadata)) {
        return {
          ...message,
          role: 'assistant',
          kind: 'transfer',
          text: buildTransferDisplayText(metadata),
        };
      }
      return {
        ...message,
        text: metadata.promptPreview || message.text,
      };
    }

    return message;
  });

  let firstTimelinePromptPatched = false;
  const overlayTimeline = parsed.timeline.map((entry) => {
    if (
      !firstTimelinePromptPatched
      && entry.entryType === 'message'
      && entry.role === 'user'
      && entry.kind === 'prompt'
    ) {
      firstTimelinePromptPatched = true;
      if (isTransferForkMetadata(metadata)) {
        return {
          ...entry,
          role: 'assistant',
          kind: 'transfer',
          text: buildTransferDisplayText(metadata),
        };
      }
      return {
        ...entry,
        text: metadata.promptPreview || entry.text,
      };
    }

    return entry;
  });

  const forkMessages = metadata.timeline
    .map((entry) => timelineEntryToMessage(entry))
    .filter((entry): entry is CodexSessionMessage => Boolean(entry));

  return {
    title: trimPreview(
      isTransferForkMetadata(metadata)
        ? metadata.sourceTitle || parsed.title
        : metadata.promptPreview || parsed.title,
      72
    ),
    preview: parsed.preview,
    messages: [...forkMessages, ...overlayMessages],
    timeline: [...metadata.timeline.map((entry) => ({ ...entry })), ...overlayTimeline],
    isCompactClone: parsed.isCompactClone,
    compactSourceSessionId: parsed.compactSourceSessionId,
  };
}

function getFirstTimelineMessageText(timeline: CodexTimelineEntry[]): string | null {
  const firstMessage = timeline.find((entry) => entry.entryType === 'message' && typeof entry.text === 'string' && entry.text.trim());
  return firstMessage?.text?.trim() || null;
}

async function parseSessionFile(
  sessionPath: string,
  sessionId: string,
  indexEntry?: SessionIndexEntry
): Promise<ParsedSession> {
  const messages: CodexSessionMessage[] = [];
  const timeline: CodexTimelineEntry[] = [];
  const knownToolCalls = new Map<string, string>();
  let derivedTitle = indexEntry?.thread_name?.trim() || '';
  let preview = '';
  let isCompactClone = false;
  let compactSourceSessionId: string | null = null;
  let lastSummaryMode: string | null = null;
  let autoSummaryRecorded = false;

  const stream = createReadStream(sessionPath, { encoding: 'utf-8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      const row = safeJsonParse<any>(line);
      if (!row) {
        continue;
      }

      if (row.type === 'turn_context') {
        const timestamp = row.timestamp || '';
        const summaryMode = typeof row.payload?.summary === 'string'
          ? row.payload.summary.trim().toLowerCase()
          : null;

        if (summaryMode) {
          if (summaryMode === 'auto' && !autoSummaryRecorded && lastSummaryMode !== 'auto') {
            timeline.push({
              id: `${sessionId}-status-auto-summary-${timeline.length}`,
              entryType: 'status',
              timestamp,
              title: 'סיכום שיחה אוטומטי הופעל',
              subtitle: 'CLI: turn_context.summary=auto',
              status: 'summary-auto',
            });
            autoSummaryRecorded = true;
          }

          lastSummaryMode = summaryMode;
        }

        continue;
      }

      if (row.type === 'event_msg') {
        const payload = row.payload || {};
        const eventType = payload.type;
        const timestamp = row.timestamp || '';

        if (
          eventType === 'thread_name_updated'
          && typeof payload.thread_name === 'string'
          && payload.thread_name.trim()
        ) {
          derivedTitle = payload.thread_name.trim();
          continue;
        }

        if (eventType === 'user_message' && typeof payload.message === 'string') {
          const text = payload.message.trim();
          const entryId = `${sessionId}-user-${messages.length}`;
          const compactClone = parseCompactClonePrompt(text);

          messages.push({
            id: entryId,
            role: 'user',
            kind: 'prompt',
            text,
            timestamp,
          });

          timeline.push({
            id: entryId,
            entryType: 'message',
            role: 'user',
            kind: 'prompt',
            text,
            timestamp,
          });

          if (compactClone) {
            isCompactClone = true;
            compactSourceSessionId = compactClone.sourceSessionId;
            timeline.push({
              id: `${sessionId}-status-compact-${timeline.length}`,
              entryType: 'status',
              timestamp,
              title: 'Compact handoff נטען',
              subtitle: compactClone.sourceSessionId ? `מקור: ${compactClone.sourceSessionId}` : 'Compact clone',
              status: 'compacted',
            });
            if (!derivedTitle && compactClone.threadTitle) {
              derivedTitle = trimPreview(compactClone.threadTitle, 72);
            }
          }

          if (!derivedTitle) {
            derivedTitle = trimPreview(text, 72);
          }
          continue;
        }

        if (eventType === 'agent_message' && typeof payload.message === 'string') {
          const text = payload.message.trim();
          const kind = payload.phase === 'commentary' ? 'commentary' : 'final';
          const entryId = `${sessionId}-assistant-${messages.length}`;

          messages.push({
            id: entryId,
            role: 'assistant',
            kind,
            text,
            timestamp,
          });

          timeline.push({
            id: entryId,
            entryType: 'message',
            role: 'assistant',
            kind,
            text,
            timestamp,
          });
          continue;
        }

        if (eventType === 'task_complete' && typeof payload.last_agent_message === 'string') {
          const text = payload.last_agent_message.trim();
          const lastMessage = messages[messages.length - 1];
          if (
            !lastMessage
            || lastMessage.role !== 'assistant'
            || lastMessage.kind !== 'final'
            || lastMessage.text !== text
          ) {
            const entryId = `${sessionId}-final-${messages.length}`;

            messages.push({
              id: entryId,
              role: 'assistant',
              kind: 'final',
              text,
              timestamp,
            });

            timeline.push({
              id: entryId,
              entryType: 'message',
              role: 'assistant',
              kind: 'final',
              text,
              timestamp,
            });
          }

          timeline.push({
            id: `${sessionId}-status-complete-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: 'המשימה הושלמה',
            subtitle: typeof payload.duration_ms === 'number'
              ? `${Math.round(payload.duration_ms / 1000)} שניות`
              : null,
            status: 'completed',
          });
          preview = text;
          continue;
        }

        if (eventType === 'task_started') {
          timeline.push({
            id: `${sessionId}-status-started-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: buildStartedTaskTitle('codex'),
            subtitle: payload.collaboration_mode_kind || null,
            status: 'started',
          });
          continue;
        }

        if (eventType === 'turn_aborted') {
          timeline.push({
            id: `${sessionId}-status-aborted-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: 'הסבב הופסק',
            subtitle: payload.reason || null,
            status: 'aborted',
          });
          continue;
        }

        if (eventType === 'exec_command_end') {
          const outputText = payload.aggregated_output || payload.stdout || payload.stderr || '';
          const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null;

          timeline.push({
            id: `${sessionId}-tool-terminal-${timeline.length}`,
            entryType: 'tool',
            timestamp,
            toolName: 'exec_command',
            title: 'Terminal',
            subtitle: summarizeCommand(payload.command) || payload.cwd || null,
            text: clipLongText(outputText || 'No terminal output.'),
            callId: payload.call_id || null,
            status: payload.status || null,
            exitCode,
          });
          continue;
        }

        if (eventType === 'patch_apply_end') {
          const outputText = [
            payload.stdout,
            payload.stderr,
            formatPatchChanges(payload.changes),
          ].filter(Boolean).join('\n\n');

          timeline.push({
            id: `${sessionId}-tool-patch-${timeline.length}`,
            entryType: 'tool',
            timestamp,
            toolName: 'apply_patch',
            title: 'Patch',
            subtitle: payload.success ? 'Applied' : payload.status || 'Patch failed',
            text: clipLongText(outputText || 'Patch completed without output.'),
            callId: payload.call_id || null,
            status: payload.status || null,
            exitCode: null,
          });
          continue;
        }

        if (eventType === 'web_search_end') {
          const action = payload.action ? JSON.stringify(payload.action, null, 2) : '';
          const text = [payload.query, action].filter(Boolean).join('\n\n');

          timeline.push({
            id: `${sessionId}-tool-web-${timeline.length}`,
            entryType: 'tool',
            timestamp,
            toolName: 'web.search',
            title: 'Web Search',
            subtitle: payload.query || null,
            text: clipLongText(text || 'Search completed.'),
            callId: payload.call_id || null,
            status: 'completed',
            exitCode: null,
          });
        }

        continue;
      }

      if (row.type !== 'response_item') {
        continue;
      }

      const payload = row.payload || {};
      const responseType = payload.type;
      const timestamp = row.timestamp || '';

      if (responseType === 'function_call') {
        const toolName = payload.name || 'tool';
        const callId = payload.call_id || null;
        if (callId) {
          knownToolCalls.set(callId, toolName);
        }

        timeline.push({
          id: `${sessionId}-tool-call-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName,
          title: summarizeToolName(toolName),
          subtitle: summarizeFunctionArguments(toolName, payload.arguments),
          text: clipLongText(payload.arguments || '', 1000),
          callId,
          status: 'queued',
          exitCode: null,
        });
        continue;
      }

      if (responseType === 'custom_tool_call') {
        const toolName = payload.name || 'custom_tool';
        const callId = payload.call_id || null;
        if (callId) {
          knownToolCalls.set(callId, toolName);
        }

        timeline.push({
          id: `${sessionId}-custom-tool-call-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName,
          title: summarizeToolName(toolName),
          subtitle: clipLongText(String(payload.status || 'Custom tool call'), 200),
          text: clipLongText(String(payload.input || ''), 1000),
          callId,
          status: payload.status || null,
          exitCode: null,
        });
        continue;
      }

      if (responseType === 'custom_tool_call_output') {
        const callId = payload.call_id || null;
        const toolName = callId ? knownToolCalls.get(callId) || 'custom_tool' : 'custom_tool';
        timeline.push({
          id: `${sessionId}-custom-tool-output-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName,
          title: `${summarizeToolName(toolName)} result`,
          subtitle: null,
          text: clipLongText(String(payload.output || ''), 4000),
          callId,
          status: 'completed',
          exitCode: null,
        });
        continue;
      }

      if (responseType === 'web_search_call') {
        const actionText = payload.action ? JSON.stringify(payload.action, null, 2) : '';
        timeline.push({
          id: `${sessionId}-web-call-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName: 'web.search',
          title: 'Web Search',
          subtitle: payload.status || null,
          text: clipLongText(actionText, 1000),
          callId: null,
          status: payload.status || null,
          exitCode: null,
        });
        continue;
      }

      if (responseType === 'function_call_output') {
        const callId = payload.call_id || null;
        const toolName = callId ? knownToolCalls.get(callId) || 'tool' : 'tool';

        if (toolName === 'exec_command' || toolName === 'apply_patch' || toolName.startsWith('web.')) {
          continue;
        }

        timeline.push({
          id: `${sessionId}-tool-output-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName,
          title: `${summarizeToolName(toolName)} result`,
          subtitle: null,
          text: clipLongText(String(payload.output || ''), 4000),
          callId,
          status: 'completed',
          exitCode: null,
        });
      }
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  if (!preview) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    preview = lastAssistant?.text || messages[messages.length - 1]?.text || '';
  }

  return {
    title: derivedTitle || `שיחת Codex ${sessionId.slice(0, 8)}`,
    messages,
    preview: trimPreview(preview || derivedTitle || sessionId),
    timeline,
    isCompactClone,
    compactSourceSessionId,
  };
}

function resolveProfile(profileId?: string): CodexProfile {
  const profile = CANDIDATE_PROFILES.find((candidate) => candidate.id === profileId)
    || CANDIDATE_PROFILES.find((candidate) => candidate.defaultProfile)
    || CANDIDATE_PROFILES[0];

  if (!profile) {
    throw new Error('No Codex profile is configured');
  }

  return profile;
}

async function resolveSessionRecord(
  profile: CodexProfile,
  sessionId: string
): Promise<SessionScanRecord | null> {
  const sessionFiles = await scanSessionFiles(profile);
  return sessionFiles.find((row) => row.id === sessionId) || null;
}

async function resolveRunCwd(profile: CodexProfile, sessionId?: string): Promise<string> {
  if (!sessionId) {
    return profile.workspaceCwd;
  }

  const sessionRecord = await resolveSessionRecord(profile, sessionId);
  return sessionRecord?.cwd || profile.workspaceCwd;
}

function buildSessionRolloutFileName(sessionId: string, timestamp = new Date()): string {
  const iso = timestamp.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return `rollout-${iso}-${sessionId}.jsonl`;
}

function buildSessionFilePath(profile: CodexProfile, sessionId: string, timestamp = new Date()): string {
  const year = String(timestamp.getUTCFullYear());
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');
  return path.join(profile.codexHome, 'sessions', year, month, day, buildSessionRolloutFileName(sessionId, timestamp));
}

async function sliceSessionLinesForFork(
  sessionPath: string,
  sourceSessionId: string,
  forkEntryId: string
): Promise<{
  sourceMeta: RawSessionMetaPayload;
  rawLines: string[];
  forkedAt: string;
}> {
  const content = await fs.readFile(sessionPath, 'utf-8');
  const rawLines = content
    .split('\n')
    .filter((line, index, lines) => line.trim() || index < lines.length - 1);

  let sourceMeta: RawSessionMetaPayload | null = null;
  let messageCount = 0;
  let matchedLineIndex = -1;
  let matchedRole: 'user' | 'assistant' | null = null;
  let matchedKind: 'prompt' | 'commentary' | 'final' | null = null;
  let matchedText = '';
  let forkedAt = '';
  let lastAssistantMessage: { kind: 'commentary' | 'final'; text: string } | null = null;

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const row = safeJsonParse<any>(line);
    if (!row) {
      continue;
    }

    if (row.type === 'session_meta' && !sourceMeta) {
      sourceMeta = { ...(row.payload || {}) };
      continue;
    }

    if (row.type !== 'event_msg') {
      continue;
    }

    const payload = row.payload || {};
    const eventType = payload.type;
    const timestamp = typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString();

    if (eventType === 'user_message' && typeof payload.message === 'string') {
      const entryId = `${sourceSessionId}-user-${messageCount}`;
      messageCount += 1;
      if (entryId === forkEntryId) {
        matchedLineIndex = index;
        matchedRole = 'user';
        matchedKind = 'prompt';
        matchedText = payload.message.trim();
        forkedAt = timestamp;
        break;
      }
      continue;
    }

    if (eventType === 'agent_message' && typeof payload.message === 'string') {
      const kind = payload.phase === 'commentary' ? 'commentary' : 'final';
      const entryId = `${sourceSessionId}-assistant-${messageCount}`;
      const text = payload.message.trim();
      messageCount += 1;
      lastAssistantMessage = { kind, text };

      if (entryId === forkEntryId) {
        matchedLineIndex = index;
        matchedRole = 'assistant';
        matchedKind = kind;
        matchedText = text;
        forkedAt = timestamp;
        break;
      }
      continue;
    }

    if (eventType === 'task_complete' && typeof payload.last_agent_message === 'string') {
      const text = payload.last_agent_message.trim();
      let entryId: string | null = null;

      if (
        !lastAssistantMessage
        || lastAssistantMessage.kind !== 'final'
        || lastAssistantMessage.text !== text
      ) {
        entryId = `${sourceSessionId}-final-${messageCount}`;
        messageCount += 1;
        lastAssistantMessage = { kind: 'final', text };
      }

      if (entryId === forkEntryId) {
        matchedLineIndex = index;
        matchedRole = 'assistant';
        matchedKind = 'final';
        matchedText = text;
        forkedAt = timestamp;
        break;
      }
    }
  }

  if (!sourceMeta?.id) {
    throw new Error('Source session metadata could not be loaded');
  }

  if (matchedLineIndex === -1) {
    throw new Error('לא ניתן לאתר את נקודת המזלוג שנבחרה.');
  }

  let cutoffIndex = matchedLineIndex;
  if (matchedRole === 'assistant') {
    for (let index = matchedLineIndex + 1; index < rawLines.length; index += 1) {
      const row = safeJsonParse<any>(rawLines[index]);
      if (
        row?.type === 'response_item'
        && row.payload?.type === 'message'
        && row.payload?.role === 'assistant'
      ) {
        const messageText = Array.isArray(row.payload?.content)
          ? row.payload.content
            .map((part: any) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
            .trim()
          : '';

        if (!messageText || messageText === matchedText) {
          cutoffIndex = index;
          continue;
        }
      }

      break;
    }
  }

  return {
    sourceMeta,
    rawLines: rawLines.slice(0, cutoffIndex + 1),
    forkedAt,
  };
}

export async function createCodexForkSession(
  sourceSessionId: string,
  forkEntryId: string,
  profileId?: string
): Promise<{
  sessionId: string;
  forkedAt: string;
}> {
  const profile = resolveProfile(profileId);
  const sessionRecord = await resolveSessionRecord(profile, sourceSessionId);

  if (!sessionRecord) {
    throw new Error(`Session ${sourceSessionId} was not found`);
  }

  const { sourceMeta, rawLines, forkedAt } = await sliceSessionLinesForFork(
    sessionRecord.path,
    sourceSessionId,
    forkEntryId
  );
  const nextSessionId = randomUUID();
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const targetPath = buildSessionFilePath(profile, nextSessionId, createdAt);

  const forkMetaLine = JSON.stringify({
    timestamp: createdAtIso,
    type: 'session_meta',
    payload: {
      ...sourceMeta,
      id: nextSessionId,
      forked_from_id: sourceSessionId,
      timestamp: createdAtIso,
      cwd: sessionRecord.cwd || sourceMeta.cwd || profile.workspaceCwd,
    },
  });

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${forkMetaLine}\n${rawLines.join('\n')}\n`, 'utf-8');

  return {
    sessionId: nextSessionId,
    forkedAt,
  };
}

export function resolveCodexProfile(profileId?: string): CodexProfile {
  return resolveProfile(profileId);
}

export async function getAvailableProfiles(): Promise<CodexProfile[]> {
  const available: CodexProfile[] = [];

  for (const profile of CANDIDATE_PROFILES) {
    const hasHome = await pathExists(profile.codexHome);
    const hasAuth = await pathExists(path.join(profile.codexHome, 'auth.json'));
    const hasSessions = await pathExists(path.join(profile.codexHome, 'sessions'));

    if (hasHome && (hasAuth || hasSessions)) {
      available.push(profile);
    }
  }

  return available;
}

export async function listCodexSessions(
  profileId?: string,
  query = '',
  limit = MAX_SESSIONS
): Promise<CodexSessionSummary[]> {
  const profile = resolveProfile(profileId);
  const indexMap = await loadSessionIndexMap(profile);
  const sessionFiles = await scanSessionFiles(profile);
  const draftSessions = await listForkDraftSessions(profile.id);
  const recoveredQueueSessions = await loadRecoveredQueueSessions(profile);

  const normalizedQuery = query.trim().toLowerCase();
  const summaries: CodexSessionSummary[] = [];
  const realSessionIds = new Set(sessionFiles.map((session) => session.id));

  for (const sessionFile of sessionFiles) {
    const hints = await extractSessionSummaryHints(
      sessionFile.path,
      sessionFile.id,
      indexMap.get(sessionFile.id)
    );
    const forkMetadata = await getForkSessionMetadata(sessionFile.id);
    const isRealForkSession = Boolean(sessionFile.forkedFromId);
    const forkStartPreview = !isRealForkSession
      ? getFirstTimelineMessageText(forkMetadata?.timeline || [])
      : null;
    const title = hints.title;
    const preview = hints.preview;
    const matchHaystack = `${title}\n${preview}\n${sessionFile.id}\n${sessionFile.cwd || ''}\n${forkMetadata?.sourceTitle || ''}`.toLowerCase();

    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: sessionFile.id,
      title,
      updatedAt: sessionFile.updatedAt,
      createdAt: sessionFile.createdAt,
      profileId: profile.id,
      cwd: sessionFile.cwd,
      messageCount: 0,
      preview,
      startPreview: forkStartPreview
        ? trimPreview(forkStartPreview)
        : hints.startPreview,
      endPreview: hints.endPreview,
      path: sessionFile.path,
      source: sessionFile.source,
      forkSourceSessionId: sessionFile.forkedFromId || forkMetadata?.sourceSessionId || null,
      forkEntryId: forkMetadata?.forkEntryId || null,
      isCompactClone: hints.isCompactClone,
      compactSourceSessionId: hints.compactSourceSessionId,
    });
  }

  const realForkKeys = new Set(
    summaries
      .filter((session) => !session.isDraft && session.forkSourceSessionId && session.forkEntryId)
      .map((session) => `${session.forkSourceSessionId}::${session.forkEntryId}`)
  );

  for (const draft of draftSessions) {
    const draftForkKey = `${draft.sourceSessionId}::${draft.forkEntryId}`;
    if (realForkKeys.has(draftForkKey)) {
      continue;
    }

    const parsedDraft = buildParsedDraftSession(draft);
    const preview = parsedDraft.preview;
    const matchHaystack = `${parsedDraft.title}\n${preview}\n${draft.sessionId}\n${draft.sourceSessionId}\n${draft.sourceTitle}\n${draft.sourceCwd || ''}`.toLowerCase();

    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: draft.sessionId,
      title: parsedDraft.title,
      updatedAt: draft.updatedAt,
      createdAt: draft.createdAt,
      profileId: draft.profileId,
      cwd: draft.sourceCwd,
      messageCount: parsedDraft.messages.length,
      preview,
      startPreview: parsedDraft.messages[0]?.text ? trimPreview(parsedDraft.messages[0].text) : parsedDraft.title,
      endPreview: parsedDraft.messages.at(-1)?.text ? trimPreview(parsedDraft.messages.at(-1)!.text) : preview,
      path: draft.sessionId,
      source: 'fork-draft',
      forkSourceSessionId: draft.sourceSessionId,
      forkEntryId: draft.forkEntryId,
      isDraft: true,
      isCompactClone: parsedDraft.isCompactClone,
      compactSourceSessionId: parsedDraft.compactSourceSessionId,
    });
  }

  for (const recovered of recoveredQueueSessions.values()) {
    if (realSessionIds.has(recovered.id)) {
      continue;
    }

    const parsed = buildRecoveredQueueParsedSession(
      recovered.id,
      recovered,
      indexMap.get(recovered.id)
    );
    const preview = parsed.preview;
    const matchHaystack = `${parsed.title}\n${preview}\n${recovered.id}\n${recovered.cwd || ''}`.toLowerCase();

    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: recovered.id,
      title: parsed.title,
      updatedAt: recovered.updatedAt,
      createdAt: recovered.createdAt,
      profileId: recovered.profileId,
      cwd: recovered.cwd || profile.workspaceCwd,
      messageCount: parsed.messages.length,
      preview,
      startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
      endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
      path: `${QUEUE_STATE_FILE}#${recovered.id}`,
      source: 'queue-recovered',
      forkSourceSessionId: null,
      forkEntryId: null,
      isCompactClone: false,
      compactSourceSessionId: null,
    });
  }

  return summaries
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.min(limit, MAX_SESSIONS));
}

export async function getCodexSessionDetail(
  sessionId: string,
  profileId?: string,
  options?: {
    tail?: number;
    before?: number;
    full?: boolean;
  }
): Promise<CodexSessionDetail> {
  const profile = resolveProfile(profileId);
  const indexMap = await loadSessionIndexMap(profile);
  const sessionFiles = await scanSessionFiles(profile);
  const sessionFile = sessionFiles.find((row) => row.id === sessionId);

  if (!sessionFile) {
    const forkDraft = await getForkDraftSession(sessionId);
    if (!forkDraft || forkDraft.profileId !== profile.id) {
      const recoveredQueueSessions = await loadRecoveredQueueSessions(profile);
      const recovered = recoveredQueueSessions.get(sessionId);
      if (!recovered) {
        throw new Error(`Session ${sessionId} was not found`);
      }

      const parsedBase = buildRecoveredQueueParsedSession(
        sessionId,
        recovered,
        indexMap.get(sessionId)
      );
      const forkMetadata = await getForkSessionMetadata(sessionId);
      const parsed = applyForkSessionOverlay(parsedBase, forkMetadata);
      const totalTimelineEntries = parsed.timeline.length;
      const requestedBefore = typeof options?.before === 'number'
        ? Math.max(0, Math.min(totalTimelineEntries, options.before))
        : totalTimelineEntries;
      const requestedTail = options?.full
        ? totalTimelineEntries
        : typeof options?.tail === 'number'
          ? Math.max(1, Math.min(400, options.tail))
          : totalTimelineEntries;
      const timelineWindowStart = Math.max(0, requestedBefore - requestedTail);
      const timelineWindowEnd = requestedBefore;
      const timeline = parsed.timeline.slice(timelineWindowStart, timelineWindowEnd);
      const shouldReturnFullMessages = requestedTail >= totalTimelineEntries && timelineWindowStart === 0;

      return {
        id: sessionId,
        title: parsed.title,
        updatedAt: recovered.updatedAt,
        createdAt: recovered.createdAt,
        profileId: profile.id,
        messageCount: parsed.messages.length,
        preview: parsed.preview,
        startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
        endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
        path: `${QUEUE_STATE_FILE}#${recovered.id}`,
        source: 'queue-recovered',
        cwd: recovered.cwd || profile.workspaceCwd,
        forkSourceSessionId: forkMetadata?.sourceSessionId || null,
        forkEntryId: forkMetadata?.forkEntryId || null,
        modelProvider: null,
        messages: shouldReturnFullMessages ? parsed.messages : [],
        timeline,
        totalTimelineEntries,
        timelineWindowStart,
        timelineWindowEnd,
        hasEarlierTimeline: timelineWindowStart > 0,
        isCompactClone: parsed.isCompactClone,
        compactSourceSessionId: parsed.compactSourceSessionId,
        forkDraftContext: null,
      };
    }

    const [hiddenIds, topicMap] = await Promise.all([
      listHiddenSessionIds(profile.id),
      getSessionTopicMap(profile.id),
    ]);
    const parsedDraft = buildParsedDraftSession(forkDraft);
    const totalTimelineEntries = parsedDraft.timeline.length;
    const requestedBefore = typeof options?.before === 'number'
      ? Math.max(0, Math.min(totalTimelineEntries, options.before))
      : totalTimelineEntries;
    const requestedTail = options?.full
      ? totalTimelineEntries
      : typeof options?.tail === 'number'
        ? Math.max(1, Math.min(400, options.tail))
        : totalTimelineEntries;
    const timelineWindowStart = Math.max(0, requestedBefore - requestedTail);
    const timelineWindowEnd = requestedBefore;
    const timeline = parsedDraft.timeline.slice(timelineWindowStart, timelineWindowEnd);

    return {
      id: forkDraft.sessionId,
      title: parsedDraft.title,
      updatedAt: forkDraft.updatedAt,
      createdAt: forkDraft.createdAt,
      profileId: profile.id,
      messageCount: parsedDraft.messages.length,
      preview: parsedDraft.preview,
      startPreview: parsedDraft.messages[0]?.text ? trimPreview(parsedDraft.messages[0].text) : parsedDraft.title,
      endPreview: parsedDraft.messages.at(-1)?.text ? trimPreview(parsedDraft.messages.at(-1)!.text) : parsedDraft.preview,
      path: forkDraft.sessionId,
      source: 'fork-draft',
      cwd: forkDraft.sourceCwd,
      forkSourceSessionId: forkDraft.sourceSessionId,
      forkEntryId: forkDraft.forkEntryId,
      modelProvider: null,
      messages: timelineWindowStart === 0 && requestedTail >= totalTimelineEntries ? parsedDraft.messages : [],
      timeline,
      totalTimelineEntries,
      timelineWindowStart,
      timelineWindowEnd,
      hasEarlierTimeline: timelineWindowStart > 0,
      isDraft: true,
      hidden: hiddenIds.has(forkDraft.sessionId),
      topic: topicMap[forkDraft.sessionId] || null,
      isCompactClone: parsedDraft.isCompactClone,
      compactSourceSessionId: parsedDraft.compactSourceSessionId,
      forkDraftContext: cloneForkDraftContext(forkDraft),
    };
  }

  const parsedBase = await parseSessionFile(sessionFile.path, sessionId, indexMap.get(sessionId));
  const forkMetadata = await getForkSessionMetadata(sessionId);
  const parsed = sessionFile.forkedFromId
    ? parsedBase
    : applyForkSessionOverlay(parsedBase, forkMetadata);
  const totalTimelineEntries = parsed.timeline.length;
  const requestedBefore = typeof options?.before === 'number'
    ? Math.max(0, Math.min(totalTimelineEntries, options.before))
    : totalTimelineEntries;
  const requestedTail = options?.full
    ? totalTimelineEntries
    : typeof options?.tail === 'number'
      ? Math.max(1, Math.min(400, options.tail))
      : totalTimelineEntries;
  const timelineWindowStart = Math.max(0, requestedBefore - requestedTail);
  const timelineWindowEnd = requestedBefore;
  const timeline = parsed.timeline.slice(timelineWindowStart, timelineWindowEnd);
  const shouldReturnFullMessages = requestedTail >= totalTimelineEntries && timelineWindowStart === 0;

  return {
    id: sessionId,
    title: parsed.title,
    updatedAt: sessionFile.updatedAt,
    createdAt: sessionFile.createdAt,
    profileId: profile.id,
    messageCount: parsed.messages.length,
    preview: parsed.preview,
    startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
    endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
    path: sessionFile.path,
    source: sessionFile.source,
    cwd: sessionFile.cwd,
    forkSourceSessionId: sessionFile.forkedFromId || forkMetadata?.sourceSessionId || null,
    forkEntryId: forkMetadata?.forkEntryId || null,
    modelProvider: sessionFile.modelProvider,
    messages: shouldReturnFullMessages ? parsed.messages : [],
    timeline,
    totalTimelineEntries,
    timelineWindowStart,
    timelineWindowEnd,
    hasEarlierTimeline: timelineWindowStart > 0,
    isCompactClone: parsed.isCompactClone,
    compactSourceSessionId: parsed.compactSourceSessionId,
    forkDraftContext: null,
  };
}

async function waitForSessionReady(
  profile: CodexProfile,
  sessionId: string,
  previousUpdatedAt?: string | null,
  timeoutMs = 6000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sessionRecord = await resolveSessionRecord(profile, sessionId);
    if (sessionRecord) {
      if (!previousUpdatedAt || sessionRecord.updatedAt > previousUpdatedAt) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function buildPromptWithAttachments(
  prompt: string,
  attachments: CodexUploadedAttachment[],
  options: {
    cwdContext?: string | null;
    injectDirectoryContext?: boolean;
  } = {}
): { promptText: string; imagePaths: string[] } {
  const sections: string[] = [];

  if (options.injectDirectoryContext && options.cwdContext) {
    sections.push(
      [
        `המשתמש נמצא כרגע בתיקייה "${path.basename(options.cwdContext)}".`,
        `הנתיב הפעיל הוא: ${options.cwdContext}`,
        'התייחס לתיקייה הזו כ-workspace הפעיל אלא אם המשתמש מבקש אחרת.',
      ].join('\n')
    );
  }

  if (attachments.length === 0) {
    return {
      promptText: [...sections, prompt.trim()].filter(Boolean).join('\n\n'),
      imagePaths: [],
    };
  }

  const imagePaths = attachments.filter((attachment) => attachment.isImage).map((attachment) => attachment.path);
  const attachmentLines = attachments.map((attachment) => {
    const typeLabel = attachment.isImage ? 'image' : 'file';
    return `- ${attachment.name} (${typeLabel}, ${attachment.mimeType || 'unknown'}) => ${attachment.path}`;
  });

  return {
    promptText: [
      ...sections,
      prompt.trim(),
      `Attached files available in the workspace:\n${attachmentLines.join('\n')}\nInspect these files directly if they are relevant to the request.`,
    ].filter(Boolean).join('\n\n'),
    imagePaths,
  };
}

async function readCodexExecutionDefaults(profile: CodexProfile): Promise<CodexExecutionConfig> {
  const configPath = path.join(profile.codexHome, 'config.toml');

  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return {
      model: normalizeExecutionSettingValue(readRootTomlString(raw, 'model')),
      reasoningEffort: normalizeExecutionSettingValue(readRootTomlString(raw, 'model_reasoning_effort')),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        model: null,
        reasoningEffort: null,
      };
    }

    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return {
        model: null,
        reasoningEffort: null,
      };
    }

    throw error;
  }
}

async function loadCodexAvailableModels(profile: CodexProfile): Promise<CodexAvailableModel[]> {
  const cached = modelCatalogCache.get(profile.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models.map((model) => ({
      ...model,
      supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
    }));
  }

  const runModelCatalogCommand = (env: NodeJS.ProcessEnv) => spawnSync(CODEX_BIN, ['debug', 'models'], {
    cwd: profile.workspaceCwd,
    env,
    encoding: 'utf-8',
    maxBuffer: 12 * 1024 * 1024,
  });

  let result = runModelCatalogCommand(buildCodexProcessEnv(profile));

  if ((result.error || result.status !== 0) && shouldRetryModelCatalogLoad(result)) {
    const fallbackEnv = buildFallbackCodexProcessEnv(profile);
    await fs.mkdir(String(fallbackEnv.CODEX_HOME), { recursive: true });
    result = runModelCatalogCommand(fallbackEnv);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      sanitizeCodexCliFailure(profile, result.stderr || result.stdout || '', 'Failed to load Codex models')
    );
  }

  const payload = safeJsonParse<RawCodexDebugModelsResponse>((result.stdout || '').trim());
  const rawModels = Array.isArray(payload?.models) ? payload.models : [];
  const models = rawModels
    .filter((entry) => entry?.visibility !== 'hidden')
    .map((entry): CodexAvailableModel | null => {
      const slug = normalizeExecutionSettingValue(entry?.slug);
      if (!slug) {
        return null;
      }

      const displayName = normalizeExecutionSettingValue(entry?.display_name) || slug;
      const supportedReasoningLevels = Array.isArray(entry?.supported_reasoning_levels)
        ? entry.supported_reasoning_levels
          .map((level): CodexReasoningLevelOption | null => {
            const effort = normalizeExecutionSettingValue(level?.effort);
            if (!effort) {
              return null;
            }

            return {
              effort,
              description: normalizeExecutionSettingValue(level?.description),
            };
          })
          .filter((level): level is CodexReasoningLevelOption => Boolean(level))
        : [];

      return {
        slug,
        displayName,
        description: normalizeExecutionSettingValue(entry?.description),
        defaultReasoningLevel: normalizeExecutionSettingValue(entry?.default_reasoning_level),
        supportedReasoningLevels,
        isConfiguredDefault: false,
      };
    })
    .filter((entry): entry is CodexAvailableModel => Boolean(entry));

  modelCatalogCache.set(profile.id, {
    expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
    models,
  });

  return models.map((model) => ({
    ...model,
    supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
  }));
}

export async function getCodexModelCatalog(profileId?: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  const [models, defaults] = await Promise.all([
    loadCodexAvailableModels(profile),
    readCodexExecutionDefaults(profile),
  ]);

  const selectedModel = defaults.model && models.some((model) => model.slug === defaults.model)
    ? defaults.model
    : models[0]?.slug || null;
  const selectedModelOption = selectedModel
    ? models.find((model) => model.slug === selectedModel) || null
    : null;
  const selectedReasoningEffort = defaults.reasoningEffort
    && selectedModelOption?.supportedReasoningLevels.some((level) => level.effort === defaults.reasoningEffort)
      ? defaults.reasoningEffort
      : selectedModelOption?.defaultReasoningLevel
        || selectedModelOption?.supportedReasoningLevels[0]?.effort
        || null;

  return {
    models: models.map((model) => ({
      ...model,
      isConfiguredDefault: model.slug === selectedModel,
      supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
    })),
    selectedModel,
    selectedReasoningEffort,
    permissions: null,
  };
}

export async function getCodexRateLimitSnapshot(
  profileId?: string,
  sessionId?: string
): Promise<CodexRateLimitSnapshot | null> {
  const profile = resolveProfile(profileId);

  if (sessionId?.trim()) {
    const sessionRecord = await resolveSessionRecord(profile, sessionId.trim());
    if (!sessionRecord) {
      return null;
    }

    return readRateLimitSnapshotFromSessionRecord(profile, sessionRecord);
  }

  const sessionFiles = await scanSessionFiles(profile);

  for (const sessionRecord of sessionFiles) {
    const snapshot = await readRateLimitSnapshotFromSessionRecord(profile, sessionRecord);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}

async function resolveCodexExecutionConfig(
  profile: CodexProfile,
  executionConfig?: CodexExecutionConfig | null
): Promise<CodexExecutionConfig> {
  const requestedModel = normalizeExecutionSettingValue(executionConfig?.model);
  const requestedReasoningEffort = normalizeExecutionSettingValue(executionConfig?.reasoningEffort);

  if (!requestedModel && !requestedReasoningEffort) {
    return {
      model: null,
      reasoningEffort: null,
    };
  }

  const catalog = await getCodexModelCatalog(profile.id);
  const fallbackModel = requestedModel
    || catalog.selectedModel
    || catalog.models[0]?.slug
    || null;
  const selectedModelOption = fallbackModel
    ? catalog.models.find((model) => model.slug === fallbackModel) || null
    : null;

  if (requestedModel && !selectedModelOption) {
    throw new Error(`Codex model "${requestedModel}" is not available for this profile`);
  }

  if (
    requestedReasoningEffort
    && selectedModelOption
    && !selectedModelOption.supportedReasoningLevels.some((level) => level.effort === requestedReasoningEffort)
  ) {
    throw new Error(`Reasoning effort "${requestedReasoningEffort}" is not supported by ${selectedModelOption.displayName}`);
  }

  return {
    model: selectedModelOption?.slug || requestedModel || null,
    reasoningEffort: requestedReasoningEffort,
  };
}

function collectCodexArgs(
  prompt: string,
  sessionId?: string,
  imagePaths: string[] = [],
  executionConfig?: CodexExecutionConfig | null
): string[] {
  const baseArgs = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
  ];
  const executionArgs = [
    ...(executionConfig?.model ? ['--model', executionConfig.model] : []),
    ...(executionConfig?.reasoningEffort ? ['--config', `model_reasoning_effort="${executionConfig.reasoningEffort}"`] : []),
  ];
  const imageArgs = imagePaths.flatMap((imagePath) => ['--image', imagePath]);

  if (sessionId) {
    return ['exec', 'resume', ...baseArgs, ...executionArgs, ...imageArgs, sessionId, prompt];
  }

  return ['exec', ...baseArgs, ...executionArgs, ...imageArgs, prompt];
}

function queueBySessionKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previousTail = queueTails.get(key) || Promise.resolve();
  const result = previousTail.catch(() => undefined).then(task);
  const currentTail = result.then(() => undefined, () => undefined);
  queueTails.set(key, currentTail);

  return result.finally(() => {
    if (queueTails.get(key) === currentTail) {
      queueTails.delete(key);
    }
  });
}

export function cancelCodexRun(runId: string): boolean {
  const activeRun = activeCodexRuns.get(runId);
  if (!activeRun) {
    return false;
  }

  activeRun.cancelRequested = true;

  if (!activeRun.child.killed) {
    activeRun.child.kill('SIGTERM');
    setTimeout(() => {
      if (!activeRun.child.killed) {
        activeRun.child.kill('SIGKILL');
      }
    }, 3000).unref();
  }

  return true;
}

export async function runCodexPrompt(
  prompt: string,
  sessionId?: string,
  profileId?: string,
  attachments: CodexUploadedAttachment[] = [],
  options: {
    runId?: string;
    cwd?: string;
    injectDirectoryContext?: boolean;
    executionConfig?: CodexExecutionConfig | null;
  } = {}
): Promise<CodexRunResult> {
  const profile = resolveProfile(profileId);
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    throw new Error('Prompt must not be empty');
  }

  const runCwdOverride = !sessionId && options.cwd?.trim() ? options.cwd.trim() : null;
  const runCwd = runCwdOverride || await resolveRunCwd(profile, sessionId);
  const { promptText, imagePaths } = buildPromptWithAttachments(trimmedPrompt, attachments, {
    cwdContext: runCwd,
    injectDirectoryContext: Boolean(!sessionId && options.injectDirectoryContext),
  });
  const queueKey = `${profile.id}:${sessionId || '__new__'}`;
  const executionConfig = await resolveCodexExecutionConfig(profile, options.executionConfig);

  return queueBySessionKey(queueKey, async () => {
    const previousSession = sessionId ? await resolveSessionRecord(profile, sessionId) : null;
    const args = collectCodexArgs(promptText, sessionId, imagePaths, executionConfig);

    return new Promise<CodexRunResult>((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, {
        cwd: runCwd,
        env: buildCodexProcessEnv(profile),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const activeRunId = options.runId;

      if (activeRunId) {
        activeCodexRuns.set(activeRunId, {
          child,
          cancelRequested: false,
        });
      }

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let finalMessage = '';
      let createdSessionId = sessionId || '';

      function wasCancellationRequested(): boolean {
        return activeRunId ? activeCodexRuns.get(activeRunId)?.cancelRequested === true : false;
      }

      function clearActiveRun() {
        if (activeRunId && activeCodexRuns.get(activeRunId)?.child === child) {
          activeCodexRuns.delete(activeRunId);
        }
      }

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;

        while (stdoutBuffer.includes('\n')) {
          const newlineIndex = stdoutBuffer.indexOf('\n');
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

          if (!line) continue;
          const row = safeJsonParse<any>(line);
          if (!row) continue;

          if (row.type === 'thread.started' && typeof row.thread_id === 'string') {
            createdSessionId = row.thread_id;
          }

          if (
            row.type === 'item.completed'
            && row.item?.type === 'agent_message'
            && typeof row.item?.text === 'string'
          ) {
            finalMessage = row.item.text.trim();
          }
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk;
      });

      child.on('error', (error) => {
        const cancelled = wasCancellationRequested();
        clearActiveRun();
        if (cancelled) {
          reject(new CodexRunCancelledError());
          return;
        }
        reject(error);
      });

      child.on('close', async (code) => {
        const cancelled = wasCancellationRequested();
        clearActiveRun();

        if (cancelled) {
          reject(new CodexRunCancelledError());
          return;
        }

        if (code !== 0) {
          reject(new Error(sanitizeCodexCliFailure(profile, stderrBuffer, `Codex exited with code ${code}`)));
          return;
        }

        if (!createdSessionId) {
          reject(new Error('Codex completed without returning a session id'));
          return;
        }

        await waitForSessionReady(profile, createdSessionId, previousSession?.updatedAt || null);

        resolve({
          sessionId: createdSessionId,
          finalMessage: finalMessage || 'Codex completed without a final assistant message.',
        });
      });
    });
  });
}
