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
  type CodexForkContext,
  type CodexForkDraftSession,
  type CodexForkSessionMetadata,
} from './codexForkSessions.js';
import type { CodexSessionTopic } from './codexSessionTopics.js';
import { listHiddenSessionIds } from './codexSessionVisibility.js';
import { getSessionTopicMap } from './codexSessionTopics.js';
import { getSelectedPermissionMode, resolvePermissionMode } from './providerPermissions.js';
import { alignPathOwnershipToProfile, getProfileSpawnIdentity } from './providerRuntimeOwnership.js';

export interface CodexProfile {
  id: string;
  label: string;
  provider: AppProvider;
  mode?: 'standard' | 'support' | 'agent';
  codexHome: string;
  workspaceCwd: string;
  sourceProfileId?: string;
  sandboxCwd?: string;
  defaultProfile?: boolean;
  internalOnly?: boolean;
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
  toolInputText?: string | null;
  toolInputLanguage?: string | null;
  toolOutputText?: string | null;
  toolOutputLanguage?: string | null;
}

export interface CodexAgentSessionAgentPreview {
  id: string;
  name: string;
  provider: AppProvider;
  role: string;
  objective: string;
  scopePaths: string[];
  dependsOn: string[];
  notes: string | null;
  instructionPath: string;
  statusPath: string;
  runtimeStatus?: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null;
  linkedSessionId?: string | null;
  queueItemId?: string | null;
  updatedAt?: string | null;
  lastMessage?: string | null;
  lastError?: string | null;
}

export interface CodexAgentSessionPlanPreview {
  title: string;
  goal: string;
  sharedStatusPath: string;
  eventsPath: string;
  coordinationRules: string[];
  agents: CodexAgentSessionAgentPreview[];
}

export interface CodexAgentSessionMeta {
  id: string;
  title: string;
  goal: string;
  status: string;
  kind: 'planner' | 'agent';
  sourceProfileId: string;
  linkedProfileId: string;
  plannerProvider: AppProvider | null;
  topicId: string | null;
  agentId: string | null;
  agentName: string | null;
  approvedAt: string | null;
  launchedAt: string | null;
  plannerSessionId: string | null;
  sharedStatusPath: string | null;
  eventsPath: string | null;
  plan: CodexAgentSessionPlanPreview | null;
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
  agentSession?: CodexAgentSessionMeta | null;
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
  cwdOverride?: string | null;
  isCompactClone?: boolean;
  compactSourceSessionId?: string | null;
}

interface CodexRunResult {
  sessionId: string;
  finalMessage: string;
  recoveredFromSessionId?: string | null;
  recoveryMode?: 'compact-clone' | null;
}

interface CodexCompactionRecoveryContext {
  sourceSessionId: string;
  sourceTitle: string;
  sourceCwd: string | null;
  promptPrefix: string;
  forkContext: CodexForkContext;
}

export interface CodexExecutionConfig {
  model: string | null;
  reasoningEffort: string | null;
  permissionModeId?: string | null;
}

export interface CodexPermissionModeOption {
  id: string;
  label: string;
  accessLevel: 'full' | 'balanced' | 'restricted';
  modeLabel: string;
  summary: string;
  description: string;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
}

export interface CodexPermissionCapabilities {
  canChangeMode: boolean;
  detectsLiveApprovalRequests: boolean;
  canApproveFromUi: boolean;
  notes: string[];
}

export interface CodexPermissionPendingApproval {
  requestId: string;
  title: string;
  details: string | null;
  source: string;
  canRespond: boolean;
  updatedAt: string;
}

export interface CodexPermissionRuntimeState {
  profileId: string;
  sessionId: string | null;
  selectedModeId: string | null;
  effectiveModeId: string | null;
  effectiveModeLabel: string | null;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
  updatedAt: string | null;
  pendingApproval: CodexPermissionPendingApproval | null;
}

export interface CodexReasoningLevelOption {
  effort: string;
  description: string | null;
}

export interface CodexResponseSpeedOption {
  id: string;
  label: string;
  description: string | null;
}

export interface CodexAvailableModel {
  slug: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: CodexReasoningLevelOption[];
  availableResponseSpeedIds?: string[];
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
  selectedModeId?: string | null;
  availableModes?: CodexPermissionModeOption[];
  capabilities?: CodexPermissionCapabilities | null;
  runtime?: CodexPermissionRuntimeState | null;
}

export interface CodexResponseSpeedSnapshot {
  selectedModeId: string | null;
  selectedLabel: string;
  configurable: boolean;
  note: string | null;
  availableModes: CodexResponseSpeedOption[];
}

export interface CodexModelCatalog {
  models: CodexAvailableModel[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  responseSpeed: CodexResponseSpeedSnapshot | null;
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
    additional_speed_tiers?: string[];
    service_tiers?: Array<{
      id?: string;
      name?: string;
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

interface CodexConfigDefaults {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

interface ActiveCodexRun {
  child: ReturnType<typeof spawn>;
  cancelRequested: boolean;
}

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_PROFILE_ID = CODEX_APP_CONFIG.defaultProfileId;
const MAX_SESSIONS = 500;
const MAX_TOOL_TEXT = 200_000;
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

function isCodexContextCompactionFailureText(text: string): boolean {
  const normalized = (text || '').trim();
  if (!normalized) {
    return false;
  }

  return (
    /Invalid value:\s*'context_compaction'/i.test(normalized)
    || (/context_compaction/i.test(normalized) && /invalid_enum_value/i.test(normalized))
  );
}

export function isCodexContextCompactionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return isCodexContextCompactionFailureText(message);
}

function clipLongText(text: string, limit = MAX_TOOL_TEXT): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}\n…`;
}

function clipCompactionRecoveryText(text: string, limit = 12_000): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
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

function normalizeCodexServiceTierValue(value: string | null | undefined): 'fast' | 'flex' | null {
  const normalized = normalizeExecutionSettingValue(value)?.toLowerCase() || null;
  if (!normalized) {
    return null;
  }

  if (normalized === 'standard') {
    return 'flex';
  }

  if (normalized === 'priority') {
    return 'fast';
  }

  return normalized === 'fast' || normalized === 'flex' ? normalized : null;
}

function normalizeCodexServiceTierConfigValue(value: string | null | undefined): 'fast' | null {
  const normalized = normalizeCodexServiceTierValue(value);
  return normalized === 'fast' ? 'fast' : null;
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

function normalizeCodexCliText(text: string): string {
  return stripBenignCodexStderr(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function summarizeCodexCliText(text: string, maxLines = 12): string {
  const normalized = normalizeCodexCliText(text);
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n').filter(Boolean);
  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  return lines.slice(-maxLines).join('\n');
}

function extractCodexStructuredError(row: any): string | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const rowType = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  const hints = [
    typeof row.message === 'string' ? row.message : null,
    typeof row.detail === 'string' ? row.detail : null,
    typeof row.details === 'string' ? row.details : null,
    typeof row.reason === 'string' ? row.reason : null,
    typeof row.error === 'string' ? row.error : null,
    typeof row.error?.message === 'string' ? row.error.message : null,
    typeof row.item?.text === 'string' && /(error|failed|invalid|denied|timeout)/i.test(row.item.text)
      ? row.item.text
      : null,
  ].filter((value): value is string => Boolean(value?.trim()));

  if (!hints.length && !/(error|failed|invalid|denied|timeout|abort)/i.test(rowType)) {
    return null;
  }

  const primary = hints[0] || JSON.stringify(row);
  return rowType ? `${rowType}: ${primary}` : primary;
}

function buildCodexFailureDetails(
  fallbackMessage: string,
  stderrText: string,
  stdoutLines: string[],
  structuredErrors: string[]
): string {
  const normalizedStderr = summarizeCodexCliText(stderrText, 16);
  if (normalizedStderr) {
    return normalizedStderr;
  }

  const uniqueStructuredErrors = Array.from(
    new Set(structuredErrors.map((line) => line.trim()).filter(Boolean))
  );
  if (uniqueStructuredErrors.length) {
    return uniqueStructuredErrors.slice(-6).join('\n');
  }

  const normalizedStdout = summarizeCodexCliText(stdoutLines.join('\n'), 16);
  if (normalizedStdout) {
    return `${fallbackMessage}\n${normalizedStdout}`;
  }

  return fallbackMessage;
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

async function writeRootTomlString(
  profile: CodexProfile,
  filePath: string,
  key: string,
  value: string | null
): Promise<void> {
  let raw = '';

  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linePattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*.*$`, 'm');
  const nextLine = value ? `${key} = "${value}"` : '';
  let nextRaw = raw;

  if (linePattern.test(nextRaw)) {
    nextRaw = nextLine
      ? nextRaw.replace(linePattern, nextLine)
      : nextRaw.replace(linePattern, '').replace(/\n{3,}/g, '\n\n');
  } else if (nextLine) {
    nextRaw = `${nextLine}\n${nextRaw}`.trimEnd() + '\n';
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextRaw, 'utf-8');
  alignPathOwnershipToProfile(profile, filePath);
}

async function normalizeLegacyCodexServiceTierConfig(profile: CodexProfile, filePath: string): Promise<void> {
  let raw = '';

  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
      return;
    }
    throw error;
  }

  const currentValue = readRootTomlString(raw, 'service_tier');
  if (!currentValue) {
    return;
  }

  const normalizedValue = normalizeCodexServiceTierConfigValue(currentValue);
  const normalizedCurrentValue = normalizeExecutionSettingValue(currentValue);
  if (normalizedCurrentValue === normalizedValue) {
    return;
  }

  await writeRootTomlString(profile, filePath, 'service_tier', normalizedValue);
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

async function readFileHead(filePath: string, maxLines = 48): Promise<string[]> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lineReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  const lines: string[] = [];

  try {
    for await (const line of lineReader) {
      lines.push(line);
      if (lines.length >= maxLines) {
        break;
      }
    }
    return lines;
  } finally {
    lineReader.close();
    stream.destroy();
  }
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
  let cwdOverride: string | null = null;
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
      if (!cwdOverride) {
        cwdOverride = parseInjectedWorkspacePath(text);
      }
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
    cwdOverride,
    isCompactClone,
    compactSourceSessionId,
  };
}

function parseInjectedWorkspacePath(text: string): string | null {
  const patterns = [
    /הנתיב הפעיל הוא:\s*(.+)/,
    /The active path is:\s*(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const candidate = match[1]
      .split('\n')[0]
      .trim()
      .replace(/^["']+|["']+$/g, '');
    if (candidate) {
      return candidate;
    }
  }

  return null;
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

function findLastToolTimelineEntry(
  timeline: CodexTimelineEntry[],
  predicate: (entry: CodexTimelineEntry) => boolean
): CodexTimelineEntry | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.entryType === 'tool' && predicate(entry)) {
      return entry;
    }
  }

  return null;
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

function renderCompactionRecoveryTimelineEntry(
  entry: CodexTimelineEntry,
  sourceProviderLabel: string
): string | null {
  if (entry.entryType === 'message' && typeof entry.text === 'string') {
    const prefix = entry.role === 'user'
      ? 'משתמש'
      : entry.kind === 'commentary'
        ? `${sourceProviderLabel} (עובד)`
        : sourceProviderLabel;
    return `${prefix}:\n${clipCompactionRecoveryText(entry.text, entry.kind === 'commentary' ? 4_000 : 10_000)}`;
  }

  if (entry.entryType === 'tool') {
    const title = entry.title || entry.toolName || 'Tool';
    const details = [entry.subtitle, entry.text].filter(Boolean).join('\n');
    return `כלי ${title}:\n${clipCompactionRecoveryText(details || 'Tool event without textual details.', 4_000)}`;
  }

  if (entry.entryType === 'status') {
    const details = [entry.title || entry.status || 'Status', entry.subtitle].filter(Boolean).join('\n');
    return `סטטוס:\n${clipCompactionRecoveryText(details, 2_500)}`;
  }

  return null;
}

function buildCompactionRecoveryTranscript(
  timeline: CodexTimelineEntry[],
  sourceProviderLabel: string,
  maxChars = 120_000
): string {
  const rendered = timeline
    .map((entry) => renderCompactionRecoveryTimelineEntry(entry, sourceProviderLabel))
    .filter((value): value is string => Boolean(value));

  if (rendered.length === 0) {
    return 'לא נמצאה היסטוריית שיחה מפורשת לשחזור. המשך רק מההודעה החדשה שתגיע אחר כך.';
  }

  let keptChars = 0;
  const kept: string[] = [];
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const chunk = rendered[index]!;
    const extraChars = chunk.length + (kept.length > 0 ? 2 : 0);
    if (kept.length > 0 && keptChars + extraChars > maxChars) {
      break;
    }
    kept.unshift(chunk);
    keptChars += extraChars;
  }

  if (kept.length < rendered.length) {
    kept.unshift(`הערת מערכת: ${rendered.length - kept.length} קטעי היסטוריה מוקדמים הושמטו כדי לשמור על recovery יציב. המשך מההיסטוריה המופיעה כאן בלבד.`);
  }

  return kept.join('\n\n');
}

export async function buildCodexCompactionRecoveryContext(
  sessionId: string,
  profileId?: string
): Promise<CodexCompactionRecoveryContext> {
  const profile = resolveProfile(profileId);
  const sourceSession = await getCodexSessionDetail(sessionId, profile.id, { full: true });
  const sourceProviderLabel = getProviderDisplayLabel(profile.provider);
  const transcript = buildCompactionRecoveryTranscript(sourceSession.timeline, sourceProviderLabel);
  const lastTimelineEntry = sourceSession.timeline.at(-1);
  const forkEntryId = lastTimelineEntry?.id || `${sessionId}-compact-repair`;
  const sourceCwd = sourceSession.cwd || profile.workspaceCwd;
  const promptPrefix = [
    `Compact clone of session ${sourceSession.id}`,
    `- Thread: ${sourceSession.title}`,
    sourceCwd ? `- CWD: ${sourceCwd}` : '',
    `- Provider: ${sourceProviderLabel}`,
    '',
    'This session hit an internal Codex context compaction incompatibility during resume.',
    'The transcript below is the reconstructed canonical context. Continue naturally from it, without explaining the repair process to the user.',
    '',
    transcript,
    '',
    'עד כאן ההקשר המשוחזר. אל תסכם את השיחה ואל תדבר עליה מבחוץ. המשך ישירות מהנקודה האחרונה ומההודעה החדשה שתופיע מיד אחר כך.',
  ].filter(Boolean).join('\n');

  return {
    sourceSessionId: sourceSession.id,
    sourceTitle: sourceSession.title,
    sourceCwd,
    promptPrefix,
    forkContext: {
      sourceSessionId: sourceSession.id,
      sourceTitle: sourceSession.title,
      sourceCwd,
      forkEntryId,
      transferSourceProvider: profile.provider,
      transferTargetProvider: profile.provider,
      timeline: sourceSession.timeline.map((entry) => ({ ...entry })),
    },
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
          const callId = payload.call_id || null;
          const mergedEntry = findLastToolTimelineEntry(
            timeline,
            (entry) => entry.callId === callId && entry.toolName === 'exec_command'
          );
          const fullCommandText = clipLongText(String(payload.command || ''), MAX_TOOL_TEXT);
          const clippedOutput = clipLongText(outputText || 'No terminal output.');

          if (mergedEntry) {
            mergedEntry.timestamp = timestamp;
            mergedEntry.title = 'Terminal';
            mergedEntry.subtitle = summarizeCommand(payload.command) || payload.cwd || mergedEntry.subtitle || null;
            mergedEntry.toolInputText = fullCommandText || mergedEntry.toolInputText || null;
            mergedEntry.toolInputLanguage = mergedEntry.toolInputLanguage || 'bash';
            mergedEntry.toolOutputText = clippedOutput;
            mergedEntry.toolOutputLanguage = null;
            mergedEntry.text = clippedOutput;
            mergedEntry.status = payload.status || 'completed';
            mergedEntry.exitCode = exitCode;
          } else {
            timeline.push({
              id: `${sessionId}-tool-terminal-${timeline.length}`,
              entryType: 'tool',
              timestamp,
              toolName: 'exec_command',
              title: 'Terminal',
              subtitle: summarizeCommand(payload.command) || payload.cwd || null,
              text: clippedOutput,
              callId,
              status: payload.status || null,
              exitCode,
              toolInputText: fullCommandText || summarizeCommand(payload.command) || null,
              toolInputLanguage: 'bash',
              toolOutputText: clippedOutput,
              toolOutputLanguage: null,
            });
          }
          continue;
        }

        if (eventType === 'patch_apply_end') {
          const outputText = [
            payload.stdout,
            payload.stderr,
            formatPatchChanges(payload.changes),
          ].filter(Boolean).join('\n\n');
          const callId = payload.call_id || null;
          const clippedOutput = clipLongText(outputText || 'Patch completed without output.');
          const mergedEntry = findLastToolTimelineEntry(
            timeline,
            (entry) => entry.callId === callId && entry.toolName === 'apply_patch'
          );

          if (mergedEntry) {
            mergedEntry.timestamp = timestamp;
            mergedEntry.title = 'Patch';
            mergedEntry.subtitle = payload.success ? 'Applied' : payload.status || 'Patch failed';
            mergedEntry.toolOutputText = clippedOutput;
            mergedEntry.toolOutputLanguage = 'diff';
            mergedEntry.text = clippedOutput;
            mergedEntry.status = payload.status || (payload.success ? 'completed' : 'failed');
            mergedEntry.exitCode = null;
          } else {
            timeline.push({
              id: `${sessionId}-tool-patch-${timeline.length}`,
              entryType: 'tool',
              timestamp,
              toolName: 'apply_patch',
              title: 'Patch',
              subtitle: payload.success ? 'Applied' : payload.status || 'Patch failed',
              text: clippedOutput,
              callId,
              status: payload.status || null,
              exitCode: null,
              toolOutputText: clippedOutput,
              toolOutputLanguage: 'diff',
            });
          }
          continue;
        }

        if (eventType === 'web_search_end') {
          const action = payload.action ? JSON.stringify(payload.action, null, 2) : '';
          const text = [payload.query, action].filter(Boolean).join('\n\n');
          const callId = payload.call_id || null;
          const clippedOutput = clipLongText(text || 'Search completed.');
          const mergedEntry = findLastToolTimelineEntry(
            timeline,
            (entry) => entry.callId === callId && (entry.toolName === 'web.search' || entry.toolName === 'web.search_query')
          );

          if (mergedEntry) {
            mergedEntry.timestamp = timestamp;
            mergedEntry.title = 'Web Search';
            mergedEntry.subtitle = payload.query || mergedEntry.subtitle || null;
            mergedEntry.toolOutputText = clippedOutput;
            mergedEntry.toolOutputLanguage = 'json';
            mergedEntry.text = clippedOutput;
            mergedEntry.status = 'completed';
            mergedEntry.exitCode = null;
          } else {
            timeline.push({
              id: `${sessionId}-tool-web-${timeline.length}`,
              entryType: 'tool',
              timestamp,
              toolName: 'web.search',
              title: 'Web Search',
              subtitle: payload.query || null,
              text: clippedOutput,
              callId,
              status: 'completed',
              exitCode: null,
              toolOutputText: clippedOutput,
              toolOutputLanguage: 'json',
            });
          }
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
        const clippedInput = clipLongText(payload.arguments || '', MAX_TOOL_TEXT);

        timeline.push({
          id: `${sessionId}-tool-call-${timeline.length}`,
          entryType: 'tool',
          timestamp,
          toolName,
          title: summarizeToolName(toolName),
          subtitle: summarizeFunctionArguments(toolName, payload.arguments),
          text: clippedInput,
          callId,
          status: 'queued',
          exitCode: null,
          toolInputText: clippedInput,
          toolInputLanguage: 'json',
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
          text: clipLongText(String(payload.input || ''), MAX_TOOL_TEXT),
          callId,
          status: payload.status || null,
          exitCode: null,
          toolInputText: clipLongText(String(payload.input || ''), MAX_TOOL_TEXT),
          toolInputLanguage: 'json',
        });
        continue;
      }

      if (responseType === 'custom_tool_call_output') {
        const callId = payload.call_id || null;
        const toolName = callId ? knownToolCalls.get(callId) || 'custom_tool' : 'custom_tool';
        const clippedOutput = clipLongText(String(payload.output || ''), MAX_TOOL_TEXT);
        const mergedEntry = findLastToolTimelineEntry(
          timeline,
          (entry) => entry.callId === callId && entry.toolName === toolName
        );

        if (mergedEntry) {
          mergedEntry.timestamp = timestamp;
          mergedEntry.toolOutputText = clippedOutput;
          mergedEntry.toolOutputLanguage = null;
          mergedEntry.text = clippedOutput;
          mergedEntry.status = 'completed';
          mergedEntry.exitCode = null;
        } else {
          timeline.push({
            id: `${sessionId}-custom-tool-output-${timeline.length}`,
            entryType: 'tool',
            timestamp,
            toolName,
            title: `${summarizeToolName(toolName)} result`,
            subtitle: null,
            text: clippedOutput,
            callId,
            status: 'completed',
            exitCode: null,
            toolOutputText: clippedOutput,
            toolOutputLanguage: null,
          });
        }
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
          text: clipLongText(actionText, MAX_TOOL_TEXT),
          callId: null,
          status: payload.status || null,
          exitCode: null,
          toolInputText: clipLongText(actionText, MAX_TOOL_TEXT),
          toolInputLanguage: 'json',
        });
        continue;
      }

      if (responseType === 'function_call_output') {
        const callId = payload.call_id || null;
        const toolName = callId ? knownToolCalls.get(callId) || 'tool' : 'tool';

        if (toolName === 'exec_command' || toolName === 'apply_patch' || toolName.startsWith('web.')) {
          continue;
        }

        const clippedOutput = clipLongText(String(payload.output || ''), MAX_TOOL_TEXT);
        const mergedEntry = findLastToolTimelineEntry(
          timeline,
          (entry) => entry.callId === callId && entry.toolName === toolName
        );

        if (mergedEntry) {
          mergedEntry.timestamp = timestamp;
          mergedEntry.toolOutputText = clippedOutput;
          mergedEntry.toolOutputLanguage = null;
          mergedEntry.text = clippedOutput;
          mergedEntry.status = 'completed';
          mergedEntry.exitCode = null;
        } else {
          timeline.push({
            id: `${sessionId}-tool-output-${timeline.length}`,
            entryType: 'tool',
            timestamp,
            toolName,
            title: `${summarizeToolName(toolName)} result`,
            subtitle: null,
            text: clippedOutput,
            callId,
            status: 'completed',
            exitCode: null,
            toolOutputText: clippedOutput,
            toolOutputLanguage: null,
          });
        }
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
  alignPathOwnershipToProfile(profile, targetPath);

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
    const resolvedCwd = hints.cwdOverride || sessionFile.cwd;
    const title = hints.title;
    const preview = hints.preview;
    const matchHaystack = `${title}\n${preview}\n${sessionFile.id}\n${resolvedCwd || ''}\n${forkMetadata?.sourceTitle || ''}`.toLowerCase();

    if (normalizedQuery && !matchHaystack.includes(normalizedQuery)) {
      continue;
    }

    summaries.push({
      id: sessionFile.id,
      title,
      updatedAt: sessionFile.updatedAt,
      createdAt: sessionFile.createdAt,
      profileId: profile.id,
      cwd: resolvedCwd,
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

export async function deleteCodexSession(
  sessionId: string,
  profileId?: string
): Promise<void> {
  const profile = resolveProfile(profileId);
  const sessionRecord = await resolveSessionRecord(profile, sessionId);
  if (!sessionRecord) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  await fs.rm(sessionRecord.path, { force: true });
}

async function appendSessionIndexEntryIfMissing(
  targetProfile: CodexProfile,
  entry: SessionIndexEntry | undefined
): Promise<void> {
  if (!entry?.id) {
    return;
  }

  const existingIndex = await loadSessionIndexMap(targetProfile);
  if (existingIndex.has(entry.id)) {
    return;
  }

  const indexPath = path.join(targetProfile.codexHome, 'session_index.jsonl');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  alignPathOwnershipToProfile(targetProfile, indexPath);
}

export async function copyCodexSessionToProfile(
  sessionId: string,
  sourceProfileId: string,
  targetProfileId: string,
  options?: {
    targetSessionId?: string;
  }
): Promise<SessionScanRecord> {
  const sourceProfile = resolveProfile(sourceProfileId);
  const targetProfile = resolveProfile(targetProfileId);

  if (sourceProfile.provider !== 'codex' || targetProfile.provider !== 'codex') {
    throw new Error('Session copy between users is currently supported only for Codex profiles');
  }

  if (sourceProfile.id === targetProfile.id) {
    throw new Error('Source and target profiles must be different');
  }

  const sourceSessionRecord = await resolveSessionRecord(sourceProfile, sessionId);
  if (!sourceSessionRecord) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  let targetSessionId = options?.targetSessionId?.trim() || randomUUID();
  let existingTargetRecord = await resolveSessionRecord(targetProfile, targetSessionId);
  while (existingTargetRecord) {
    targetSessionId = randomUUID();
    existingTargetRecord = await resolveSessionRecord(targetProfile, targetSessionId);
  }

  if (existingTargetRecord) {
    throw new Error(`Session ${targetSessionId} already exists in target profile`);
  }

  const sourceIndexMap = await loadSessionIndexMap(sourceProfile);
  const sourceContent = await fs.readFile(sourceSessionRecord.path, 'utf-8');
  const timestamp = sourceSessionRecord.createdAt ? new Date(sourceSessionRecord.createdAt) : new Date();
  const safeTimestamp = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
  const targetPath = buildSessionFilePath(targetProfile, targetSessionId, safeTimestamp);
  const sourceIndexEntry = sourceIndexMap.get(sessionId);
  const sourceLines = sourceContent.split('\n');
  const firstRow = safeJsonParse<{ payload?: Record<string, unknown> }>(sourceLines[0] || '');

  if (firstRow?.payload && typeof firstRow.payload === 'object') {
    firstRow.payload = {
      ...firstRow.payload,
      id: targetSessionId,
    };
    sourceLines[0] = JSON.stringify(firstRow);
  }

  const targetContent = sourceLines.join('\n');

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, targetContent, 'utf-8');
  alignPathOwnershipToProfile(targetProfile, targetPath);
  await appendSessionIndexEntryIfMissing(
    targetProfile,
    sourceIndexEntry
      ? {
          ...sourceIndexEntry,
          id: targetSessionId,
        }
      : undefined
  );

  const stats = await fs.stat(targetPath);
  return {
    id: targetSessionId,
    path: targetPath,
    updatedAt: stats.mtime.toISOString(),
    createdAt: sourceSessionRecord.createdAt,
    cwd: sourceSessionRecord.cwd,
    modelProvider: sourceSessionRecord.modelProvider,
    source: sourceSessionRecord.source,
    forkedFromId: sourceSessionRecord.forkedFromId,
  };
}

interface RawCodexTurnRange {
  startLine: number;
  endLine: number;
  userEntryId: string | null;
  assistantEntryIds: string[];
}

function collectRawCodexTurnRanges(rawLines: string[], sessionId: string): RawCodexTurnRange[] {
  const turns: RawCodexTurnRange[] = [];
  let currentTurn: RawCodexTurnRange | null = null;
  let messageCount = 0;
  let lastAssistantMessage: { kind: 'commentary' | 'final'; text: string } | null = null;

  for (let index = 0; index < rawLines.length; index += 1) {
    const row = safeJsonParse<any>(rawLines[index]);
    if (!row || row.type !== 'event_msg') {
      continue;
    }

    const payload = row.payload || {};
    const eventType = payload.type;

    if (eventType === 'task_started') {
      if (currentTurn) {
        currentTurn.endLine = index - 1;
        turns.push(currentTurn);
      }

      currentTurn = {
        startLine: index,
        endLine: rawLines.length - 1,
        userEntryId: null,
        assistantEntryIds: [],
      };
      lastAssistantMessage = null;
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    if (eventType === 'user_message' && typeof payload.message === 'string') {
      currentTurn.userEntryId = `${sessionId}-user-${messageCount}`;
      messageCount += 1;
      continue;
    }

    if (eventType === 'agent_message' && typeof payload.message === 'string') {
      const kind = payload.phase === 'commentary' ? 'commentary' : 'final';
      const text = payload.message.trim();
      currentTurn.assistantEntryIds.push(`${sessionId}-assistant-${messageCount}`);
      messageCount += 1;
      lastAssistantMessage = { kind, text };
      continue;
    }

    if (eventType === 'task_complete' && typeof payload.last_agent_message === 'string') {
      const text = payload.last_agent_message.trim();
      if (
        !lastAssistantMessage
        || lastAssistantMessage.kind !== 'final'
        || lastAssistantMessage.text !== text
      ) {
        currentTurn.assistantEntryIds.push(`${sessionId}-final-${messageCount}`);
        messageCount += 1;
        lastAssistantMessage = { kind: 'final', text };
      }
    }
  }

  if (currentTurn) {
    currentTurn.endLine = rawLines.length - 1;
    turns.push(currentTurn);
  }

  return turns;
}

export async function deleteCodexTurn(
  sessionId: string,
  entryId: string,
  profileId?: string
): Promise<void> {
  const profile = resolveProfile(profileId);
  const sessionRecord = await resolveSessionRecord(profile, sessionId);
  if (!sessionRecord) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  const content = await fs.readFile(sessionRecord.path, 'utf-8');
  const rawLines = content.split('\n').filter((line, index, lines) => line.trim() || index < lines.length - 1);
  const turnRanges = collectRawCodexTurnRanges(rawLines, sessionId);
  const targetTurn = turnRanges.find((turn) => turn.userEntryId === entryId || turn.assistantEntryIds.includes(entryId));

  if (!targetTurn) {
    throw new Error('לא ניתן לאתר את זוג ההודעות שנבחר למחיקה.');
  }

  const remainingLines = rawLines.filter((_, index) => index < targetTurn.startLine || index > targetTurn.endLine);
  await fs.writeFile(sessionRecord.path, `${remainingLines.join('\n')}\n`, 'utf-8');
  alignPathOwnershipToProfile(profile, sessionRecord.path);
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

async function readCodexExecutionDefaults(profile: CodexProfile): Promise<CodexConfigDefaults> {
  const configPath = path.join(profile.codexHome, 'config.toml');

  try {
    await normalizeLegacyCodexServiceTierConfig(profile, configPath);
    const raw = await fs.readFile(configPath, 'utf-8');
    return {
      model: normalizeExecutionSettingValue(readRootTomlString(raw, 'model')),
      reasoningEffort: normalizeExecutionSettingValue(readRootTomlString(raw, 'model_reasoning_effort')),
      serviceTier: normalizeCodexServiceTierValue(readRootTomlString(raw, 'service_tier')),
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
      };
    }

    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
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
    ...getProfileSpawnIdentity(profile),
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
        availableResponseSpeedIds: Array.from(new Set(
          [
            'flex',
            ...(Array.isArray(entry?.additional_speed_tiers) ? entry.additional_speed_tiers : []),
            ...(Array.isArray(entry?.service_tiers)
              ? entry.service_tiers
                .map((tier) => normalizeCodexServiceTierValue(
                  normalizeExecutionSettingValue(tier?.id) || normalizeExecutionSettingValue(tier?.name)
                ))
                .filter((value): value is string => Boolean(value))
              : []),
          ]
            .map((value) => normalizeCodexServiceTierValue(normalizeExecutionSettingValue(value)) || normalizeExecutionSettingValue(value)?.toLowerCase() || null)
            .filter((value): value is string => Boolean(value))
        )),
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
    availableResponseSpeedIds: [...(model.availableResponseSpeedIds || [])],
  }));
}

function buildCodexResponseSpeedSnapshot(
  selectedModelOption: CodexAvailableModel | null,
  defaults: CodexConfigDefaults
): CodexResponseSpeedSnapshot {
  if (!selectedModelOption) {
    return {
      selectedModeId: null,
      selectedLabel: 'לא נתמך',
      configurable: false,
      note: 'בחר מודל כדי לבדוק אילו מצבי מהירות זמינים ב-Codex CLI.',
      availableModes: [],
    };
  }

  const supportsFast = Boolean(selectedModelOption.availableResponseSpeedIds?.includes('fast'));
  const selectedModeId = defaults.serviceTier === 'fast' ? 'fast' : 'flex';
  return {
    selectedModeId,
    selectedLabel: selectedModeId === 'fast' ? 'מהיר' : 'רגיל',
    configurable: true,
    note: supportsFast
      ? 'Codex response speed נשלט דרך service_tier בקובץ config.toml.'
      : `למודל ${selectedModelOption.displayName} יש כרגע tier רגיל בלבד.`,
    availableModes: [
      {
        id: 'flex',
        label: 'רגיל',
        description: 'תצורת ברירת המחדל של Codex CLI ליציבות ושימוש מאוזן.',
      },
      ...(supportsFast
        ? [{
          id: 'fast',
          label: 'מהיר',
          description: 'מהירות תגובה גבוהה יותר עם שימוש מוגבר.',
        }]
        : []),
    ],
  };
}

export async function updateCodexResponseSpeed(profileId: string | undefined, modeId: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  const normalizedModeId = normalizeCodexServiceTierValue(modeId);
  if (!normalizedModeId) {
    throw new Error('Codex response speed mode is invalid');
  }

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
  const supportsFast = Boolean(selectedModelOption?.availableResponseSpeedIds?.includes('fast'));
  if (normalizedModeId === 'fast' && !supportsFast) {
    throw new Error('Fast mode is not available for the selected Codex model');
  }

  const configPath = path.join(profile.codexHome, 'config.toml');
  await writeRootTomlString(
    profile,
    configPath,
    'service_tier',
    normalizeCodexServiceTierConfigValue(normalizedModeId)
  );
  return getCodexModelCatalog(profile.id);
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
      availableResponseSpeedIds: [...(model.availableResponseSpeedIds || [])],
    })),
    selectedModel,
    selectedReasoningEffort,
    responseSpeed: buildCodexResponseSpeedSnapshot(selectedModelOption, defaults),
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
  const requestedPermissionModeId = normalizeExecutionSettingValue(executionConfig?.permissionModeId);

  if (!requestedModel && !requestedReasoningEffort) {
    return {
      model: null,
      reasoningEffort: null,
      permissionModeId: requestedPermissionModeId,
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
    permissionModeId: requestedPermissionModeId,
  };
}

function collectCodexArgs(
  permissionArgs: string[],
  sessionId?: string,
  imagePaths: string[] = [],
  executionConfig?: CodexExecutionConfig | null
): string[] {
  const baseArgs = [
    ...permissionArgs,
    'exec',
    '--json',
    '--skip-git-repo-check',
  ];
  const executionArgs = [
    ...(executionConfig?.model ? ['--model', executionConfig.model] : []),
    ...(executionConfig?.reasoningEffort ? ['--config', `model_reasoning_effort="${executionConfig.reasoningEffort}"`] : []),
  ];
  const imageArgs = imagePaths.flatMap((imagePath) => ['--image', imagePath]);

  if (sessionId) {
    return [...baseArgs, 'resume', ...executionArgs, ...imageArgs, sessionId, '-'];
  }

  return [...baseArgs, ...executionArgs, ...imageArgs, '-'];
}

async function resolveCodexPermissionArgs(
  profile: CodexProfile,
  permissionModeId?: string | null
): Promise<string[]> {
  const selectedMode = permissionModeId
    ? resolvePermissionMode(profile, permissionModeId)
    : await getSelectedPermissionMode(profile);
  if (selectedMode.id === 'restricted') {
    return ['--ask-for-approval', 'on-request', '--sandbox', 'read-only'];
  }
  if (selectedMode.id === 'balanced') {
    return ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'];
  }
  return ['--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'danger-full-access'];
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
    contextPrefix?: string;
    executionConfig?: CodexExecutionConfig | null;
    allowCompactionResumeRepair?: boolean;
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
  const effectivePromptText = options.contextPrefix?.trim()
    ? `${options.contextPrefix.trim()}\n\nהודעת ההמשך החדשה:\n${promptText}`
    : promptText;
  const queueKey = `${profile.id}:${sessionId || '__new__'}`;
  const executionConfig = await resolveCodexExecutionConfig(profile, options.executionConfig);

  return queueBySessionKey(queueKey, async () => {
    const previousSession = sessionId ? await resolveSessionRecord(profile, sessionId) : null;
    const permissionArgs = await resolveCodexPermissionArgs(profile, executionConfig.permissionModeId);
    const args = collectCodexArgs(permissionArgs, sessionId, imagePaths, executionConfig);

    return new Promise<CodexRunResult>((resolve, reject) => {
      const child = spawn(CODEX_BIN, args, {
        cwd: runCwd,
        env: buildCodexProcessEnv(profile),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...getProfileSpawnIdentity(profile),
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
      const stdoutLines: string[] = [];
      const structuredErrors: string[] = [];

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
      child.stdin.end(effectivePromptText);

      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;

        while (stdoutBuffer.includes('\n')) {
          const newlineIndex = stdoutBuffer.indexOf('\n');
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

          if (!line) continue;
          stdoutLines.push(line);
          if (stdoutLines.length > 120) {
            stdoutLines.splice(0, stdoutLines.length - 120);
          }
          const row = safeJsonParse<any>(line);
          if (!row) continue;

          const structuredError = extractCodexStructuredError(row);
          if (structuredError) {
            structuredErrors.push(structuredError);
            if (structuredErrors.length > 40) {
              structuredErrors.splice(0, structuredErrors.length - 40);
            }
          }

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
          const failureDetails = buildCodexFailureDetails(
            `Codex exited with code ${code}`,
            stderrBuffer,
            stdoutLines,
            structuredErrors
          );
          if (
            sessionId
            && options.allowCompactionResumeRepair !== false
            && isCodexContextCompactionFailureText(failureDetails)
          ) {
            try {
              const recovery = await buildCodexCompactionRecoveryContext(sessionId, profile.id);
              const repairedResult = await runCodexPrompt(
                trimmedPrompt,
                undefined,
                profile.id,
                attachments,
                {
                  runId: activeRunId,
                  cwd: runCwd,
                  injectDirectoryContext: false,
                  contextPrefix: recovery.promptPrefix,
                  executionConfig,
                  allowCompactionResumeRepair: false,
                }
              );
              resolve({
                ...repairedResult,
                recoveredFromSessionId: sessionId,
                recoveryMode: 'compact-clone',
              });
              return;
            } catch (recoveryError) {
              const recoveryMessage = recoveryError instanceof Error
                ? recoveryError.message
                : String(recoveryError || 'Unknown recovery error');
              reject(new Error(
                `${sanitizeCodexCliFailure(profile, failureDetails, `Codex exited with code ${code}`)}\n\nAutomatic compact-clone recovery also failed:\n${recoveryMessage}`
              ));
              return;
            }
          }
          reject(new Error(sanitizeCodexCliFailure(profile, failureDetails, `Codex exited with code ${code}`)));
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
