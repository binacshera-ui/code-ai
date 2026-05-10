import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import {
  createForkDraftSession,
  getForkDraftSession,
  getForkSessionMetadata,
  listForkDraftSessions,
  type CodexForkDraftSession,
  type CodexForkSessionMetadata,
} from './codexForkSessions.js';
import type {
  CodexAvailableModel,
  CodexContextUsageSnapshot,
  CodexExecutionConfig,
  CodexModelCatalog,
  CodexProfile,
  CodexRateLimitSnapshot,
  CodexReasoningLevelOption,
  CodexSessionDetail,
  CodexSessionMessage,
  CodexSessionSummary,
  CodexTimelineEntry,
  CodexUploadedAttachment,
} from './codexService.js';

interface GeminiSessionScanRecord {
  id: string;
  path: string;
  updatedAt: string;
  createdAt: string | null;
  cwd: string | null;
  modelProvider: string | null;
  source: string;
}

interface ParsedGeminiSession {
  title: string;
  preview: string;
  messages: CodexSessionMessage[];
  timeline: CodexTimelineEntry[];
  modelProvider: string | null;
  context: CodexContextUsageSnapshot | null;
}

interface GeminiRuntimeSnapshot {
  profileId: string;
  sessionId: string | null;
  updatedAt: string;
  planType: string | null;
  rateLimitReachedType: string | null;
  model: string | null;
  selectedReasoningEffort: string | null;
  context: CodexContextUsageSnapshot | null;
}

interface GeminiRuntimeState {
  profiles: Record<string, GeminiRuntimeSnapshot>;
  sessions: Record<string, GeminiRuntimeSnapshot>;
  modelContextWindows: Record<string, number>;
}

interface GeminiActiveRun {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
}

interface GeminiModelDescriptor {
  slug: string;
  displayName: string;
  description: string | null;
  inputTokenLimit: number | null;
  thinking: boolean;
}

interface GeminiRunResult {
  sessionId: string;
  finalMessage: string;
}

const GEMINI_BIN = process.env.GEMINI_BIN || 'gemini';
const MAX_SESSIONS = 80;
const MAX_TOOL_TEXT = 12_000;
const GEMINI_RUNTIME_STATE_FILE = path.join(CODEX_APP_CONFIG.queueRoot, 'gemini-runtime-state.json');
const GEMINI_MODEL_CACHE_TTL_MS = 60_000;
const SUPPORTED_REASONING_LEVELS: CodexReasoningLevelOption[] = [
  { effort: 'none', description: 'ללא חשיבה נוספת' },
  { effort: 'low', description: 'תקציב חשיבה קטן' },
  { effort: 'medium', description: 'איזון מהיר בין איכות לזמן' },
  { effort: 'high', description: 'תקציב חשיבה מוגבר' },
  { effort: 'max', description: 'תקציב חשיבה מירבי' },
];
const THINKING_BUDGET_BY_EFFORT: Record<string, number> = {
  none: 0,
  low: 512,
  medium: 2048,
  high: 8192,
  max: 16384,
};
const PREFERRED_MODEL_ORDER = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.0-flash',
];

const CANDIDATE_PROFILES: CodexProfile[] = CODEX_APP_CONFIG.profiles.filter((profile) => profile.provider === 'gemini');

const queueTails = new Map<string, Promise<void>>();
const activeGeminiRuns = new Map<string, GeminiActiveRun>();
const modelCatalogCache = new Map<string, {
  expiresAt: number;
  catalog: CodexModelCatalog;
}>();

let runtimeStateLoadPromise: Promise<void> | null = null;
let runtimeStatePersistTail: Promise<void> = Promise.resolve();
let runtimeState: GeminiRuntimeState = {
  profiles: {},
  sessions: {},
  modelContextWindows: {},
};

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
  return Boolean(metadata && metadata.transferSourceProvider && metadata.transferTargetProvider);
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

export class GeminiRunCancelledError extends Error {
  constructor(message = 'Gemini run was stopped') {
    super(message);
    this.name = 'GeminiRunCancelledError';
  }
}

function trimPreview(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
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

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNumber(value: unknown): number | null {
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeGeminiReasoningEffort(value: unknown): string | null {
  const normalized = normalizeString(value)?.toLowerCase() || null;
  if (!normalized) {
    return null;
  }

  return SUPPORTED_REASONING_LEVELS.some((level) => level.effort === normalized)
    ? normalized
    : null;
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

function summarizeToolName(toolName: string): string {
  return toolName
    .replace(/^mcp__/, '')
    .replace(/__/g, ' · ')
    .replace(/_/g, ' ')
    .trim() || 'Tool';
}

function summarizeToolInput(toolName: string, input: unknown): string | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    return trimPreview(input, 160);
  }

  const candidate = input as Record<string, unknown>;

  if (toolName.toLowerCase().includes('shell') && typeof candidate.command === 'string') {
    return trimPreview(candidate.command, 160);
  }

  if (typeof candidate.file_path === 'string') {
    return trimPreview(candidate.file_path, 160);
  }

  if (typeof candidate.path === 'string') {
    return trimPreview(candidate.path, 160);
  }

  if (typeof candidate.dir_path === 'string') {
    return trimPreview(candidate.dir_path, 160);
  }

  if (typeof candidate.prompt === 'string') {
    return trimPreview(candidate.prompt, 160);
  }

  return trimPreview(JSON.stringify(input), 160);
}

function parseGeminiContextUsage(
  tokens: Record<string, unknown> | null | undefined,
  contextWindow: number | null
): CodexContextUsageSnapshot | null {
  if (!tokens && contextWindow === null) {
    return null;
  }

  const inputTokens = parseNumber(tokens?.input);
  const cachedInputTokens = parseNumber(tokens?.cached);
  const usagePercent = (
    contextWindow !== null
    && contextWindow > 0
    && inputTokens !== null
  )
    ? Math.min(100, Math.max(0, (inputTokens / contextWindow) * 100))
    : null;

  if (contextWindow === null && inputTokens === null && cachedInputTokens === null) {
    return null;
  }

  return {
    modelContextWindow: contextWindow,
    inputTokens,
    cachedInputTokens,
    usagePercent,
  };
}

function cloneContextSnapshot(context: CodexContextUsageSnapshot | null): CodexContextUsageSnapshot | null {
  return context ? { ...context } : null;
}

function cloneRuntimeSnapshot(snapshot: GeminiRuntimeSnapshot | null): GeminiRuntimeSnapshot | null {
  return snapshot
    ? {
      ...snapshot,
      context: cloneContextSnapshot(snapshot.context),
    }
    : null;
}

async function ensureRuntimeStateLoaded() {
  if (!runtimeStateLoadPromise) {
    runtimeStateLoadPromise = (async () => {
      await fs.mkdir(path.dirname(GEMINI_RUNTIME_STATE_FILE), { recursive: true });

      try {
        const raw = await fs.readFile(GEMINI_RUNTIME_STATE_FILE, 'utf-8');
        const parsed = safeJsonParse<Partial<GeminiRuntimeState>>(raw);
        runtimeState = {
          profiles: parsed?.profiles && typeof parsed.profiles === 'object'
            ? parsed.profiles as Record<string, GeminiRuntimeSnapshot>
            : {},
          sessions: parsed?.sessions && typeof parsed.sessions === 'object'
            ? parsed.sessions as Record<string, GeminiRuntimeSnapshot>
            : {},
          modelContextWindows: parsed?.modelContextWindows && typeof parsed.modelContextWindows === 'object'
            ? parsed.modelContextWindows as Record<string, number>
            : {},
        };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }

        runtimeState = {
          profiles: {},
          sessions: {},
          modelContextWindows: {},
        };
      }
    })();
  }

  await runtimeStateLoadPromise;
}

async function persistRuntimeState() {
  const snapshot = JSON.stringify(runtimeState, null, 2);
  runtimeStatePersistTail = runtimeStatePersistTail.then(async () => {
    await fs.mkdir(path.dirname(GEMINI_RUNTIME_STATE_FILE), { recursive: true });
    await fs.writeFile(GEMINI_RUNTIME_STATE_FILE, snapshot, 'utf-8');
  });
  await runtimeStatePersistTail;
}

async function updateRuntimeSnapshot(snapshot: GeminiRuntimeSnapshot) {
  await ensureRuntimeStateLoaded();
  runtimeState.profiles[snapshot.profileId] = cloneRuntimeSnapshot(snapshot)!;
  if (snapshot.sessionId) {
    runtimeState.sessions[snapshot.sessionId] = cloneRuntimeSnapshot(snapshot)!;
  }
  if (snapshot.model && snapshot.context?.modelContextWindow) {
    runtimeState.modelContextWindows[snapshot.model] = snapshot.context.modelContextWindow;
  }
  await persistRuntimeState();
}

function getGeminiProjectTempRoot(profile: CodexProfile): string {
  return path.join(profile.codexHome, 'tmp');
}

function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

async function readProfileEnv(profile: CodexProfile): Promise<Record<string, string>> {
  const envPath = path.join(profile.codexHome, '.env');

  try {
    const raw = await fs.readFile(envPath, 'utf-8');
    return parseDotEnv(raw);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function buildGeminiProcessEnv(
  profile: CodexProfile,
  envValues: Record<string, string>,
  temporarySettingsPath?: string | null
): NodeJS.ProcessEnv {
  const homePath = path.dirname(profile.codexHome);
  return {
    ...process.env,
    ...envValues,
    HOME: homePath,
    USER: process.env.USER || path.basename(homePath),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: temporarySettingsPath || process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  };
}

function readLatestTimestamp(value: string | null, fallback: string | null): string | null {
  if (!value) {
    return fallback;
  }

  if (!fallback) {
    return value;
  }

  return value > fallback ? value : fallback;
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

async function readGeminiProjectRoots(profile: CodexProfile): Promise<string[]> {
  const tmpRoot = getGeminiProjectTempRoot(profile);
  if (!(await pathExists(tmpRoot))) {
    return [];
  }

  const workspacePath = path.resolve(profile.workspaceCwd);
  const roots = new Set<string>();

  try {
    const projectsJsonPath = path.join(profile.codexHome, 'projects.json');
    const raw = await fs.readFile(projectsJsonPath, 'utf-8');
    const parsed = safeJsonParse<{ projects?: Record<string, string> }>(raw);
    const mappedAlias = parsed?.projects?.[workspacePath];
    if (mappedAlias) {
      const mappedRoot = path.join(tmpRoot, mappedAlias);
      if (await pathExists(mappedRoot)) {
        roots.add(mappedRoot);
      }
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const projectRoot = path.join(tmpRoot, entry.name);
    const markerPath = path.join(projectRoot, '.project_root');
    if (!(await pathExists(markerPath))) {
      continue;
    }

    try {
      const marker = (await fs.readFile(markerPath, 'utf-8')).trim();
      if (marker && path.resolve(marker) === workspacePath) {
        roots.add(projectRoot);
      }
    } catch {
      continue;
    }
  }

  return [...roots];
}

async function scanGeminiSessionFiles(profile: CodexProfile): Promise<GeminiSessionScanRecord[]> {
  const projectRoots = await readGeminiProjectRoots(profile);
  const rows: GeminiSessionScanRecord[] = [];

  for (const projectRoot of projectRoots) {
    const chatsRoot = path.join(projectRoot, 'chats');
    if (!(await pathExists(chatsRoot))) {
      continue;
    }

    const entries = await fs.readdir(chatsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.json'))) {
        continue;
      }

      const filePath = path.join(chatsRoot, entry.name);
      const stats = await fs.stat(filePath);
      const header = await readGeminiSessionHeader(filePath);
      const sessionId = header.sessionId || entry.name.replace(/\.(jsonl|json)$/i, '');

      rows.push({
        id: sessionId,
        path: filePath,
        updatedAt: header.lastUpdated || stats.mtime.toISOString(),
        createdAt: header.startTime,
        cwd: profile.workspaceCwd,
        modelProvider: header.modelProvider,
        source: 'gemini-session',
      });
    }
  }

  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return rows;
}

async function readGeminiSessionHeader(filePath: string): Promise<{
  sessionId: string | null;
  startTime: string | null;
  lastUpdated: string | null;
  modelProvider: string | null;
}> {
  if (filePath.endsWith('.json')) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = safeJsonParse<any>(raw);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const lastGemini = [...messages].reverse().find((message) => message?.type === 'gemini');
      return {
        sessionId: normalizeString(parsed?.sessionId),
        startTime: normalizeIsoTimestamp(parsed?.startTime),
        lastUpdated: normalizeIsoTimestamp(parsed?.lastUpdated),
        modelProvider: normalizeString(lastGemini?.model),
      };
    } catch {
      return {
        sessionId: null,
        startTime: null,
        lastUpdated: null,
        modelProvider: null,
      };
    }
  }

  const headLines = await readFileHead(filePath, 40 * 1024);
  const header = headLines
    .map((line) => safeJsonParse<any>(line))
    .find((row) => row && typeof row === 'object' && row.sessionId);
  const lastGemini = [...headLines]
    .reverse()
    .map((line) => safeJsonParse<any>(line))
    .find((row) => row?.type === 'gemini' && normalizeString(row?.model));

  return {
    sessionId: normalizeString(header?.sessionId),
    startTime: normalizeIsoTimestamp(header?.startTime),
    lastUpdated: normalizeIsoTimestamp(header?.lastUpdated),
    modelProvider: normalizeString(lastGemini?.model),
  };
}

async function resolveGeminiSessionRecord(profile: CodexProfile, sessionId: string): Promise<GeminiSessionScanRecord | null> {
  const sessionFiles = await scanGeminiSessionFiles(profile);
  return sessionFiles.find((row) => row.id === sessionId) || null;
}

function extractGeminiUserPromptText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap((part) => {
      if (typeof part === 'string') {
        return [part];
      }

      if (!part || typeof part !== 'object') {
        return [];
      }

      const candidate = part as Record<string, unknown>;
      if (typeof candidate.text === 'string') {
        return [candidate.text];
      }

      return [];
    })
    .join('\n')
    .trim();
}

function extractGeminiThoughtText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .flatMap((part) => {
      if (typeof part === 'string') {
        return [part];
      }

      if (!part || typeof part !== 'object') {
        return [];
      }

      const candidate = part as Record<string, unknown>;
      const subject = typeof candidate.subject === 'string' ? candidate.subject.trim() : '';
      const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
      const text = [subject, description].filter(Boolean).join('\n');
      return text ? [text] : [];
    })
    .join('\n\n')
    .trim();
}

function extractGeminiToolResultText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((part) => {
        const extracted = extractGeminiToolResultText(part);
        return extracted ? [extracted] : [];
      })
      .join('\n')
      .trim();
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text === 'string') {
    return candidate.text.trim();
  }

  if (typeof candidate.output === 'string') {
    return candidate.output.trim();
  }

  const functionResponse = candidate.functionResponse as Record<string, unknown> | undefined;
  const response = functionResponse?.response as Record<string, unknown> | undefined;
  if (typeof response?.output === 'string') {
    return response.output.trim().replace(/^Output:\s*/i, '').trim();
  }

  return '';
}

function parseGeminiSessionRows(messages: any[], sessionId: string): ParsedGeminiSession {
  const timeline: CodexTimelineEntry[] = [];
  const resultMessages: CodexSessionMessage[] = [];
  let derivedTitle: string | null = null;
  let preview = '';
  let modelProvider: string | null = null;
  let latestContext: CodexContextUsageSnapshot | null = null;

  for (const row of messages) {
    const timestamp = normalizeIsoTimestamp(row?.timestamp) || new Date().toISOString();

    if (row?.type === 'user') {
      const text = extractGeminiUserPromptText(row?.content);
      if (!text) {
        continue;
      }

      const entryId = normalizeString(row?.id) || `${sessionId}-user-${resultMessages.length}`;
      resultMessages.push({
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
      if (!derivedTitle) {
        derivedTitle = trimPreview(text, 72);
      }
      continue;
    }

    if (row?.type !== 'gemini') {
      continue;
    }

    modelProvider = normalizeString(row?.model) || modelProvider;
    latestContext = parseGeminiContextUsage(
      row?.tokens && typeof row.tokens === 'object' ? row.tokens : null,
      modelProvider ? runtimeState.modelContextWindows[modelProvider] || null : null
    ) || latestContext;

    const thoughtText = extractGeminiThoughtText(row?.thoughts);
    if (thoughtText) {
      timeline.push({
        id: `${normalizeString(row?.id) || sessionId}-thinking-${timeline.length}`,
        entryType: 'tool',
        timestamp,
        toolName: 'thinking',
        title: 'Thinking',
        subtitle: 'Gemini reasoning trace',
        text: clipLongText(thoughtText, 5000),
        status: 'completed',
        exitCode: null,
        callId: null,
      });
    }

    const toolCalls = Array.isArray(row?.toolCalls) ? row.toolCalls : [];
    for (const toolCall of toolCalls) {
      const toolName = normalizeString(toolCall?.name) || 'tool';
      const callId = normalizeString(toolCall?.id);
      const resultText = extractGeminiToolResultText(toolCall?.result);
      timeline.push({
        id: `${callId || normalizeString(row?.id) || sessionId}-tool-${timeline.length}`,
        entryType: 'tool',
        timestamp: normalizeIsoTimestamp(toolCall?.timestamp) || timestamp,
        toolName,
        title: normalizeString(toolCall?.displayName) || summarizeToolName(toolName),
        subtitle: normalizeString(toolCall?.description) || summarizeToolInput(toolName, toolCall?.args) || normalizeString(toolCall?.status),
        text: clipLongText(resultText || JSON.stringify(toolCall?.args || {}, null, 2), 5000),
        callId,
        status: normalizeString(toolCall?.status) || 'completed',
        exitCode: null,
      });
    }

    const text = normalizeString(row?.content);
    if (text) {
      const entryId = normalizeString(row?.id) || `${sessionId}-assistant-${resultMessages.length}`;
      resultMessages.push({
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
      preview = text;
    }
  }

  if (!preview) {
    const lastAssistant = [...resultMessages].reverse().find((message) => message.role === 'assistant');
    preview = lastAssistant?.text || resultMessages.at(-1)?.text || '';
  }

  return {
    title: derivedTitle || `שיחת Gemini ${sessionId.slice(0, 8)}`,
    preview: trimPreview(preview || derivedTitle || sessionId),
    messages: resultMessages,
    timeline,
    modelProvider,
    context: latestContext,
  };
}

async function parseGeminiSessionFile(filePath: string, sessionId: string): Promise<ParsedGeminiSession> {
  if (filePath.endsWith('.json')) {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = safeJsonParse<any>(raw) || {};
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return parseGeminiSessionRows(messages, sessionId);
  }

  const rows: any[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lineReader) {
      const row = safeJsonParse<any>(line);
      if (row && row.type) {
        rows.push(row);
      }
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  return parseGeminiSessionRows(rows, sessionId);
}

function buildDraftParsedSession(draft: CodexForkDraftSession): ParsedGeminiSession {
  const messages = draft.timeline
    .map((entry) => timelineEntryToMessage(entry))
    .filter((entry): entry is CodexSessionMessage => Boolean(entry));
  const preview = trimPreview(
    messages.at(-1)?.text
      || messages[0]?.text
      || draft.promptPreview
      || draft.sourceTitle
      || draft.sessionId
  );

  return {
    title: trimPreview(
      draft.transferSourceProvider && draft.transferTargetProvider
        ? draft.sourceTitle || draft.sessionId
        : draft.promptPreview || draft.sourceTitle || draft.sessionId,
      72
    ),
    preview,
    messages,
    timeline: draft.timeline.map((entry) => ({ ...entry })),
    modelProvider: null,
    context: null,
  };
}

function applyForkSessionOverlay(
  parsed: ParsedGeminiSession,
  metadata: CodexForkSessionMetadata | null
): ParsedGeminiSession {
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
    modelProvider: parsed.modelProvider,
    context: parsed.context,
  };
}

async function extractGeminiSessionSummaryHints(
  filePath: string,
  sessionId: string
): Promise<{
  title: string;
  preview: string;
  startPreview: string;
  endPreview: string;
}> {
  const parsed = await parseGeminiSessionFile(filePath, sessionId);
  return {
    title: parsed.title,
    preview: parsed.preview,
    startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
    endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
  };
}

function buildForkPromptPrefix(
  sourceTitle: string,
  sourceCwd: string | null,
  timeline: CodexTimelineEntry[]
): string {
  const renderedTimeline = timeline
    .map((entry) => {
      if (entry.entryType === 'message' && entry.role && typeof entry.text === 'string') {
        const speaker = entry.role === 'user' ? 'User' : 'Assistant';
        return `${speaker}: ${entry.text}`;
      }

      if (entry.entryType === 'tool') {
        return `Tool ${entry.toolName || 'tool'}: ${entry.subtitle || entry.title || ''}\n${entry.text || ''}`.trim();
      }

      if (entry.entryType === 'status') {
        return `Status: ${entry.title || entry.status || ''}${entry.subtitle ? ` — ${entry.subtitle}` : ''}`;
      }

      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  return [
    'הקשר משוחזר מתוך שיחה קודמת של Gemini.',
    `כותרת המקור: ${sourceTitle}`,
    sourceCwd ? `תיקיית המקור: ${sourceCwd}` : '',
    'שמור על כל ההקשר הבא והמשך בדיוק מאותה נקודה.',
    renderedTimeline,
  ].filter(Boolean).join('\n\n');
}

function buildPromptWithAttachments(
  prompt: string,
  attachments: CodexUploadedAttachment[],
  options: {
    cwdContext?: string | null;
    injectDirectoryContext?: boolean;
  } = {}
): string {
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
    return [...sections, prompt.trim()].filter(Boolean).join('\n\n');
  }

  const attachmentLines = attachments.map((attachment) => {
    const typeLabel = attachment.isImage ? 'image' : 'file';
    return `- ${attachment.name} (${typeLabel}, ${attachment.mimeType || 'unknown'}) => ${attachment.path}`;
  });

  return [
    ...sections,
    prompt.trim(),
    `Attached files available in the workspace:\n${attachmentLines.join('\n')}\nInspect these files directly if they are relevant to the request.`,
  ].filter(Boolean).join('\n\n');
}

function normalizeGeminiExecutionConfig(executionConfig?: CodexExecutionConfig | null): CodexExecutionConfig {
  const model = normalizeString(executionConfig?.model);
  const reasoningEffort = normalizeGeminiReasoningEffort(executionConfig?.reasoningEffort);
  return {
    model,
    reasoningEffort,
  };
}

function buildGeminiAliasModelSettings(
  actualModel: string,
  reasoningEffort: string
): { alias: string; settingsJson: string } {
  const budget = THINKING_BUDGET_BY_EFFORT[reasoningEffort] ?? THINKING_BUDGET_BY_EFFORT.medium;
  const alias = `code-ai-${actualModel.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${reasoningEffort}`;

  return {
    alias,
    settingsJson: JSON.stringify({
      modelConfigs: {
        customAliases: {
          [alias]: {
            modelConfig: {
              model: actualModel,
              generateContentConfig: {
                thinkingConfig: {
                  thinkingBudget: budget,
                },
              },
            },
          },
        },
      },
    }, null, 2),
  };
}

function collectGeminiArgs(
  sessionId: string | undefined,
  executionConfig: CodexExecutionConfig | null | undefined,
  includeDirectories: string[],
  resolvedModel: string
): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--skip-trust',
    '--approval-mode',
    'yolo',
    '--model',
    resolvedModel,
    '--prompt',
    '',
  ];

  for (const directory of includeDirectories) {
    args.push('--include-directories', directory);
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  return args;
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

function resolveProfile(profileId?: string): CodexProfile {
  const profile = CANDIDATE_PROFILES.find((candidate) => candidate.id === profileId)
    || CANDIDATE_PROFILES.find((candidate) => candidate.defaultProfile)
    || CANDIDATE_PROFILES[0];

  if (!profile) {
    throw new Error('No Gemini profile is configured');
  }

  return profile;
}

async function resolveRunCwd(profile: CodexProfile, sessionId?: string): Promise<string> {
  if (!sessionId) {
    return profile.workspaceCwd;
  }

  const sessionRecord = await resolveGeminiSessionRecord(profile, sessionId);
  return sessionRecord?.cwd || profile.workspaceCwd;
}

function compareGeminiModels(left: GeminiModelDescriptor, right: GeminiModelDescriptor): number {
  const leftRank = PREFERRED_MODEL_ORDER.indexOf(left.slug);
  const rightRank = PREFERRED_MODEL_ORDER.indexOf(right.slug);
  const normalizedLeftRank = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
  const normalizedRightRank = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
  return normalizedLeftRank - normalizedRightRank || left.displayName.localeCompare(right.displayName);
}

function resolvePreferredGeminiModel(models: GeminiModelDescriptor[]): string | null {
  const preferred = models.find((model) => PREFERRED_MODEL_ORDER.includes(model.slug));
  return preferred?.slug || models[0]?.slug || null;
}

async function fetchGeminiApiModels(profile: CodexProfile): Promise<GeminiModelDescriptor[]> {
  const envValues = await readProfileEnv(profile);
  const apiKey = envValues.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return [];
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!response.ok) {
    throw new Error(`Gemini models request failed with status ${response.status}`);
  }

  const payload = await response.json() as {
    models?: Array<Record<string, unknown>>;
  };
  const rows = Array.isArray(payload.models) ? payload.models : [];
  const models = rows
    .filter((row) => Array.isArray(row.supportedGenerationMethods) && row.supportedGenerationMethods.includes('generateContent'))
    .map((row) => ({
      slug: String(row.name || '').replace(/^models\//, ''),
      displayName: normalizeString(row.displayName) || String(row.name || '').replace(/^models\//, ''),
      description: normalizeString(row.description),
      inputTokenLimit: parseNumber(row.inputTokenLimit),
      thinking: row.thinking === true,
    }))
    .filter((row) => row.slug);

  models.sort(compareGeminiModels);

  await ensureRuntimeStateLoaded();
  for (const model of models) {
    if (model.inputTokenLimit) {
      runtimeState.modelContextWindows[model.slug] = model.inputTokenLimit;
    }
  }
  await persistRuntimeState();

  return models;
}

export function resolveGeminiProfile(profileId?: string): CodexProfile {
  return resolveProfile(profileId);
}

export async function getAvailableGeminiProfiles(): Promise<CodexProfile[]> {
  const available: CodexProfile[] = [];

  for (const profile of CANDIDATE_PROFILES) {
    const hasHome = await pathExists(profile.codexHome);
    const hasEnv = await pathExists(path.join(profile.codexHome, '.env'));
    const hasOAuth = await pathExists(path.join(profile.codexHome, 'oauth_creds.json'));
    const hasTmp = await pathExists(path.join(profile.codexHome, 'tmp'));

    if (hasHome && (hasEnv || hasOAuth || hasTmp)) {
      available.push(profile);
    }
  }

  return available;
}

export async function getGeminiModelCatalog(profileId?: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  const cached = modelCatalogCache.get(profile.id);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      models: cached.catalog.models.map((model) => ({
        ...model,
        supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
      })),
      selectedModel: cached.catalog.selectedModel,
      selectedReasoningEffort: cached.catalog.selectedReasoningEffort,
    };
  }

  await ensureRuntimeStateLoaded();
  const apiModels = await fetchGeminiApiModels(profile);
  const observedSessions = await scanGeminiSessionFiles(profile);
  const observedModels = new Set(
    observedSessions
      .map((session) => session.modelProvider)
      .filter((value): value is string => Boolean(value))
  );

  for (const observedModel of observedModels) {
    if (!apiModels.some((model) => model.slug === observedModel)) {
      apiModels.push({
        slug: observedModel,
        displayName: observedModel,
        description: observedModel,
        inputTokenLimit: runtimeState.modelContextWindows[observedModel] || null,
        thinking: true,
      });
    }
  }

  apiModels.sort(compareGeminiModels);

  const selectedModel = runtimeState.profiles[profile.id]?.model
    || resolvePreferredGeminiModel(apiModels);
  const selectedReasoningEffort = runtimeState.profiles[profile.id]?.selectedReasoningEffort
    || (selectedModel && apiModels.find((model) => model.slug === selectedModel)?.thinking ? 'medium' : null);

  const catalog: CodexModelCatalog = {
    models: apiModels.map((model): CodexAvailableModel => ({
      slug: model.slug,
      displayName: model.displayName,
      description: model.description,
      defaultReasoningLevel: model.thinking ? 'medium' : null,
      supportedReasoningLevels: model.thinking
        ? SUPPORTED_REASONING_LEVELS.map((level) => ({ ...level }))
        : [],
      isConfiguredDefault: model.slug === selectedModel,
    })),
    selectedModel,
    selectedReasoningEffort,
  };

  modelCatalogCache.set(profile.id, {
    expiresAt: Date.now() + GEMINI_MODEL_CACHE_TTL_MS,
    catalog,
  });

  return {
    models: catalog.models.map((model) => ({
      ...model,
      supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
    })),
    selectedModel: catalog.selectedModel,
    selectedReasoningEffort: catalog.selectedReasoningEffort,
  };
}

export async function listGeminiSessions(
  profileId?: string,
  query = '',
  limit = MAX_SESSIONS
): Promise<CodexSessionSummary[]> {
  const profile = resolveProfile(profileId);
  const sessionFiles = await scanGeminiSessionFiles(profile);
  const draftSessions = await listForkDraftSessions(profile.id);
  const normalizedQuery = query.trim().toLowerCase();
  const summaries: CodexSessionSummary[] = [];

  for (const sessionFile of sessionFiles) {
    const hints = await extractGeminiSessionSummaryHints(sessionFile.path, sessionFile.id);
    const forkMetadata = await getForkSessionMetadata(sessionFile.id);
    const matchHaystack = `${hints.title}\n${hints.preview}\n${sessionFile.id}\n${sessionFile.cwd || ''}\n${forkMetadata?.sourceTitle || ''}`.toLowerCase();

    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: sessionFile.id,
      title: hints.title,
      updatedAt: sessionFile.updatedAt,
      createdAt: sessionFile.createdAt,
      profileId: profile.id,
      cwd: sessionFile.cwd,
      messageCount: 0,
      preview: hints.preview,
      startPreview: hints.startPreview,
      endPreview: hints.endPreview,
      path: sessionFile.path,
      source: sessionFile.source,
      forkSourceSessionId: forkMetadata?.sourceSessionId || null,
      forkEntryId: forkMetadata?.forkEntryId || null,
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

    const parsed = buildDraftParsedSession(draft);
    const matchHaystack = `${parsed.title}\n${parsed.preview}\n${draft.sessionId}\n${draft.sourceSessionId}\n${draft.sourceTitle}\n${draft.sourceCwd || ''}`.toLowerCase();
    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: draft.sessionId,
      title: parsed.title,
      updatedAt: draft.updatedAt,
      createdAt: draft.createdAt,
      profileId: draft.profileId,
      cwd: draft.sourceCwd,
      messageCount: parsed.messages.length,
      preview: parsed.preview,
      startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
      endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
      path: draft.sessionId,
      source: 'fork-draft',
      forkSourceSessionId: draft.sourceSessionId,
      forkEntryId: draft.forkEntryId,
      isDraft: true,
    });
  }

  return summaries
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.min(limit, MAX_SESSIONS));
}

export async function getGeminiSessionDetail(
  sessionId: string,
  profileId?: string,
  options?: {
    tail?: number;
    before?: number;
    full?: boolean;
  }
): Promise<CodexSessionDetail> {
  const profile = resolveProfile(profileId);
  const sessionFile = await resolveGeminiSessionRecord(profile, sessionId);

  if (!sessionFile) {
    const forkDraft = await getForkDraftSession(sessionId);
    if (!forkDraft || forkDraft.profileId !== profile.id) {
      throw new Error(`Session ${sessionId} was not found`);
    }

    const parsed = buildDraftParsedSession(forkDraft);
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

    return {
      id: forkDraft.sessionId,
      title: parsed.title,
      updatedAt: forkDraft.updatedAt,
      createdAt: forkDraft.createdAt,
      profileId: profile.id,
      messageCount: parsed.messages.length,
      preview: parsed.preview,
      startPreview: parsed.messages[0]?.text ? trimPreview(parsed.messages[0].text) : parsed.title,
      endPreview: parsed.messages.at(-1)?.text ? trimPreview(parsed.messages.at(-1)!.text) : parsed.preview,
      path: forkDraft.sessionId,
      source: 'fork-draft',
      cwd: forkDraft.sourceCwd,
      forkSourceSessionId: forkDraft.sourceSessionId,
      forkEntryId: forkDraft.forkEntryId,
      modelProvider: null,
      messages: timelineWindowStart === 0 && requestedTail >= totalTimelineEntries ? parsed.messages : [],
      timeline,
      totalTimelineEntries,
      timelineWindowStart,
      timelineWindowEnd,
      hasEarlierTimeline: timelineWindowStart > 0,
      isDraft: true,
      forkDraftContext: {
        ...forkDraft,
        timeline: forkDraft.timeline.map((entry) => ({ ...entry })),
      },
    };
  }

  await ensureRuntimeStateLoaded();
  const parsedBase = await parseGeminiSessionFile(sessionFile.path, sessionId);
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
    forkSourceSessionId: forkMetadata?.sourceSessionId || null,
    forkEntryId: forkMetadata?.forkEntryId || null,
    modelProvider: parsed.modelProvider,
    messages: timelineWindowStart === 0 && requestedTail >= totalTimelineEntries ? parsed.messages : [],
    timeline,
    totalTimelineEntries,
    timelineWindowStart,
    timelineWindowEnd,
    hasEarlierTimeline: timelineWindowStart > 0,
  };
}

export async function getGeminiRateLimitSnapshot(
  profileId?: string,
  sessionId?: string
): Promise<CodexRateLimitSnapshot | null> {
  const profile = resolveProfile(profileId);
  await ensureRuntimeStateLoaded();

  if (sessionId?.trim()) {
    const sessionRecord = await resolveGeminiSessionRecord(profile, sessionId.trim());
    const sessionSnapshot = runtimeState.sessions[sessionId.trim()] || null;
    if (!sessionRecord && !sessionSnapshot) {
      return null;
    }

    const parsed = sessionRecord ? await parseGeminiSessionFile(sessionRecord.path, sessionId.trim()) : null;
    return {
      profileId: profile.id,
      sessionId: sessionId.trim(),
      updatedAt: sessionSnapshot?.updatedAt || sessionRecord?.updatedAt || null,
      planType: sessionSnapshot?.planType || 'api-key',
      rateLimitReachedType: null,
      primary: null,
      secondary: null,
      context: parsed?.context || cloneContextSnapshot(sessionSnapshot?.context || null),
    };
  }

  const profileSnapshot = runtimeState.profiles[profile.id] || null;
  if (!profileSnapshot) {
    return null;
  }

  return {
    profileId: profile.id,
    sessionId: profileSnapshot.sessionId,
    updatedAt: profileSnapshot.updatedAt,
    planType: profileSnapshot.planType || 'api-key',
    rateLimitReachedType: null,
    primary: null,
    secondary: null,
    context: cloneContextSnapshot(profileSnapshot.context),
  };
}

function sanitizeGeminiCliFailure(rawText: string, fallbackMessage: string): string {
  const sanitized = (rawText || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  return sanitized || fallbackMessage;
}

async function waitForGeminiSessionReady(
  profile: CodexProfile,
  sessionId: string,
  previousUpdatedAt?: string | null,
  timeoutMs = 6000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sessionRecord = await resolveGeminiSessionRecord(profile, sessionId);
    if (sessionRecord) {
      if (!previousUpdatedAt || sessionRecord.updatedAt > previousUpdatedAt) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runGeminiPrompt(
  prompt: string,
  sessionId?: string,
  profileId?: string,
  attachments: CodexUploadedAttachment[] = [],
  options: {
    runId?: string;
    cwd?: string;
    injectDirectoryContext?: boolean;
    executionConfig?: CodexExecutionConfig | null;
    contextPrefix?: string | null;
  } = {}
): Promise<GeminiRunResult> {
  const profile = resolveProfile(profileId);
  const executionConfig = normalizeGeminiExecutionConfig(options.executionConfig);
  const activeRunId = normalizeString(options.runId);
  const sessionKey = sessionId || profile.id;
  const previousSession = sessionId ? await resolveGeminiSessionRecord(profile, sessionId) : null;
  const envValues = await readProfileEnv(profile);
  const runCwd = options.cwd || await resolveRunCwd(profile, sessionId);
  const includeDirectories = Array.from(new Set([
    runCwd,
    CODEX_APP_CONFIG.uploadRoot,
    ...attachments.map((attachment) => path.dirname(attachment.path)),
  ].filter(Boolean)));

  const basePrompt = buildPromptWithAttachments(prompt, attachments, {
    cwdContext: runCwd,
    injectDirectoryContext: options.injectDirectoryContext,
  });
  const promptText = [options.contextPrefix?.trim() || '', basePrompt].filter(Boolean).join('\n\n').trim();
  const modelCatalog = await getGeminiModelCatalog(profile.id);
  const requestedModel = executionConfig.model || modelCatalog.selectedModel || resolvePreferredGeminiModel(
    modelCatalog.models.map((model) => ({
      slug: model.slug,
      displayName: model.displayName,
      description: model.description,
      inputTokenLimit: runtimeState.modelContextWindows[model.slug] || null,
      thinking: model.supportedReasoningLevels.length > 0,
    }))
  ) || 'gemini-2.5-flash';

  return queueBySessionKey(sessionKey, async () => {
    let temporarySettingsPath: string | null = null;
    let resolvedModel = requestedModel;

    if (executionConfig.reasoningEffort) {
      const aliasConfig = buildGeminiAliasModelSettings(requestedModel, executionConfig.reasoningEffort);
      temporarySettingsPath = path.join(CODEX_APP_CONFIG.queueRoot, `gemini-settings-${randomUUID()}.json`);
      await fs.mkdir(path.dirname(temporarySettingsPath), { recursive: true });
      await fs.writeFile(temporarySettingsPath, aliasConfig.settingsJson, 'utf-8');
      resolvedModel = aliasConfig.alias;
    }

    const env = buildGeminiProcessEnv(profile, envValues, temporarySettingsPath);
    const args = collectGeminiArgs(sessionId, executionConfig, includeDirectories, resolvedModel);

    try {
      return await new Promise<GeminiRunResult>((resolve, reject) => {
        const child = spawn(GEMINI_BIN, args, {
          cwd: runCwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (activeRunId) {
          activeGeminiRuns.set(activeRunId, {
            child,
            cancelRequested: false,
          });
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let createdSessionId: string | null = sessionId || null;
        let finalMessage = '';
        let latestModel: string | null = requestedModel;
        let latestContext: CodexContextUsageSnapshot | null = null;
        let resultErrorMessage: string | null = null;

        function wasCancellationRequested(): boolean {
          return activeRunId ? activeGeminiRuns.get(activeRunId)?.cancelRequested === true : false;
        }

        function clearActiveRun() {
          if (activeRunId && activeGeminiRuns.get(activeRunId)?.child === child) {
            activeGeminiRuns.delete(activeRunId);
          }
        }

        child.stdin.on('error', () => {
          // Ignore EPIPE when the process exits early.
        });
        child.stdin.end(promptText);

        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');

        child.stdout.on('data', (chunk: string) => {
          stdoutBuffer += chunk;

          while (stdoutBuffer.includes('\n')) {
            const newlineIndex = stdoutBuffer.indexOf('\n');
            const line = stdoutBuffer.slice(0, newlineIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

            if (!line) {
              continue;
            }

            const row = safeJsonParse<any>(line);
            if (!row) {
              continue;
            }

            if (row.type === 'init') {
              createdSessionId = normalizeString(row.session_id) || createdSessionId;
              latestModel = normalizeString(row.model) || latestModel;
              continue;
            }

            if (row.type === 'message' && row.role === 'assistant' && typeof row.content === 'string') {
              finalMessage += row.content;
              continue;
            }

            if (row.type === 'result') {
              if (row.status === 'error') {
                resultErrorMessage = normalizeString(row.error?.message) || 'Gemini returned an error';
              }
              if (row.stats?.models && typeof row.stats.models === 'object') {
                const modelEntries = Object.entries(row.stats.models as Record<string, any>);
                if (modelEntries.length > 0) {
                  latestModel = normalizeString(modelEntries[modelEntries.length - 1][0]) || latestModel;
                }
              }
              const inputTokens = parseNumber(row.stats?.input_tokens ?? row.stats?.input);
              const cachedInputTokens = parseNumber(row.stats?.cached);
              const contextWindow = latestModel ? runtimeState.modelContextWindows[latestModel] || null : null;
              latestContext = (
                inputTokens !== null || cachedInputTokens !== null || contextWindow !== null
              ) ? {
                modelContextWindow: contextWindow,
                inputTokens,
                cachedInputTokens,
                usagePercent: (
                  contextWindow !== null
                  && contextWindow > 0
                  && inputTokens !== null
                ) ? Math.min(100, Math.max(0, (inputTokens / contextWindow) * 100)) : null,
              } : latestContext;
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
            reject(new GeminiRunCancelledError());
            return;
          }
          reject(error);
        });

        child.on('close', async (code) => {
          const cancelled = wasCancellationRequested();
          clearActiveRun();

          if (cancelled) {
            reject(new GeminiRunCancelledError());
            return;
          }

          if (resultErrorMessage) {
            reject(new Error(resultErrorMessage));
            return;
          }

          if (code !== 0) {
            reject(new Error(sanitizeGeminiCliFailure(stderrBuffer, `Gemini exited with code ${code}`)));
            return;
          }

          if (!createdSessionId) {
            reject(new Error('Gemini completed without returning a session id'));
            return;
          }

          await waitForGeminiSessionReady(profile, createdSessionId, previousSession?.updatedAt || null);
          const sessionRecord = await resolveGeminiSessionRecord(profile, createdSessionId);
          const parsedSession = sessionRecord
            ? await parseGeminiSessionFile(sessionRecord.path, createdSessionId)
            : null;
          const effectiveContext = parsedSession?.context || latestContext;
          const effectiveModel = parsedSession?.modelProvider || latestModel;

          await updateRuntimeSnapshot({
            profileId: profile.id,
            sessionId: createdSessionId,
            updatedAt: new Date().toISOString(),
            planType: envValues.GEMINI_API_KEY ? 'api-key' : 'oauth',
            rateLimitReachedType: null,
            model: effectiveModel,
            selectedReasoningEffort: executionConfig.reasoningEffort,
            context: cloneContextSnapshot(effectiveContext),
          });

          resolve({
            sessionId: createdSessionId,
            finalMessage: finalMessage.trim() || parsedSession?.messages.at(-1)?.text || 'Gemini completed without a final assistant message.',
          });
        });
      });
    } finally {
      if (temporarySettingsPath) {
        await fs.rm(temporarySettingsPath, { force: true });
      }
    }
  });
}

export async function createGeminiForkSession(
  sourceSessionId: string,
  forkEntryId: string,
  profileId?: string
): Promise<{
  sessionId: string;
  forkedAt: string;
}> {
  const sourceSession = await getGeminiSessionDetail(sourceSessionId, profileId, { full: true });
  const entryIndex = sourceSession.timeline.findIndex((entry) => entry.id === forkEntryId);

  if (entryIndex === -1) {
    throw new Error('לא ניתן לאתר את נקודת המזלוג שנבחרה.');
  }

  const slicedTimeline = sourceSession.timeline.slice(0, entryIndex + 1).map((entry) => ({ ...entry }));
  const selectedEntry = slicedTimeline.at(-1);
  const promptPreview = trimPreview(
    (selectedEntry?.entryType === 'message' && typeof selectedEntry.text === 'string' ? selectedEntry.text : '')
      || sourceSession.title,
    72
  );
  const draft = await createForkDraftSession({
    profileId: sourceSession.profileId,
    sourceSessionId: sourceSession.id,
    sourceTitle: sourceSession.title,
    sourceCwd: sourceSession.cwd,
    forkEntryId,
    promptPreview,
    promptPrefix: buildForkPromptPrefix(sourceSession.title, sourceSession.cwd, slicedTimeline),
    timeline: slicedTimeline,
  });

  return {
    sessionId: draft.sessionId,
    forkedAt: selectedEntry?.timestamp || new Date().toISOString(),
  };
}

export function cancelGeminiRun(runId: string): boolean {
  const activeRun = activeGeminiRuns.get(runId);
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
    }, 1200).unref();
  }

  return true;
}
