import { spawn, spawnSync } from 'child_process';
import { existsSync, createReadStream, promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import {
  createForkDraftSession,
  getForkDraftSession,
  getForkSessionMetadata,
  listForkDraftSessions,
  type CodexForkContext,
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
  CodexRateLimitWindow,
  CodexReasoningLevelOption,
  CodexSessionDetail,
  CodexSessionMessage,
  CodexSessionSummary,
  CodexTimelineEntry,
  CodexUploadedAttachment,
} from './codexService.js';

interface ClaudeSessionScanRecord {
  id: string;
  path: string;
  updatedAt: string;
  createdAt: string | null;
  cwd: string | null;
  modelProvider: string | null;
  source: string;
}

interface ClaudeSettings {
  model?: unknown;
  effortLevel?: unknown;
  availableModels?: unknown;
}

interface ClaudeAuthStatusResponse {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  subscriptionType?: string;
}

interface ClaudeOauthTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeOauthTokens;
  organizationUuid?: string;
}

interface ParsedClaudeSession {
  title: string;
  preview: string;
  messages: CodexSessionMessage[];
  timeline: CodexTimelineEntry[];
  modelProvider: string | null;
  context: CodexContextUsageSnapshot | null;
}

interface ClaudeRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
}

interface ClaudeOauthUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface ClaudeOauthUsageResponse {
  five_hour?: ClaudeOauthUsageWindow | null;
  seven_day?: ClaudeOauthUsageWindow | null;
}

interface ClaudeRuntimeSnapshot {
  profileId: string;
  sessionId: string | null;
  updatedAt: string;
  planType: string | null;
  rateLimitReachedType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  context: CodexContextUsageSnapshot | null;
  model: string | null;
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
}

interface ClaudeRuntimeState {
  profiles: Record<string, ClaudeRuntimeSnapshot>;
  sessions: Record<string, ClaudeRuntimeSnapshot>;
  modelContextWindows: Record<string, number>;
}

interface ClaudeRunResult {
  sessionId: string;
  finalMessage: string;
}

interface ClaudeActiveRun {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
}

const DEFAULT_CLAUDE_BIN_CANDIDATES = [
  process.env.CLAUDE_BIN?.trim(),
  'claude',
  '/home/developer/.vscode-server/extensions/anthropic.claude-code-2.1.126-linux-x64/resources/native-binary/claude',
].filter((value): value is string => Boolean(value));
const CLAUDE_BIN = DEFAULT_CLAUDE_BIN_CANDIDATES.find((candidate) => candidate.includes('/') ? existsSync(candidate) : false)
  || DEFAULT_CLAUDE_BIN_CANDIDATES[0]
  || 'claude';
const DEFAULT_PROFILE_ID = CODEX_APP_CONFIG.defaultProfileId;
const MAX_SESSIONS = 80;
const MODEL_CATALOG_CACHE_TTL_MS = 60_000;
const AUTH_STATUS_CACHE_TTL_MS = 60_000;
const CLAUDE_USAGE_CACHE_TTL_MS = 20_000;
const CLAUDE_RUNTIME_STATE_FILE = path.join(CODEX_APP_CONFIG.queueRoot, 'claude-runtime-state.json');
const CLAUDE_CREDENTIALS_FILE = '.credentials.json';
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SUPPORTED_REASONING_LEVELS: CodexReasoningLevelOption[] = [
  { effort: 'low', description: null },
  { effort: 'medium', description: null },
  { effort: 'high', description: null },
  { effort: 'xhigh', description: null },
  { effort: 'max', description: null },
];
const CANDIDATE_PROFILES: CodexProfile[] = CODEX_APP_CONFIG.profiles.filter((profile) => profile.provider === 'claude');
const modelCatalogCache = new Map<string, {
  expiresAt: number;
  models: CodexAvailableModel[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
}>();
const queueTails = new Map<string, Promise<void>>();
const activeClaudeRuns = new Map<string, ClaudeActiveRun>();
const authStatusCache = new Map<string, {
  expiresAt: number;
  value: ClaudeAuthStatusResponse | null;
}>();
const usageCache = new Map<string, {
  expiresAt: number;
  value: { primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null } | null;
}>();
let runtimeStateLoadPromise: Promise<void> | null = null;
let runtimeStatePersistTail: Promise<void> = Promise.resolve();

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
let runtimeState: ClaudeRuntimeState = {
  profiles: {},
  sessions: {},
  modelContextWindows: {},
};

export class ClaudeRunCancelledError extends Error {
  constructor(message = 'Claude run was stopped') {
    super(message);
    this.name = 'ClaudeRunCancelledError';
  }
}

function trimPreview(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function clipLongText(text: string, limit = 12_000): string {
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

function normalizeReasoningEffort(value: unknown): string | null {
  const normalized = normalizeString(value)?.toLowerCase() || null;
  if (!normalized) {
    return null;
  }

  return SUPPORTED_REASONING_LEVELS.some((level) => level.effort === normalized)
    ? normalized
    : null;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeClaudeProjectKey(cwd: string): string {
  return path.resolve(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function getClaudeProjectsRoot(profile: CodexProfile): string {
  return path.join(profile.codexHome, 'projects');
}

function getClaudeProjectRoot(profile: CodexProfile): string {
  return path.join(getClaudeProjectsRoot(profile), sanitizeClaudeProjectKey(profile.workspaceCwd));
}

function getClaudeCredentialsPath(profile: CodexProfile): string {
  return path.join(profile.codexHome, CLAUDE_CREDENTIALS_FILE);
}

async function readClaudeCredentials(profile: CodexProfile): Promise<ClaudeCredentialsFile | null> {
  try {
    const raw = await fs.readFile(getClaudeCredentialsPath(profile), 'utf-8');
    return safeJsonParse<ClaudeCredentialsFile>(raw);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function writeClaudeCredentials(profile: CodexProfile, credentials: ClaudeCredentialsFile): Promise<void> {
  await fs.mkdir(profile.codexHome, { recursive: true });
  await fs.writeFile(getClaudeCredentialsPath(profile), JSON.stringify(credentials, null, 2), 'utf-8');
}

function buildClaudeProcessEnv(profile: CodexProfile): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.dirname(profile.codexHome),
    CLAUDE_HOME: profile.codexHome,
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

  if (toolName.toLowerCase() === 'bash' && typeof candidate.command === 'string') {
    return trimPreview(candidate.command, 160);
  }

  if (typeof candidate.file_path === 'string') {
    return trimPreview(candidate.file_path, 160);
  }

  if (typeof candidate.path === 'string') {
    return trimPreview(candidate.path, 160);
  }

  if (typeof candidate.prompt === 'string') {
    return trimPreview(candidate.prompt, 160);
  }

  return trimPreview(JSON.stringify(input), 160);
}

function extractToolResultText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
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

        if (typeof candidate.content === 'string') {
          return [candidate.content];
        }

        return [];
      })
      .join('\n')
      .trim();
  }

  return '';
}

function extractUserPromptText(content: unknown): string {
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
      if (candidate.type === 'text' && typeof candidate.text === 'string') {
        return [candidate.text];
      }

      return [];
    })
    .join('\n')
    .trim();
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

function parseClaudeContextUsage(
  usage: Record<string, unknown> | null | undefined,
  contextWindow: number | null
): CodexContextUsageSnapshot | null {
  if (!usage && contextWindow === null) {
    return null;
  }

  const inputTokens = parseNumber(usage?.input_tokens);
  const cacheReadInputTokens = parseNumber(usage?.cache_read_input_tokens);
  const cacheCreationInputTokens = parseNumber(usage?.cache_creation_input_tokens);
  const cachedInputTokens = (
    cacheReadInputTokens !== null || cacheCreationInputTokens !== null
  )
    ? (cacheReadInputTokens || 0) + (cacheCreationInputTokens || 0)
    : null;
  const totalInputTokens = (
    inputTokens !== null || cachedInputTokens !== null
  )
    ? (inputTokens || 0) + (cachedInputTokens || 0)
    : null;
  const usagePercent = (
    contextWindow !== null
    && contextWindow > 0
    && totalInputTokens !== null
  )
    ? Math.min(100, Math.max(0, (totalInputTokens / contextWindow) * 100))
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

function displayClaudeModelName(model: string): string {
  if (!model.startsWith('claude-')) {
    return model;
  }

  return model
    .replace(/^claude-/, 'Claude ')
    .replace(/-([0-9]+)-([0-9]+)$/i, ' $1.$2')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function ensureRuntimeStateLoaded() {
  if (!runtimeStateLoadPromise) {
    runtimeStateLoadPromise = (async () => {
      await fs.mkdir(path.dirname(CLAUDE_RUNTIME_STATE_FILE), { recursive: true });
      try {
        const raw = await fs.readFile(CLAUDE_RUNTIME_STATE_FILE, 'utf-8');
        const parsed = safeJsonParse<Partial<ClaudeRuntimeState>>(raw);
        runtimeState = {
          profiles: parsed?.profiles && typeof parsed.profiles === 'object' ? parsed.profiles as Record<string, ClaudeRuntimeSnapshot> : {},
          sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions as Record<string, ClaudeRuntimeSnapshot> : {},
          modelContextWindows: parsed?.modelContextWindows && typeof parsed.modelContextWindows === 'object'
            ? parsed.modelContextWindows as Record<string, number>
            : {},
        };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    })();
  }

  await runtimeStateLoadPromise;
}

async function persistRuntimeState() {
  const snapshot = JSON.stringify(runtimeState, null, 2);
  runtimeStatePersistTail = runtimeStatePersistTail.then(async () => {
    await fs.mkdir(path.dirname(CLAUDE_RUNTIME_STATE_FILE), { recursive: true });
    await fs.writeFile(CLAUDE_RUNTIME_STATE_FILE, snapshot, 'utf-8');
  });
  await runtimeStatePersistTail;
}

function cloneRateLimitWindow(window: CodexRateLimitWindow | null): CodexRateLimitWindow | null {
  return window ? { ...window } : null;
}

function cloneContextSnapshot(context: CodexContextUsageSnapshot | null): CodexContextUsageSnapshot | null {
  if (!context) {
    return null;
  }

  const totalInputTokens = (
    context.inputTokens !== null
    || context.cachedInputTokens !== null
  )
    ? (context.inputTokens || 0) + (context.cachedInputTokens || 0)
    : null;
  const usagePercent = (
    context.modelContextWindow !== null
    && context.modelContextWindow > 0
    && totalInputTokens !== null
  )
    ? Math.min(100, Math.max(0, (totalInputTokens / context.modelContextWindow) * 100))
    : context.usagePercent;

  return {
    ...context,
    usagePercent,
  };
}

function cloneRuntimeSnapshot(snapshot: ClaudeRuntimeSnapshot | null): ClaudeRuntimeSnapshot | null {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    primary: cloneRateLimitWindow(snapshot.primary),
    secondary: cloneRateLimitWindow(snapshot.secondary),
    context: cloneContextSnapshot(snapshot.context),
    tools: snapshot.tools ? [...snapshot.tools] : undefined,
    mcpServers: snapshot.mcpServers ? snapshot.mcpServers.map((server) => ({ ...server })) : undefined,
  };
}

async function updateRuntimeSnapshot(snapshot: ClaudeRuntimeSnapshot) {
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

function buildRateLimitWindowFromClaudeEvent(
  info: ClaudeRateLimitInfo | null | undefined
): CodexRateLimitWindow | null {
  const resetsAt = parseNumber(info?.resetsAt);
  if (resetsAt === null) {
    return null;
  }

  return {
    usedPercent: null,
    windowMinutes: info?.rateLimitType === 'five_hour' ? 300 : null,
    resetsAt,
    resetsAtIso: new Date(resetsAt * 1000).toISOString(),
  };
}

function isClaudeOauthTokenExpiring(expiresAt: number | null | undefined): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5 * 60 * 1000;
}

async function getClaudeOauthTokens(profile: CodexProfile): Promise<ClaudeOauthTokens | null> {
  const credentials = await readClaudeCredentials(profile);
  return credentials?.claudeAiOauth || null;
}

async function refreshClaudeOauthTokens(profile: CodexProfile, tokens: ClaudeOauthTokens): Promise<ClaudeOauthTokens | null> {
  const refreshToken = normalizeString(tokens.refreshToken);
  if (!refreshToken) {
    return null;
  }

  const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: Array.isArray(tokens.scopes) ? tokens.scopes.join(' ') : undefined,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  } | null;

  const accessToken = normalizeString(payload?.access_token);
  if (!accessToken) {
    return null;
  }

  const refreshed: ClaudeOauthTokens = {
    accessToken,
    refreshToken: normalizeString(payload?.refresh_token) || refreshToken,
    expiresAt: (() => {
      const expiresInSeconds = parseNumber(payload?.expires_in);
      return expiresInSeconds !== null ? Date.now() + expiresInSeconds * 1000 : tokens.expiresAt;
    })(),
    scopes: typeof payload?.scope === 'string'
      ? payload.scope.split(/\s+/).map((value) => value.trim()).filter(Boolean)
      : (tokens.scopes || []),
    subscriptionType: tokens.subscriptionType || null,
    rateLimitTier: tokens.rateLimitTier || null,
  };

  const credentials = await readClaudeCredentials(profile) || {};
  credentials.claudeAiOauth = refreshed;
  await writeClaudeCredentials(profile, credentials);
  return refreshed;
}

function buildRateLimitWindowFromClaudeUsage(
  info: ClaudeOauthUsageWindow | null | undefined,
  windowMinutes: number | null
): CodexRateLimitWindow | null {
  const usedPercent = parseNumber(info?.utilization);
  const resetsAtIso = normalizeString(info?.resets_at);
  const resetsAtMs = resetsAtIso ? Date.parse(resetsAtIso) : Number.NaN;

  if (usedPercent === null && !resetsAtIso) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes,
    resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : null,
    resetsAtIso: resetsAtIso || null,
  };
}

async function fetchClaudeUsageWindows(
  profile: CodexProfile
): Promise<{ primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null } | null> {
  const cached = usageCache.get(profile.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let tokens = await getClaudeOauthTokens(profile);
  if (!tokens?.accessToken) {
    usageCache.set(profile.id, { expiresAt: Date.now() + CLAUDE_USAGE_CACHE_TTL_MS, value: null });
    return null;
  }

  if (isClaudeOauthTokenExpiring(tokens.expiresAt)) {
    tokens = await refreshClaudeOauthTokens(profile, tokens) || tokens;
  }

  async function requestUsage(accessToken: string) {
    return fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
    });
  }

  let response = await requestUsage(tokens.accessToken);
  if ((response.status === 401 || response.status === 403) && normalizeString(tokens.refreshToken)) {
    const refreshed = await refreshClaudeOauthTokens(profile, tokens);
    if (refreshed?.accessToken) {
      tokens = refreshed;
      response = await requestUsage(tokens.accessToken);
    }
  }

  if (!response.ok) {
    usageCache.set(profile.id, { expiresAt: Date.now() + CLAUDE_USAGE_CACHE_TTL_MS, value: null });
    return null;
  }

  const payload = await response.json().catch(() => null) as ClaudeOauthUsageResponse | null;
  const value = {
    primary: buildRateLimitWindowFromClaudeUsage(payload?.five_hour, 300),
    secondary: buildRateLimitWindowFromClaudeUsage(payload?.seven_day, 10080),
  };

  usageCache.set(profile.id, {
    expiresAt: Date.now() + CLAUDE_USAGE_CACHE_TTL_MS,
    value,
  });
  return value;
}

async function readClaudeAuthStatus(profile: CodexProfile): Promise<ClaudeAuthStatusResponse | null> {
  const cached = authStatusCache.get(profile.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = spawnSync(CLAUDE_BIN, ['auth', 'status'], {
    encoding: 'utf-8',
    env: buildClaudeProcessEnv(profile),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });

  if (result.error || result.status !== 0) {
    authStatusCache.set(profile.id, {
      expiresAt: Date.now() + AUTH_STATUS_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }

  const payload = safeJsonParse<ClaudeAuthStatusResponse>((result.stdout || '').trim());
  authStatusCache.set(profile.id, {
    expiresAt: Date.now() + AUTH_STATUS_CACHE_TTL_MS,
    value: payload || null,
  });
  return authStatusCache.get(profile.id)?.value || null;
}

async function readClaudeSettings(profile: CodexProfile): Promise<ClaudeSettings> {
  const settingsPath = path.join(profile.codexHome, 'settings.json');

  try {
    const raw = await fs.readFile(settingsPath, 'utf-8');
    return safeJsonParse<ClaudeSettings>(raw) || {};
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {};
    }

    throw error;
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

function parseSessionTimestampFromLines(lines: string[]): string | null {
  for (const line of lines) {
    const row = safeJsonParse<Record<string, unknown>>(line);
    const timestamp = normalizeIsoTimestamp(row?.timestamp);
    if (timestamp) {
      return timestamp;
    }
  }

  return null;
}

function parseSessionCwdFromLines(lines: string[]): string | null {
  for (const line of lines) {
    const row = safeJsonParse<Record<string, unknown>>(line);
    const cwd = normalizeString(row?.cwd);
    if (cwd) {
      return cwd;
    }
  }

  return null;
}

function parseLatestModelFromLines(lines: string[]): string | null {
  let latestModel: string | null = null;

  for (const line of lines) {
    const row = safeJsonParse<any>(line);
    if (row?.type === 'assistant') {
      const model = normalizeString(row?.message?.model);
      if (model) {
        latestModel = model;
      }
    }
  }

  return latestModel;
}

async function scanClaudeSessionFiles(profile: CodexProfile): Promise<ClaudeSessionScanRecord[]> {
  const projectsRoot = getClaudeProjectsRoot(profile);
  if (!(await pathExists(projectsRoot))) {
    return [];
  }

  const projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const rows: ClaudeSessionScanRecord[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectRoot = path.join(projectsRoot, projectEntry.name);
    const entries = await fs.readdir(projectRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const filePath = path.join(projectRoot, entry.name);
      const headLines = await readFileHead(filePath);
      const tailLines = await readFileTail(filePath);
      const stats = await fs.stat(filePath);
      rows.push({
        id: entry.name.replace(/\.jsonl$/i, ''),
        path: filePath,
        updatedAt: stats.mtime.toISOString(),
        createdAt: parseSessionTimestampFromLines(headLines),
        cwd: parseSessionCwdFromLines(headLines) || profile.workspaceCwd,
        modelProvider: parseLatestModelFromLines(tailLines),
        source: 'claude-session',
      });
    }
  }

  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return rows;
}

async function resolveClaudeSessionRecord(profile: CodexProfile, sessionId: string): Promise<ClaudeSessionScanRecord | null> {
  const sessionFiles = await scanClaudeSessionFiles(profile);
  return sessionFiles.find((row) => row.id === sessionId) || null;
}

function buildDraftParsedSession(draft: CodexForkDraftSession): ParsedClaudeSession {
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
  parsed: ParsedClaudeSession,
  metadata: CodexForkSessionMetadata | null
): ParsedClaudeSession {
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

async function extractClaudeSessionSummaryHints(
  filePath: string,
  sessionId: string
): Promise<{
  title: string;
  preview: string;
  startPreview: string;
  endPreview: string;
}> {
  const headLines = await readFileHead(filePath);
  const tailLines = await readFileTail(filePath);
  let title: string | null = null;
  let startPreview: string | null = null;
  let endPreview: string | null = null;

  for (const line of headLines) {
    const row = safeJsonParse<any>(line);
    if (!row) {
      continue;
    }

    if (!title && row.type === 'ai-title') {
      title = normalizeString(row.aiTitle);
    }

    if (!startPreview && row.type === 'user') {
      startPreview = extractUserPromptText(row.message?.content);
    }

    if (!title && startPreview) {
      title = trimPreview(startPreview, 72);
    }

    if (title && startPreview) {
      break;
    }
  }

  for (const line of tailLines) {
    const row = safeJsonParse<any>(line);
    if (!row) {
      continue;
    }

    if (row.type === 'assistant') {
      const content = Array.isArray(row.message?.content) ? row.message.content : [];
      const textPart = content.find((part: any) => part?.type === 'text' && typeof part.text === 'string');
      if (textPart?.text?.trim()) {
        endPreview = textPart.text.trim();
      }
    }
  }

  const preview = trimPreview(endPreview || startPreview || title || sessionId);
  return {
    title: title || trimPreview(startPreview || sessionId, 72),
    preview,
    startPreview: trimPreview(startPreview || title || sessionId),
    endPreview: trimPreview(endPreview || preview),
  };
}

async function parseClaudeSessionFile(filePath: string, sessionId: string): Promise<ParsedClaudeSession> {
  const messages: CodexSessionMessage[] = [];
  const timeline: CodexTimelineEntry[] = [];
  const knownToolCalls = new Map<string, string>();
  let derivedTitle: string | null = null;
  let preview = '';
  let modelProvider: string | null = null;
  let latestContext: CodexContextUsageSnapshot | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
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

      const timestamp = normalizeIsoTimestamp(row.timestamp) || new Date().toISOString();

      if (row.type === 'queue-operation') {
        const operation = normalizeString(row.operation);
        if (operation === 'dequeue') {
          timeline.push({
            id: `${sessionId}-status-dequeue-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: buildStartedTaskTitle('claude'),
            subtitle: null,
            status: 'started',
          });
        }
        continue;
      }

      if (row.type === 'attachment') {
        if (row.attachment?.type === 'deferred_tools_delta' && Array.isArray(row.attachment?.addedNames) && row.attachment.addedNames.length > 0) {
          timeline.push({
            id: `${sessionId}-status-tools-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: 'כלים נוספו לסשן',
            subtitle: `${row.attachment.addedNames.length} כלים זמינים`,
            status: 'tools-ready',
          });
        }

        if (row.attachment?.type === 'skill_listing') {
          const skillCount = parseNumber(row.attachment?.skillCount);
          timeline.push({
            id: `${sessionId}-status-skills-${timeline.length}`,
            entryType: 'status',
            timestamp,
            title: 'Skills נטענו',
            subtitle: skillCount !== null ? `${skillCount} skills` : null,
            status: 'skills-ready',
          });
        }
        continue;
      }

      if (row.type === 'ai-title') {
        derivedTitle = normalizeString(row.aiTitle) || derivedTitle;
        continue;
      }

      if (row.type === 'user') {
        const text = extractUserPromptText(row.message?.content);
        if (text) {
          const entryId = normalizeString(row.uuid) || `${sessionId}-user-${messages.length}`;
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
          if (!derivedTitle) {
            derivedTitle = trimPreview(text, 72);
          }
        }

        if (Array.isArray(row.message?.content)) {
          for (const part of row.message.content) {
            if (part?.type !== 'tool_result') {
              continue;
            }

            const callId = normalizeString(part.tool_use_id);
            const toolName = callId ? knownToolCalls.get(callId) || 'tool' : 'tool';
            const resultText = extractToolResultText(part.content);
            timeline.push({
              id: `${sessionId}-tool-result-${timeline.length}`,
              entryType: 'tool',
              timestamp,
              toolName,
              title: `${summarizeToolName(toolName)} result`,
              subtitle: null,
              text: clipLongText(resultText || 'Tool completed without textual output.', 4000),
              callId,
              status: 'completed',
              exitCode: null,
            });
          }
        }
        continue;
      }

      if (row.type === 'assistant') {
        modelProvider = normalizeString(row.message?.model) || modelProvider;
        latestContext = parseClaudeContextUsage(
          row.message?.usage && typeof row.message.usage === 'object' ? row.message.usage : null,
          modelProvider ? runtimeState.modelContextWindows[modelProvider] || null : null
        ) || latestContext;
        const contentParts = Array.isArray(row.message?.content) ? row.message.content : [];

        for (const part of contentParts) {
          if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
            timeline.push({
              id: `${sessionId}-tool-thinking-${timeline.length}`,
              entryType: 'tool',
              text: part.thinking.trim(),
              toolName: 'thinking',
              title: 'Thinking',
              subtitle: 'Claude reasoning trace',
              callId: null,
              status: 'completed',
              exitCode: null,
              timestamp,
            });
            continue;
          }

          if (part?.type === 'tool_use') {
            const toolName = normalizeString(part.name) || 'tool';
            const callId = normalizeString(part.id);
            if (callId) {
              knownToolCalls.set(callId, toolName);
            }

            timeline.push({
              id: `${sessionId}-tool-call-${timeline.length}`,
              entryType: 'tool',
              timestamp,
              toolName,
              title: summarizeToolName(toolName),
              subtitle: summarizeToolInput(toolName, part.input),
              text: clipLongText(JSON.stringify(part.input || {}, null, 2), 2000),
              callId,
              status: 'queued',
              exitCode: null,
            });
            continue;
          }

          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            const entryId = normalizeString(row.uuid) || `${sessionId}-assistant-${messages.length}`;
            messages.push({
              id: entryId,
              role: 'assistant',
              kind: 'final',
              text: part.text.trim(),
              timestamp,
            });
            timeline.push({
              id: entryId,
              entryType: 'message',
              role: 'assistant',
              kind: 'final',
              text: part.text.trim(),
              timestamp,
            });
            preview = part.text.trim();
          }
        }
        continue;
      }
    }
  } finally {
    lineReader.close();
    stream.destroy();
  }

  if (!preview) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    preview = lastAssistant?.text || messages.at(-1)?.text || '';
  }

  return {
    title: derivedTitle || `שיחת Claude ${sessionId.slice(0, 8)}`,
    preview: trimPreview(preview || derivedTitle || sessionId),
    messages,
    timeline,
    modelProvider,
    context: latestContext,
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
    'הקשר משוחזר מתוך שיחה קודמת של Claude.',
    `כותרת המקור: ${sourceTitle}`,
    sourceCwd ? `תיקיית המקור: ${sourceCwd}` : '',
    'שמור על כל ההקשר הבא והמשך בדיוק מאותה נקודה.',
    renderedTimeline,
  ].filter(Boolean).join('\n\n');
}

async function waitForClaudeSessionReady(
  profile: CodexProfile,
  sessionId: string,
  previousUpdatedAt?: string | null,
  timeoutMs = 6000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sessionRecord = await resolveClaudeSessionRecord(profile, sessionId);
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

function collectClaudeArgs(
  sessionId: string | undefined,
  executionConfig: CodexExecutionConfig | null | undefined,
  additionalDirectories: string[]
): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    'bypassPermissions',
  ];

  for (const directory of additionalDirectories) {
    args.push('--add-dir', directory);
  }

  if (executionConfig?.model) {
    args.push('--model', executionConfig.model);
  }

  if (executionConfig?.reasoningEffort) {
    args.push('--effort', executionConfig.reasoningEffort);
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
    throw new Error('No Claude profile is configured');
  }

  return profile;
}

async function resolveRunCwd(profile: CodexProfile, sessionId?: string): Promise<string> {
  if (!sessionId) {
    return profile.workspaceCwd;
  }

  const sessionRecord = await resolveClaudeSessionRecord(profile, sessionId);
  return sessionRecord?.cwd || profile.workspaceCwd;
}

async function readObservedModels(profile: CodexProfile): Promise<string[]> {
  const sessionFiles = await scanClaudeSessionFiles(profile);
  const observedModels = new Set<string>();

  for (const sessionFile of sessionFiles.slice(0, 30)) {
    const tailLines = await readFileTail(sessionFile.path, 24 * 1024);
    for (const line of tailLines) {
      const row = safeJsonParse<any>(line);
      if (row?.type === 'assistant') {
        const model = normalizeString(row?.message?.model);
        if (model) {
          observedModels.add(model);
        }
      }
    }
  }

  return [...observedModels];
}

function compareClaudeModels(left: string, right: string): number {
  const rank = (value: string) => {
    if (value.includes('opus')) return 0;
    if (value.includes('sonnet')) return 1;
    if (value.includes('haiku')) return 2;
    return 3;
  };

  return rank(left) - rank(right) || left.localeCompare(right);
}

export function resolveClaudeProfile(profileId?: string): CodexProfile {
  return resolveProfile(profileId);
}

export async function getAvailableClaudeProfiles(): Promise<CodexProfile[]> {
  const available: CodexProfile[] = [];

  for (const profile of CANDIDATE_PROFILES) {
    const hasHome = await pathExists(profile.codexHome);
    const hasCredentials = await pathExists(path.join(profile.codexHome, '.credentials.json'));
    const hasSettings = await pathExists(path.join(profile.codexHome, 'settings.json'));
    const hasProjects = await pathExists(path.join(profile.codexHome, 'projects'));

    if (hasHome && (hasCredentials || hasSettings || hasProjects)) {
      available.push(profile);
    }
  }

  return available;
}

export async function getClaudeModelCatalog(profileId?: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  const cached = modelCatalogCache.get(profile.id);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      models: cached.models.map((model) => ({
        ...model,
        supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
      })),
      selectedModel: cached.selectedModel,
      selectedReasoningEffort: cached.selectedReasoningEffort,
    };
  }

  const [settings, observedModels] = await Promise.all([
    readClaudeSettings(profile),
    readObservedModels(profile),
  ]);
  await ensureRuntimeStateLoaded();

  const explicitAvailableModels = Array.isArray(settings.availableModels)
    ? settings.availableModels
      .map((value) => normalizeString(value))
      .filter((value): value is string => Boolean(value))
    : [];
  const configuredModel = normalizeString(settings.model);
  const observedOrConfigured = new Set<string>([
    ...observedModels,
    ...explicitAvailableModels,
    configuredModel || '',
    runtimeState.profiles[profile.id]?.model || '',
  ].filter(Boolean));

  const models = [...observedOrConfigured]
    .sort(compareClaudeModels)
    .map((model): CodexAvailableModel => ({
      slug: model,
      displayName: displayClaudeModelName(model),
      description: model,
      defaultReasoningLevel: normalizeReasoningEffort(settings.effortLevel),
      supportedReasoningLevels: SUPPORTED_REASONING_LEVELS.map((level) => ({ ...level })),
      isConfiguredDefault: false,
    }));

  const selectedModel = configuredModel || models[0]?.slug || null;
  const selectedReasoningEffort = normalizeReasoningEffort(settings.effortLevel);

  const nextModels = models.map((model) => ({
    ...model,
    isConfiguredDefault: model.slug === selectedModel,
    supportedReasoningLevels: model.supportedReasoningLevels.map((level) => ({ ...level })),
  }));

  modelCatalogCache.set(profile.id, {
    expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
    models: nextModels,
    selectedModel,
    selectedReasoningEffort,
  });

  return {
    models: nextModels,
    selectedModel,
    selectedReasoningEffort,
  };
}

export async function listClaudeSessions(
  profileId?: string,
  query = '',
  limit = MAX_SESSIONS
): Promise<CodexSessionSummary[]> {
  const profile = resolveProfile(profileId);
  const sessionFiles = await scanClaudeSessionFiles(profile);
  const draftSessions = await listForkDraftSessions(profile.id);
  const normalizedQuery = query.trim().toLowerCase();
  const summaries: CodexSessionSummary[] = [];

  for (const sessionFile of sessionFiles) {
    const hints = await extractClaudeSessionSummaryHints(sessionFile.path, sessionFile.id);
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

export async function getClaudeSessionDetail(
  sessionId: string,
  profileId?: string,
  options?: {
    tail?: number;
    before?: number;
    full?: boolean;
  }
): Promise<CodexSessionDetail> {
  const profile = resolveProfile(profileId);
  const sessionFile = await resolveClaudeSessionRecord(profile, sessionId);

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

  const parsedBase = await parseClaudeSessionFile(sessionFile.path, sessionId);
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
    messages: shouldReturnFullMessages ? parsed.messages : [],
    timeline,
    totalTimelineEntries,
    timelineWindowStart,
    timelineWindowEnd,
    hasEarlierTimeline: timelineWindowStart > 0,
    forkDraftContext: null,
  };
}

async function buildSessionContextSnapshot(
  profileId: string,
  sessionId: string,
  sessionRecord: ClaudeSessionScanRecord,
  parsed?: ParsedClaudeSession
): Promise<CodexContextUsageSnapshot | null> {
  await ensureRuntimeStateLoaded();
  const nextParsed = parsed || await parseClaudeSessionFile(sessionRecord.path, sessionId);
  const sessionSnapshot = runtimeState.sessions[sessionId];
  const latestModel = nextParsed.modelProvider || sessionRecord.modelProvider;
  const contextWindow = sessionSnapshot?.context?.modelContextWindow
    || (latestModel ? runtimeState.modelContextWindows[latestModel] || null : null);

  if (!nextParsed.context) {
    if (contextWindow === null) {
      return null;
    }

    return {
      modelContextWindow: contextWindow,
      inputTokens: null,
      cachedInputTokens: null,
      usagePercent: null,
    };
  }

  return {
    ...nextParsed.context,
    modelContextWindow: nextParsed.context.modelContextWindow || contextWindow,
    usagePercent: (() => {
      const effectiveContextWindow = nextParsed.context.modelContextWindow || contextWindow;
      const effectiveInputTokens = (
        nextParsed.context.inputTokens !== null
        || nextParsed.context.cachedInputTokens !== null
      )
        ? (nextParsed.context.inputTokens || 0) + (nextParsed.context.cachedInputTokens || 0)
        : null;

      return (
        effectiveContextWindow
        && effectiveInputTokens !== null
      )
        ? Math.min(
          100,
          Math.max(0, (effectiveInputTokens / Number(effectiveContextWindow)) * 100)
        )
        : nextParsed.context.usagePercent;
    })(),
  };
}

export async function getClaudeRateLimitSnapshot(
  profileId?: string,
  sessionId?: string
): Promise<CodexRateLimitSnapshot | null> {
  const profile = resolveProfile(profileId);
  await ensureRuntimeStateLoaded();
  const authStatus = await readClaudeAuthStatus(profile);
  const usageWindows = await fetchClaudeUsageWindows(profile).catch(() => null);
  const profileSnapshot = runtimeState.profiles[profile.id] || null;

  if (sessionId?.trim()) {
    const sessionRecord = await resolveClaudeSessionRecord(profile, sessionId.trim());
    const sessionSnapshot = runtimeState.sessions[sessionId.trim()] || null;
    if (!sessionRecord && !sessionSnapshot) {
      return null;
    }

    const parsed = sessionRecord ? await parseClaudeSessionFile(sessionRecord.path, sessionId.trim()) : null;
    const context = sessionRecord
      ? await buildSessionContextSnapshot(profile.id, sessionId.trim(), sessionRecord, parsed || undefined)
      : cloneContextSnapshot(sessionSnapshot?.context || null);

    return {
      profileId: profile.id,
      sessionId: sessionId.trim(),
      updatedAt: sessionSnapshot?.updatedAt || sessionRecord?.updatedAt || profileSnapshot?.updatedAt || null,
      planType: authStatus?.subscriptionType || sessionSnapshot?.planType || profileSnapshot?.planType || null,
      rateLimitReachedType: sessionSnapshot?.rateLimitReachedType || profileSnapshot?.rateLimitReachedType || null,
      primary: cloneRateLimitWindow(usageWindows?.primary || sessionSnapshot?.primary || profileSnapshot?.primary || null),
      secondary: cloneRateLimitWindow(usageWindows?.secondary || sessionSnapshot?.secondary || profileSnapshot?.secondary || null),
      context,
    };
  }

  if (!profileSnapshot) {
    return null;
  }

  return {
    profileId: profile.id,
    sessionId: profileSnapshot.sessionId,
    updatedAt: profileSnapshot.updatedAt,
    planType: authStatus?.subscriptionType || profileSnapshot.planType || null,
    rateLimitReachedType: profileSnapshot.rateLimitReachedType || null,
    primary: cloneRateLimitWindow(usageWindows?.primary || profileSnapshot.primary),
    secondary: cloneRateLimitWindow(usageWindows?.secondary || profileSnapshot.secondary),
    context: cloneContextSnapshot(profileSnapshot.context),
  };
}

function normalizeClaudeExecutionConfig(executionConfig?: CodexExecutionConfig | null): CodexExecutionConfig {
  const model = normalizeString(executionConfig?.model);
  const reasoningEffort = normalizeReasoningEffort(executionConfig?.reasoningEffort);
  return {
    model,
    reasoningEffort,
  };
}

function sanitizeClaudeCliFailure(rawText: string, fallbackMessage: string): string {
  const sanitized = (rawText || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

  return sanitized || fallbackMessage;
}

function extractAssistantTextFromStreamMessage(message: any): string {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function cancelClaudeRun(runId: string): boolean {
  const activeRun = activeClaudeRuns.get(runId);
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

export async function runClaudePrompt(
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
): Promise<ClaudeRunResult> {
  const profile = resolveProfile(profileId);
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    throw new Error('Prompt must not be empty');
  }

  const runCwdOverride = !sessionId && options.cwd?.trim() ? options.cwd.trim() : null;
  const runCwd = runCwdOverride || await resolveRunCwd(profile, sessionId);
  const promptText = buildPromptWithAttachments(trimmedPrompt, attachments, {
    cwdContext: runCwd,
    injectDirectoryContext: Boolean(!sessionId && options.injectDirectoryContext),
  });
  const executionConfig = normalizeClaudeExecutionConfig(options.executionConfig);
  const queueKey = `${profile.id}:${sessionId || '__new__'}`;

  return queueBySessionKey(queueKey, async () => {
    const previousSession = sessionId ? await resolveClaudeSessionRecord(profile, sessionId) : null;
    const args = collectClaudeArgs(
      sessionId,
      executionConfig,
      Array.from(new Set([
        CODEX_APP_CONFIG.uploadRoot,
        CODEX_APP_CONFIG.workspaceRoot,
        profile.workspaceCwd,
      ]))
    );

    return new Promise<ClaudeRunResult>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: runCwd,
        env: buildClaudeProcessEnv(profile),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const activeRunId = options.runId;

      child.stdin.on('error', () => {
        // Ignore EPIPE if Claude exits before consuming all stdin input.
      });
      child.stdin.end(promptText);

      if (activeRunId) {
        activeClaudeRuns.set(activeRunId, {
          child,
          cancelRequested: false,
        });
      }

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let finalMessage = '';
      let createdSessionId = sessionId || '';
      let latestRateLimitInfo: ClaudeRateLimitInfo | null = null;
      let latestModel: string | null = executionConfig.model || null;
      let latestContext: CodexContextUsageSnapshot | null = null;
      let latestTools: string[] | undefined;
      let latestMcpServers: Array<{ name: string; status: string }> | undefined;

      function wasCancellationRequested(): boolean {
        return activeRunId ? activeClaudeRuns.get(activeRunId)?.cancelRequested === true : false;
      }

      function clearActiveRun() {
        if (activeRunId && activeClaudeRuns.get(activeRunId)?.child === child) {
          activeClaudeRuns.delete(activeRunId);
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

          if (!line) {
            continue;
          }

          const row = safeJsonParse<any>(line);
          if (!row) {
            continue;
          }

          if (row.type === 'system' && row.subtype === 'init') {
            createdSessionId = normalizeString(row.session_id) || createdSessionId;
            latestModel = normalizeString(row.model) || latestModel;
            latestTools = Array.isArray(row.tools) ? row.tools.filter((tool: unknown): tool is string => typeof tool === 'string') : undefined;
            latestMcpServers = Array.isArray(row.mcp_servers)
              ? row.mcp_servers
                .map((server: any) => ({
                  name: normalizeString(server?.name) || '',
                  status: normalizeString(server?.status) || 'unknown',
                }))
                .filter((server) => server.name)
              : undefined;
            continue;
          }

          if (row.type === 'assistant') {
            finalMessage = extractAssistantTextFromStreamMessage(row.message) || finalMessage;
            latestModel = normalizeString(row.message?.model) || latestModel;
            latestContext = parseClaudeContextUsage(
              row.message?.usage && typeof row.message.usage === 'object' ? row.message.usage : null,
              latestModel ? runtimeState.modelContextWindows[latestModel] || null : null
            ) || latestContext;
            continue;
          }

          if (row.type === 'rate_limit_event') {
            latestRateLimitInfo = row.rate_limit_info || null;
            continue;
          }

          if (row.type === 'result') {
            const contextWindow = latestModel
              ? parseNumber(row.modelUsage?.[latestModel]?.contextWindow)
              : null;
            latestContext = parseClaudeContextUsage(
              row.usage && typeof row.usage === 'object' ? row.usage : null,
              contextWindow
            ) || latestContext;
            latestModel = latestModel || Object.keys(row.modelUsage || {})[0] || null;
            if (!finalMessage && typeof row.result === 'string' && row.result.trim()) {
              finalMessage = row.result.trim();
            }
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
          reject(new ClaudeRunCancelledError());
          return;
        }
        reject(error);
      });

      child.on('close', async (code) => {
        const cancelled = wasCancellationRequested();
        clearActiveRun();

        if (cancelled) {
          reject(new ClaudeRunCancelledError());
          return;
        }

        if (code !== 0) {
          reject(new Error(sanitizeClaudeCliFailure(stderrBuffer, `Claude exited with code ${code}`)));
          return;
        }

        if (!createdSessionId) {
          reject(new Error('Claude completed without returning a session id'));
          return;
        }

        await waitForClaudeSessionReady(profile, createdSessionId, previousSession?.updatedAt || null);
        const authStatus = await readClaudeAuthStatus(profile);
        const usageWindows = await fetchClaudeUsageWindows(profile).catch(() => null);
        await updateRuntimeSnapshot({
          profileId: profile.id,
          sessionId: createdSessionId,
          updatedAt: new Date().toISOString(),
          planType: authStatus?.subscriptionType || null,
          rateLimitReachedType: latestRateLimitInfo?.status && latestRateLimitInfo.status !== 'allowed'
            ? latestRateLimitInfo.rateLimitType || latestRateLimitInfo.status
            : null,
          primary: usageWindows?.primary || buildRateLimitWindowFromClaudeEvent(latestRateLimitInfo),
          secondary: usageWindows?.secondary || null,
          context: cloneContextSnapshot(latestContext),
          model: latestModel,
          tools: latestTools,
          mcpServers: latestMcpServers,
        });

        resolve({
          sessionId: createdSessionId,
          finalMessage: finalMessage || 'Claude completed without a final assistant message.',
        });
      });
    });
  });
}

export async function createClaudeForkSession(
  sourceSessionId: string,
  forkEntryId: string,
  profileId?: string
): Promise<{
  sessionId: string;
  forkedAt: string;
}> {
  const sourceSession = await getClaudeSessionDetail(sourceSessionId, profileId, { full: true });
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
