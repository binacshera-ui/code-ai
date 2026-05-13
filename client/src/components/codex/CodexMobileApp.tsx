import {
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type TouchEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  ArchiveRestore,
  Brain,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  Copy,
  Download,
  Eye,
  File,
  FileDiff,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  Filter,
  Gauge,
  Gamepad2,
  GitBranch,
  LayoutGrid,
  ListPlus,
  Loader2,
  LogOut,
  Menu,
  Moon,
  Pause,
  Paperclip,
  Play,
  RefreshCw,
  Repeat,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  SquarePen,
  Tag,
  Sun,
  TrainFront,
  User,
  Trash2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CodexCodeBlock } from '@/components/codex/CodexCodeBlock';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  SUDOKU_CATALOG,
  type SudokuPuzzleDifficulty,
} from './sudokuCatalog';
import { BiomeSnakeDialog } from './BiomeSnakeDialog';
import { IronDesertDialog } from './IronDesertDialog';
import { RailHeistDialog } from './RailHeistDialog';
import { TempleGemQuestDialog } from './TempleGemQuestDialog';
import { VaultRunnerDialog } from './VaultRunnerDialog';
import {
  installCodexGlobalCrashHandlers,
  recordCodexBreadcrumb,
  reportCodexClientLog,
  setCodexRuntimeContext,
} from '@/components/codex/codexCrashLogger';
import { cn } from '@/lib/utils';

interface AuthStatus {
  authenticated: boolean;
  localBypass: boolean;
  publicAccess?: boolean;
  deviceUnlocked?: boolean;
  user: null | {
    id: string;
    email: string;
    name: string;
  };
}

interface CodexProfile {
  id: string;
  label: string;
  provider: 'codex' | 'claude' | 'gemini';
  mode?: 'standard' | 'support';
  codexHome: string;
  workspaceCwd: string;
  sourceProfileId?: string;
  sandboxCwd?: string;
  defaultProfile?: boolean;
}

interface CodexUploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  isImage: boolean;
}

interface DraftAttachment extends CodexUploadedAttachment {
  previewUrl?: string;
}

interface CodexTimelineEntry {
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

interface CodexSessionSummary {
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
  source: string;
  hidden?: boolean;
  topic?: CodexSessionTopic | null;
  forkSourceSessionId?: string | null;
  forkEntryId?: string | null;
  isDraft?: boolean;
  isCompactClone?: boolean;
  compactSourceSessionId?: string | null;
}

interface CodexForkDraftServerContext extends ForkDraftContext {
  sessionId: string;
  profileId: string;
  promptPreview: string;
  createdAt: string;
  updatedAt: string;
}

interface CodexSessionDetail extends CodexSessionSummary {
  cwd: string | null;
  modelProvider: string | null;
  timeline: CodexTimelineEntry[];
  totalTimelineEntries: number;
  timelineWindowStart: number;
  timelineWindowEnd: number;
  hasEarlierTimeline: boolean;
  forkDraftContext?: CodexForkDraftServerContext | null;
}

interface CodexSessionTopic {
  id: string;
  profileId: string;
  cwd: string;
  name: string;
  icon: string;
  colorKey: string;
  createdAt: string;
  updatedAt: string;
}

interface CodexQueueServerItem {
  id: string;
  profileId: string;
  queueKey: string;
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  prompt: string;
  promptPreview: string;
  forkContext?: ForkDraftContext | null;
  attachments: CodexUploadedAttachment[];
  status: 'scheduled' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  finalMessage: string | null;
  error: string | null;
  attempts: number;
  scheduleMode: 'once' | 'recurring';
  recurringFrequency: 'daily' | 'weekly' | null;
  recurringTimeZone: string | null;
  lastRunAt: string | null;
  lastRunStatus: 'completed' | 'failed' | null;
}

interface CodexReasoningLevelOption {
  effort: string;
  description: string | null;
}

interface CodexModelOption {
  slug: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: CodexReasoningLevelOption[];
  isConfiguredDefault: boolean;
}

interface CodexModelCatalogResponse {
  models: CodexModelOption[];
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  permissions: CodexPermissionSnapshotResponse | null;
}

interface CodexPermissionSnapshotResponse {
  accessLevel: 'full' | 'balanced' | 'restricted';
  accessLabel: string;
  modeLabel: string;
  summary: string;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
}

interface CodexRateLimitWindowResponse {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
  resetsAtIso: string | null;
}

interface CodexContextUsageSnapshotResponse {
  modelContextWindow: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  usagePercent: number | null;
}

interface CodexRateLimitSnapshotResponse {
  profileId: string;
  sessionId: string | null;
  updatedAt: string | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  primary: CodexRateLimitWindowResponse | null;
  secondary: CodexRateLimitWindowResponse | null;
  context: CodexContextUsageSnapshotResponse | null;
}

interface SessionChangeFileRecordResponse {
  id: string;
  path: string;
  displayPath: string;
  previousPath: string | null;
  status: 'created' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  isBinary: boolean;
  diffText: string;
  diffTruncated: boolean;
}

interface SessionChangeSummaryResponse {
  totalFiles: number;
  created: number;
  modified: number;
  deleted: number;
  renamed: number;
  additions: number;
  deletions: number;
}

interface SessionChangeRecordResponse {
  sessionId: string;
  entryId: string;
  provider: 'codex' | 'claude' | 'gemini';
  profileId: string;
  cwd: string | null;
  repoRoot: string | null;
  createdAt: string;
  summary: SessionChangeSummaryResponse;
  files: SessionChangeFileRecordResponse[];
}

interface ForkDraftContext {
  sourceSessionId: string;
  sourceTitle: string;
  sourceCwd: string | null;
  forkEntryId: string;
  transferSourceProvider?: 'codex' | 'claude' | 'gemini' | null;
  transferTargetProvider?: 'codex' | 'claude' | 'gemini' | null;
  forkedAt: string;
  timeline: CodexTimelineEntry[];
  promptPrefix: string;
}

interface TransferTargetOption {
  profileId: string;
  provider: CodexProfile['provider'];
  label: string;
}

interface CodexQueueItemsResponse {
  items: CodexQueueServerItem[];
}

interface CodexQueueItemResponse {
  item: CodexQueueServerItem;
  session: CodexSessionDetail | null;
}

interface CodexForkCreateResponse {
  sessionId: string;
  forkedAt: string;
  session: CodexSessionSummary;
}

interface CodexTransferCreateResponse {
  sessionId: string;
  targetProfileId: string;
  forkedAt: string;
  autoPrompt: string;
  session: CodexSessionDetail;
  item: CodexQueueServerItem;
}

interface CodexDeleteTurnResponse {
  sessionId: string;
  deletedUserEntryId: string;
  deletedAssistantEntryId: string | null;
  cancelledQueueItemIds: string[];
  session: CodexSessionDetail;
}

interface CodexSessionInstructionResponse {
  instruction: string | null;
}

interface CodexFilePreview {
  path: string;
  name: string;
  extension: string;
  size: number;
  lineNumber: number | null;
  isMarkdown: boolean;
  isText: boolean;
  mimeType: string;
  previewKind: 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'embed' | 'binary';
  codeLanguage: string | null;
  truncated: boolean;
  content: string | null;
  downloadUrl: string;
  contentUrl: string;
}

interface CodexFileMatch {
  path: string;
  name: string;
  relativePath: string;
  rootPath: string;
  size: number;
  updatedAt: string;
}

interface CodexFilePreviewResponse {
  file: CodexFilePreview;
}

interface CodexFileMatchesResponse {
  query: string;
  lineNumber: number | null;
  matches: CodexFileMatch[];
}

type CodexFilePreviewLookupResult =
  | { kind: 'file'; file: CodexFilePreview }
  | { kind: 'matches'; query: string; lineNumber: number | null; matches: CodexFileMatch[] };

interface CodexFolderRoot {
  label: string;
  path: string;
}

interface CodexFolderEntry {
  name: string;
  path: string;
  relativePath: string;
  rootPath: string;
}

interface CodexFolderBreadcrumb {
  name: string;
  path: string;
}

interface CodexFolderBrowseResult {
  currentPath: string;
  currentName: string;
  rootPath: string;
  parentPath: string | null;
  breadcrumbs: CodexFolderBreadcrumb[];
  entries: CodexFolderEntry[];
  roots: CodexFolderRoot[];
}

interface CodexFileTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  rootPath: string;
  kind: 'directory' | 'file';
  size: number | null;
  extension: string | null;
}

interface CodexFileTreeBrowseResult {
  currentPath: string;
  currentName: string;
  rootPath: string;
  parentPath: string | null;
  breadcrumbs: CodexFolderBreadcrumb[];
  entries: CodexFileTreeEntry[];
  roots: CodexFolderRoot[];
  truncated: boolean;
}

interface SessionFolderGroup {
  key: string;
  cwd: string | null;
  label: string;
  pathLabel: string | null;
  sessions: CodexSessionSummary[];
}

interface SessionTopicGroup {
  key: string;
  topic: CodexSessionTopic | null;
  label: string;
  sessions: CodexSessionSummary[];
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

type ThemeMode = 'light' | 'dark';
type WorkspaceMode = 'standard' | 'support';

const INITIAL_TIMELINE_WINDOW_SIZE = 120;
const TIMELINE_WINDOW_INCREMENT = 120;
const TIMELINE_FULL_LOAD_CHUNK_SIZE = 400;
const APP_DISPLAY_NAME = 'code-ai';
const APP_ICON_PATH = '/icons/code-ai-512.png';
const APPLE_TOUCH_ICON_PATH = '/icons/apple-touch-icon.png';
const CODEX_EMPTY_STATE_ICON_PATH = '/icons/codex-empty-state.png';
const CLAUDE_EMPTY_STATE_ICON_PATH = '/icons/claude-agent.png';
const GEMINI_EMPTY_STATE_ICON_PATH = '/icons/gemini-agent.png';
const CODE_AI_PUBLIC_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const PROVIDER_DISPLAY_ORDER: CodexProfile['provider'][] = ['codex', 'claude', 'gemini'];
const WORKSPACE_MODE_STORAGE_KEY = 'code-ai.workspaceMode';

function formatTimestamp(value: string | null): string {
  if (!value) return 'ללא זמן';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatCompactTimestamp(value: string | null): string {
  if (!value) return 'ללא זמן';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('he-IL', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatCompactTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'ללא נתון';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  }

  return `${Math.round(value)}`;
}

function getContextUsageDisplayTokens(context: CodexContextUsageSnapshotResponse | null | undefined): number | null {
  if (!context) {
    return null;
  }

  if (context.inputTokens === null && context.cachedInputTokens === null) {
    return null;
  }

  return (context.inputTokens || 0) + (context.cachedInputTokens || 0);
}

function getRateLimitWindowLabel(windowMinutes: number | null, fallbackLabel: string): string {
  if (windowMinutes === 300) {
    return '5 שעות';
  }

  if (windowMinutes === 10080) {
    return 'שבוע';
  }

  if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    if (windowMinutes < 60) {
      return `${windowMinutes} דק׳`;
    }

    if (windowMinutes % 60 === 0) {
      return `${windowMinutes / 60} שעות`;
    }
  }

  return fallbackLabel;
}

function clampPercent(value: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

function getPermissionTone(permission: CodexPermissionSnapshotResponse | null): {
  badgeClassName: string;
  barClassName: string;
} {
  if (permission?.accessLevel === 'restricted') {
    return {
      badgeClassName: 'border border-emerald-100/80 bg-emerald-50 text-emerald-600',
      barClassName: 'from-emerald-300 via-cyan-200 to-sky-200',
    };
  }

  if (permission?.accessLevel === 'balanced') {
    return {
      badgeClassName: 'border border-sky-100/80 bg-sky-50 text-sky-600',
      barClassName: 'from-sky-300 via-cyan-200 to-emerald-200',
    };
  }

  return {
    badgeClassName: 'border border-amber-100/80 bg-amber-50 text-amber-700',
    barClassName: 'from-amber-300 via-orange-200 to-rose-200',
  };
}

function trimText(text: string, limit = 72): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function trimWords(text: string, limit = 5): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= limit) {
    return words.join(' ');
  }
  return `${words.slice(0, limit).join(' ')}…`;
}

function getQueueStatusLabel(status: CodexQueueServerItem['status']): string {
  switch (status) {
    case 'scheduled':
      return 'מתוזמן';
    case 'queued':
      return 'ממתין';
    case 'running':
      return 'רץ';
    case 'cancelling':
      return 'עוצר';
    case 'completed':
      return 'הושלם';
    case 'failed':
      return 'נכשל';
    case 'cancelled':
      return 'בוטל';
    default:
      return status;
  }
}

function getQueueStatusSummaryLabel(status: CodexQueueServerItem['status']): string {
  switch (status) {
    case 'scheduled':
      return 'מתוזמנות';
    case 'queued':
      return 'ממתינות';
    case 'running':
      return 'בריצה';
    case 'cancelling':
      return 'בעצירה';
    case 'completed':
      return 'הושלמו';
    case 'failed':
      return 'נכשלו';
    case 'cancelled':
      return 'בוטלו';
    default:
      return status;
  }
}

function getQueueStatusClass(status: CodexQueueServerItem['status']): string {
  switch (status) {
    case 'scheduled':
      return 'bg-violet-100 text-violet-800';
    case 'queued':
      return 'bg-amber-100 text-amber-800';
    case 'running':
      return 'bg-cyan-100 text-cyan-800';
    case 'cancelling':
      return 'bg-rose-100 text-rose-800';
    case 'completed':
      return 'bg-emerald-100 text-emerald-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    case 'cancelled':
      return 'bg-slate-200 text-slate-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

function isQueueItemActive(item: CodexQueueServerItem): boolean {
  return (
    item.status === 'scheduled'
    || item.status === 'queued'
    || item.status === 'running'
    || item.status === 'cancelling'
  );
}

function shouldDisplayQueueItem(item: CodexQueueServerItem): boolean {
  if (item.scheduleMode === 'recurring') {
    return item.status !== 'completed';
  }

  return isQueueItemActive(item) || item.status === 'failed' || item.status === 'cancelled';
}

function getRecurringFrequencyLabel(frequency: CodexQueueServerItem['recurringFrequency']): string {
  switch (frequency) {
    case 'daily':
      return 'כל יום';
    case 'weekly':
      return 'כל שבוע';
    default:
      return 'קבוע';
  }
}

function getWeekdayLabel(value: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('he-IL', { weekday: 'long' }).format(date);
}

function getReasoningEffortLabel(effort: string | null): string {
  switch (effort) {
    case 'none':
      return 'ללא';
    case 'minimal':
      return 'מינימלית';
    case 'low':
      return 'נמוכה';
    case 'medium':
      return 'בינונית';
    case 'high':
      return 'גבוהה';
    case 'xhigh':
      return 'עמוקה';
    case 'max':
      return 'מקסימלית';
    default:
      return effort || 'ברירת מחדל';
  }
}

function getProviderDisplayLabel(provider: CodexProfile['provider']): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Codex';
  }
}

function getProviderLogoSrc(provider: CodexProfile['provider']): string {
  switch (provider) {
    case 'claude':
      return '/icons/claude-agent.png';
    case 'gemini':
      return '/icons/gemini-agent.png';
    default:
      return '/icons/codex-empty-state.png';
  }
}

function readWorkspaceMode(): WorkspaceMode {
  if (typeof window === 'undefined') {
    return 'standard';
  }

  const raw = window.localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY);
  return raw === 'support' ? 'support' : 'standard';
}

function writeWorkspaceMode(mode: WorkspaceMode) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, mode);
}

function filterProfilesForMode(profiles: CodexProfile[], mode: WorkspaceMode): CodexProfile[] {
  return profiles.filter((profile) => (mode === 'support' ? profile.mode === 'support' : profile.mode !== 'support'));
}

function resolveDefaultProfileForWorkspaceMode(
  profiles: CodexProfile[],
  mode: WorkspaceMode,
  provider?: CodexProfile['provider']
): CodexProfile | null {
  const modeProfiles = filterProfilesForMode(profiles, mode)
    .filter((profile) => (!provider || profile.provider === provider));
  return modeProfiles.find((profile) => profile.defaultProfile) || modeProfiles[0] || null;
}

function getSessionChangeStatusLabel(status: SessionChangeFileRecordResponse['status']): string {
  switch (status) {
    case 'created':
      return 'נוצר';
    case 'deleted':
      return 'נמחק';
    case 'renamed':
      return 'שונה שם';
    default:
      return 'עודכן';
  }
}

function getSessionChangeStatusClasses(status: SessionChangeFileRecordResponse['status']): string {
  switch (status) {
    case 'created':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'deleted':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'renamed':
      return 'border-violet-200 bg-violet-50 text-violet-700';
    default:
      return 'border-sky-200 bg-sky-50 text-sky-700';
  }
}

function resolveTransferTargetProfiles(
  profiles: CodexProfile[],
  currentProfile: CodexProfile | null
): CodexProfile[] {
  if (!currentProfile) {
    return [];
  }

  const normalizedLabel = currentProfile.label.trim().toLowerCase();
  const targets = PROVIDER_DISPLAY_ORDER
    .filter((provider) => provider !== currentProfile.provider)
    .map((provider) => {
      const providerProfiles = profiles.filter((profile) => profile.provider === provider);
      if (providerProfiles.length === 0) {
        return null;
      }

      return (
        providerProfiles.find((profile) => profile.label.trim().toLowerCase() === normalizedLabel)
        || providerProfiles.find((profile) => profile.workspaceCwd === currentProfile.workspaceCwd)
        || providerProfiles.find((profile) => profile.defaultProfile)
        || providerProfiles[0]
      );
    })
    .filter((profile): profile is CodexProfile => Boolean(profile));

  return targets;
}

function mapForkDraftServerContext(
  serverContext: CodexForkDraftServerContext,
  fallbackTimestamp: string
): ForkDraftContext {
  return {
    sourceSessionId: serverContext.sourceSessionId,
    sourceTitle: serverContext.sourceTitle,
    sourceCwd: serverContext.sourceCwd,
    forkEntryId: serverContext.forkEntryId,
    transferSourceProvider: serverContext.transferSourceProvider || null,
    transferTargetProvider: serverContext.transferTargetProvider || null,
    forkedAt: serverContext.updatedAt || fallbackTimestamp,
    timeline: serverContext.timeline,
    promptPrefix: serverContext.promptPrefix,
  };
}

function CopyButton({
  text,
  className,
  ariaLabel,
}: {
  text: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  if (!text.trim()) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700',
        className
      )}
      aria-label={copied ? 'הועתק' : (ariaLabel || 'העתק')}
      title={copied ? 'הועתק' : 'העתק'}
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

function tryParseToolJson(rawText: string): unknown | null {
  const trimmed = rawText.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractStandaloneCodeFence(rawText: string): { language: string | null; code: string } | null {
  const match = rawText.trim().match(/^```([a-zA-Z0-9_+-]+)?\n([\s\S]*?)\n```$/);
  if (!match) {
    return null;
  }

  return {
    language: match[1] || null,
    code: match[2] || '',
  };
}

function resolveToolDetailView(entry: CodexTimelineEntry): {
  mode: 'terminal' | 'code';
  label: string;
  badge: string;
  code: string;
  language: string | null;
} {
  const text = entry.text?.trim() || '';
  const identity = getToolIdentity(entry);
  const fenced = extractStandaloneCodeFence(text);
  const parsedJson = fenced ? null : tryParseToolJson(text);

  if (parsedJson !== null) {
    return {
      mode: 'code',
      label: 'JSON payload',
      badge: 'JSON',
      code: JSON.stringify(parsedJson, null, 2),
      language: 'json',
    };
  }

  if (fenced) {
    const language = fenced.language?.toLowerCase() || null;
    const isTerminalFence = language === 'bash' || language === 'sh' || language === 'shell' || language === 'zsh';
    return {
      mode: isTerminalFence ? 'terminal' : 'code',
      label: isTerminalFence ? 'Terminal output' : 'Code payload',
      badge: language ? language.toUpperCase() : 'CODE',
      code: fenced.code,
      language,
    };
  }

  if (identity.includes('apply patch') || identity.includes('patch')) {
    return {
      mode: 'code',
      label: 'Patch payload',
      badge: 'DIFF',
      code: text,
      language: 'diff',
    };
  }

  if (identity.includes('thinking')) {
    return {
      mode: 'terminal',
      label: 'Reasoning trace',
      badge: 'TRACE',
      code: text,
      language: null,
    };
  }

  if (identity.includes('exec command') || identity.includes('write stdin') || identity.includes('terminal')) {
    return {
      mode: 'terminal',
      label: 'Terminal output',
      badge: 'TERM',
      code: text,
      language: null,
    };
  }

  return {
    mode: 'terminal',
    label: 'Tool output',
    badge: 'TEXT',
    code: text,
    language: null,
  };
}

function resolveToolDialogSubtitle(entry: CodexTimelineEntry): string | null {
  const subtitle = entry.subtitle?.trim() || '';
  if (!subtitle) {
    return null;
  }

  const normalizedSubtitle = subtitle.replace(/\s+/g, ' ').trim();
  if (!normalizedSubtitle) {
    return null;
  }

  if (
    subtitle.length > 140
    || subtitle.includes('\n')
    || subtitle.includes('{')
    || subtitle.includes('[')
    || subtitle.includes('```')
  ) {
    return null;
  }

  const detailText = resolveToolDetailView(entry).code.replace(/\s+/g, ' ').trim();
  if (detailText && detailText.includes(normalizedSubtitle)) {
    return null;
  }

  return subtitle;
}

function ToolDetailViewer({
  entry,
}: {
  entry: CodexTimelineEntry;
}) {
  if (!entry.text?.trim()) {
    return <div className="text-sm text-slate-500">אין פלט נוסף לכלי הזה.</div>;
  }

  const detail = resolveToolDetailView(entry);

  if (detail.mode === 'terminal') {
    return (
      <div className="overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300/90" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
          </div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <span
              dir="ltr"
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-semibold text-slate-300"
            >
              {detail.badge}
            </span>
            <span dir="ltr">{detail.label}</span>
          </div>
        </div>
        <pre
          dir="ltr"
          className="max-h-[52dvh] overflow-x-auto overflow-y-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-100"
        >
          <code className="block min-w-max whitespace-pre">{detail.code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-400/90" />
          <span className="h-2.5 w-2.5 rounded-full bg-violet-400/90" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90" />
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
          <span
            dir="ltr"
            className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-semibold text-slate-200"
          >
            {detail.badge}
          </span>
          <span dir="ltr">{detail.label}</span>
        </div>
      </div>
      <CodexCodeBlock
        code={detail.code}
        language={detail.language}
        className="max-h-[52dvh] overflow-x-auto overflow-y-auto rounded-none border-0 shadow-none"
      />
    </div>
  );
}

function buildEditableDraftAttachments(attachments: CodexUploadedAttachment[]): DraftAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    previewUrl: undefined,
  }));
}

function toDraftSessionId(value: string): string {
  return value.startsWith('draft:') ? value : `draft:${value}`;
}

function parseSlashCommand(rawPrompt: string): { name: string; args: string } | null {
  const trimmed = rawPrompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [nameToken, ...restTokens] = trimmed.split(/\s+/);
  if (!nameToken) {
    return null;
  }

  return {
    name: nameToken.toLowerCase(),
    args: restTokens.join(' ').trim(),
  };
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  const trimmed = rawText.trim();
  const looksLikeJson = contentType.includes('application/json')
    || trimmed.startsWith('{')
    || trimmed.startsWith('[');

  if (!looksLikeJson) {
    const requestLabel = typeof input === 'string' ? input : 'request';
    throw new Error(`Expected JSON from ${requestLabel}, received ${contentType || 'non-JSON response'}`);
  }

  const data = trimmed ? JSON.parse(trimmed) : null;

  if (!response.ok) {
    throw new Error((data as { error?: string } | null)?.error || 'Request failed');
  }

  return data as T;
}

async function fetchCodexModelCatalog(profileId: string): Promise<CodexModelCatalogResponse> {
  return fetchJson<CodexModelCatalogResponse>(`/api/codex/models?profile=${encodeURIComponent(profileId)}`);
}

async function fetchCodexRateLimits(profileId: string, sessionId?: string | null): Promise<CodexRateLimitSnapshotResponse | null> {
  const query = new URLSearchParams({ profile: profileId });
  if (sessionId?.trim()) {
    query.set('sessionId', sessionId.trim());
  }
  const data = await fetchJson<{ rateLimits: CodexRateLimitSnapshotResponse | null }>(
    `/api/codex/rate-limits?${query.toString()}`
  );
  return data.rateLimits || null;
}

async function fetchSessionChangeRecord(
  sessionId: string,
  entryId: string,
  profileId?: string | null
): Promise<SessionChangeRecordResponse | null> {
  const profileQuery = profileId ? `?profile=${encodeURIComponent(profileId)}` : '';
  const data = await fetchJson<{ record: SessionChangeRecordResponse | null }>(
    `/api/codex/sessions/${encodeURIComponent(sessionId)}/changes/${encodeURIComponent(entryId)}${profileQuery}`
  );
  return data.record || null;
}

function isGoalClearCommand(command: { name: string; args: string }): boolean {
  if (command.name === '/cleargoal' || command.name === '/clear-goal' || command.name === '/ungoal') {
    return true;
  }

  if (command.name !== '/goal') {
    return false;
  }

  const normalizedArgs = command.args.toLowerCase();
  return normalizedArgs === 'clear'
    || normalizedArgs === 'off'
    || normalizedArgs === 'none'
    || normalizedArgs === 'reset';
}

async function fetchFilePreview(rawPath: string): Promise<CodexFilePreviewLookupResult> {
  const response = await fetch(`/api/codex/files/preview?path=${encodeURIComponent(rawPath)}`);
  const data = await response.json();

  if (response.status === 409 && Array.isArray(data.matches)) {
    const matchesResponse = data as CodexFileMatchesResponse;
    return {
      kind: 'matches',
      query: matchesResponse.query,
      lineNumber: matchesResponse.lineNumber,
      matches: matchesResponse.matches,
    };
  }

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  const previewResponse = data as CodexFilePreviewResponse;
  return {
    kind: 'file',
    file: previewResponse.file,
  };
}

async function fetchSessionInstruction(profileId: string, sessionKey: string): Promise<string | null> {
  const data = await fetchJson<CodexSessionInstructionResponse>(
    `/api/codex/session-instruction?profileId=${encodeURIComponent(profileId)}&sessionKey=${encodeURIComponent(sessionKey)}`
  );
  return data.instruction || null;
}

async function saveSessionInstruction(profileId: string, sessionKey: string, instruction: string | null): Promise<string | null> {
  const data = await fetchJson<CodexSessionInstructionResponse>('/api/codex/session-instruction', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId,
      sessionKey,
      instruction,
    }),
  });
  return data.instruction || null;
}

async function fetchFolderBrowser(profileId: string, targetPath?: string | null): Promise<CodexFolderBrowseResult> {
  const query = new URLSearchParams({
    profile: profileId,
  });

  if (targetPath) {
    query.set('path', targetPath);
  }

  return fetchJson<CodexFolderBrowseResult>(`/api/codex/folders?${query.toString()}`);
}

async function fetchFileTreeBrowser(profileId: string, targetPath?: string | null): Promise<CodexFileTreeBrowseResult> {
  const query = new URLSearchParams({
    profile: profileId,
  });

  if (targetPath) {
    query.set('path', targetPath);
  }

  return fetchJson<CodexFileTreeBrowseResult>(`/api/codex/file-tree?${query.toString()}`);
}

async function fetchTopics(profileId: string, cwd: string): Promise<CodexSessionTopic[]> {
  const query = new URLSearchParams({
    profile: profileId,
    cwd,
  });
  const data = await fetchJson<{ topics: CodexSessionTopic[] }>(`/api/codex/topics?${query.toString()}`);
  return data.topics;
}

async function createTopic(
  profileId: string,
  cwd: string,
  payload: {
    name: string;
    icon: string;
    colorKey: string;
  }
): Promise<CodexSessionTopic> {
  const data = await fetchJson<{ topic: CodexSessionTopic }>('/api/codex/topics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId,
      cwd,
      ...payload,
    }),
  });
  return data.topic;
}

async function assignSessionTopicRequest(
  profileId: string,
  sessionId: string,
  topicId: string | null,
  cwd: string | null
): Promise<CodexSessionTopic | null> {
  const data = await fetchJson<{ topic: CodexSessionTopic | null }>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/topic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId,
      topicId,
      cwd,
    }),
  });
  return data.topic;
}

async function updateSessionTitleRequest(
  profileId: string,
  sessionId: string,
  title: string | null
): Promise<{ title: string | null; displayTitle: string }> {
  return fetchJson<{ title: string | null; displayTitle: string }>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profileId,
      title,
    }),
  });
}

function buildQueueId() {
  return globalThis.crypto?.randomUUID?.() || `queue-${Date.now()}-${Math.random()}`;
}

function createDraftConversationKey() {
  return `draft-${buildQueueId()}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, '0');
}

function getTodayLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`;
}

function getCurrentLocalTime(): string {
  const now = new Date();
  return `${padDatePart(now.getHours())}:${padDatePart(now.getMinutes())}`;
}

function splitScheduledDateTime(value: string): { date: string; time: string } {
  if (!value) {
    return { date: '', time: '' };
  }

  const [datePart = '', timePart = ''] = value.split('T');
  return {
    date: datePart,
    time: timePart.slice(0, 5),
  };
}

function mergeScheduledDateTime(date: string, time: string): string {
  if (!date && !time) {
    return '';
  }

  return `${date || getTodayLocalDate()}T${time || getCurrentLocalTime()}`;
}

function toLocalDateTimeInputValue(value: string): string {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const localDate = `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
  const localTime = `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
  return `${localDate}T${localTime}`;
}

function getBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isStandaloneDisplayMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
}

function isIosInstallableDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isDocumentCurrentlyVisible(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  return document.visibilityState === 'visible';
}

function shouldUseMobileEnterBehavior(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const userAgent = navigator.userAgent || '';
  return coarsePointer || /Android|iPhone|iPad|iPod/i.test(userAgent);
}

function getQueueAnchorTime(item: Pick<CodexQueueServerItem, 'scheduledAt' | 'createdAt'>): number {
  const scheduledMs = new Date(item.scheduledAt || item.createdAt).getTime();
  if (!Number.isNaN(scheduledMs)) {
    return scheduledMs;
  }

  return new Date(item.createdAt).getTime();
}

function sortQueueItemsForDisplay(items: CodexQueueServerItem[]): CodexQueueServerItem[] {
  return [...items].sort((left, right) => {
    const rightAnchor = getQueueAnchorTime(right);
    const leftAnchor = getQueueAnchorTime(left);

    if (rightAnchor !== leftAnchor) {
      return rightAnchor - leftAnchor;
    }

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
}

function getSessionDisplayTitle(session: Pick<CodexSessionSummary, 'id' | 'title' | 'preview' | 'startPreview' | 'endPreview'>): string {
  const normalizedTitle = session.title.replace(/\s+/g, ' ').trim();
  if (normalizedTitle) {
    return trimWords(normalizedTitle, 5);
  }

  return trimWords(session.startPreview || session.preview || session.id, 5);
}

function getPathBaseName(value: string | null | undefined): string {
  if (!value) {
    return 'ללא תיקייה';
  }

  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function getRelativeFolderLabel(folderPath: string | null | undefined, workspaceRoot: string | null | undefined): string | null {
  if (!folderPath) {
    return null;
  }

  if (!workspaceRoot || !folderPath.startsWith(workspaceRoot)) {
    return folderPath;
  }

  const relative = folderPath.slice(workspaceRoot.length).replace(/^[/\\]+/, '');
  return relative || '.';
}

function buildSessionFolderGroups(
  sessions: CodexSessionSummary[],
  workspaceRoot: string | null | undefined
): SessionFolderGroup[] {
  const groups = new Map<string, SessionFolderGroup>();

  for (const session of sessions) {
    const key = session.cwd || '__no_cwd__';
    const existing = groups.get(key);

    if (existing) {
      existing.sessions.push(session);
      continue;
    }

    groups.set(key, {
      key,
      cwd: session.cwd,
      label: getPathBaseName(session.cwd),
      pathLabel: getRelativeFolderLabel(session.cwd, workspaceRoot),
      sessions: [session],
    });
  }

  return [...groups.values()];
}

const TOPIC_COLOR_PRESETS = {
  rose: {
    bg: '#FCE7F3',
    text: '#9D174D',
    border: '#F9A8D4',
  },
  orange: {
    bg: '#FFEDD5',
    text: '#9A3412',
    border: '#FDBA74',
  },
  amber: {
    bg: '#FEF3C7',
    text: '#92400E',
    border: '#FCD34D',
  },
  emerald: {
    bg: '#D1FAE5',
    text: '#065F46',
    border: '#6EE7B7',
  },
  sky: {
    bg: '#E0F2FE',
    text: '#0C4A6E',
    border: '#7DD3FC',
  },
  indigo: {
    bg: '#E0E7FF',
    text: '#3730A3',
    border: '#A5B4FC',
  },
  violet: {
    bg: '#F3E8FF',
    text: '#6B21A8',
    border: '#C4B5FD',
  },
  slate: {
    bg: '#F1F5F9',
    text: '#334155',
    border: '#CBD5E1',
  },
} as const;

const TOPIC_ICON_PRESETS = ['💼', '🛠️', '📚', '🧪', '🚀', '💡', '📝', '📦'];

function getTopicColorPreset(colorKey: string) {
  return TOPIC_COLOR_PRESETS[colorKey as keyof typeof TOPIC_COLOR_PRESETS] || TOPIC_COLOR_PRESETS.slate;
}

function buildSessionTopicGroups(sessions: CodexSessionSummary[]): SessionTopicGroup[] {
  const groups = new Map<string, SessionTopicGroup>();

  for (const session of sessions) {
    const key = session.topic?.id || '__untagged__';
    const existing = groups.get(key);

    if (existing) {
      existing.sessions.push(session);
      continue;
    }

    groups.set(key, {
      key,
      topic: session.topic || null,
      label: session.topic?.name || 'ללא נושא',
      sessions: [session],
    });
  }

  const ordered = [...groups.values()];
  ordered.sort((left, right) => {
    if (!left.topic && right.topic) return 1;
    if (left.topic && !right.topic) return -1;
    return left.label.localeCompare(right.label, 'he');
  });
  return ordered;
}

function parseLocalFileHref(href: string): { rawPath: string } | null {
  const decoded = decodeURIComponent(href).trim();
  if (
    !decoded
    || decoded.startsWith('#')
    || decoded.startsWith('/api/')
    || /^(?:https?:|mailto:|tel:)/i.test(decoded)
  ) {
    return null;
  }

  return { rawPath: decoded };
}

function isTextualPreviewKind(preview: Pick<CodexFilePreview, 'previewKind'>) {
  return preview.previewKind === 'markdown'
    || preview.previewKind === 'code'
    || preview.previewKind === 'text';
}

type TimelineRenderBlock =
  | { type: 'entry'; entry: CodexTimelineEntry }
  | { type: 'tool-row'; id: string; entries: CodexTimelineEntry[] };

function buildTimelineRenderBlocks(timeline: CodexTimelineEntry[]): TimelineRenderBlock[] {
  const blocks: TimelineRenderBlock[] = [];
  let pendingTools: CodexTimelineEntry[] = [];

  const flushPendingTools = () => {
    if (pendingTools.length === 0) {
      return;
    }

    blocks.push({
      type: 'tool-row',
      id: `${pendingTools[0]?.id || 'tool'}-${pendingTools[pendingTools.length - 1]?.id || pendingTools.length}`,
      entries: pendingTools,
    });
    pendingTools = [];
  };

  for (const entry of timeline) {
    if (entry.entryType === 'tool') {
      pendingTools.push(entry);
      continue;
    }

    flushPendingTools();
    blocks.push({ type: 'entry', entry });
  }

  flushPendingTools();
  return blocks;
}

function collapseTimelineForDisplay(timeline: CodexTimelineEntry[]): CodexTimelineEntry[] {
  if (timeline.length === 0) {
    return timeline;
  }

  const visibleEntries: CodexTimelineEntry[] = [];
  let currentSegment: CodexTimelineEntry[] = [];

  const flushSegment = () => {
    if (currentSegment.length === 0) {
      return;
    }

    const userMessages = currentSegment.filter((entry) => (
      entry.entryType === 'message' && entry.role === 'user'
    ));
    const finalAssistantMessages = currentSegment.filter((entry) => (
      entry.entryType === 'message' && entry.role === 'assistant' && entry.kind === 'final'
    ));
    const transferMessages = currentSegment.filter((entry) => (
      entry.entryType === 'message' && entry.kind === 'transfer'
    ));

    if (userMessages.length === 0) {
      visibleEntries.push(...currentSegment.filter((entry) => entry.entryType === 'message'));
      currentSegment = [];
      return;
    }

    if (finalAssistantMessages.length === 0) {
      visibleEntries.push(...currentSegment);
      currentSegment = [];
      return;
    }

    const finalAssistantIds = new Set(finalAssistantMessages.map((entry) => entry.id));
    const userMessageIds = new Set(userMessages.map((entry) => entry.id));
    const transferMessageIds = new Set(transferMessages.map((entry) => entry.id));
    visibleEntries.push(...currentSegment.filter((entry) => (
      userMessageIds.has(entry.id) || finalAssistantIds.has(entry.id) || transferMessageIds.has(entry.id)
    )));
    currentSegment = [];
  };

  for (const entry of timeline) {
    if (entry.entryType === 'message' && entry.role === 'user' && currentSegment.length > 0) {
      flushSegment();
    }

    currentSegment.push(entry);
  }

  flushSegment();
  return visibleEntries;
}

function getAttachmentIcon(attachment: DraftAttachment) {
  return attachment.isImage
    ? <FileImage className="h-4 w-4" />
    : <FileText className="h-4 w-4" />;
}

async function uploadFiles(files: File[]): Promise<DraftAttachment[]> {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));

  const response = await fetch('/api/codex/uploads', {
    method: 'POST',
    body: formData,
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Upload failed');
  }

  return data.files.map((attachment: CodexUploadedAttachment, index: number) => ({
    ...attachment,
    previewUrl: files[index]?.type.startsWith('image/')
      ? URL.createObjectURL(files[index])
      : undefined,
  }));
}

const MessageMarkdown = memo(function MessageMarkdown({
  text,
  isUser,
  onOpenFilePreview,
}: {
  text: string;
  isUser: boolean;
  onOpenFilePreview?: (rawPath: string) => void;
}) {
  return (
    <div
      className="min-w-0 max-w-full overflow-hidden text-[15px] leading-7"
      style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</p>
          ),
          h1: ({ children }) => <h1 className="mb-2 mt-1 text-xl font-black">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-1 text-lg font-black">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-1 text-base font-black">{children}</h3>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pr-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pr-5">{children}</ol>,
          li: ({ children }) => (
            <li className="break-words [overflow-wrap:anywhere]">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="break-words font-black [overflow-wrap:anywhere]">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="break-words italic [overflow-wrap:anywhere]">{children}</em>
          ),
          a: ({ href, children }) => (
            (() => {
              const localFile = href ? parseLocalFileHref(href) : null;
              const linkClassName = cn(
                'break-words font-medium underline underline-offset-4 [overflow-wrap:anywhere]',
                isUser ? 'text-cyan-100' : 'text-cyan-700'
              );

              if (localFile && onOpenFilePreview) {
                return (
                  <button
                    type="button"
                    onClick={() => onOpenFilePreview(localFile.rawPath)}
                    className={cn(linkClassName, 'text-right')}
                  >
                    {children}
                  </button>
                );
              }

              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClassName}
                >
                  {children}
                </a>
              );
            })()
          ),
          blockquote: ({ children }) => (
            <blockquote
              className={cn(
                'my-3 rounded-r-2xl border-r-4 px-4 py-3',
                isUser
                  ? 'border-cyan-200 bg-white/10 text-white'
                  : 'border-cyan-300 bg-cyan-50 text-slate-700'
              )}
            >
              {children}
            </blockquote>
          ),
          code: ((props: any) => {
            return (
              <code
                dir="ltr"
                className={cn(
                  'inline break-words font-mono text-[0.95em] font-semibold [overflow-wrap:anywhere]',
                  isUser ? 'text-white' : 'text-slate-900'
                )}
              >
                {props.children}
              </code>
            );
          }) as any,
          pre: ({ children }) => (
            <pre className={cn(
              'my-3 w-full max-w-full overflow-x-auto rounded-[1.25rem] px-4 py-3 text-left text-[13px] leading-6',
              isUser ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-900'
            )}>
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div
              dir="ltr"
              className="my-3 max-w-full overflow-x-auto overscroll-x-contain rounded-2xl border border-slate-200/80 bg-white touch-pan-x"
            >
              <table className="min-w-max border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-200 bg-slate-100 px-3 py-2 text-right font-bold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-200 px-3 py-2 align-top">{children}</td>
          ),
          hr: () => <hr className="my-4 border-slate-200" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}, (previousProps, nextProps) => (
  previousProps.text === nextProps.text
  && previousProps.isUser === nextProps.isUser
));

function StatusRow({
  entry,
  onContinue,
  isContinueLoading = false,
}: {
  entry: CodexTimelineEntry;
  onContinue?: (() => void) | undefined;
  isContinueLoading?: boolean;
}) {
  const copyText = [entry.title, entry.subtitle].filter(Boolean).join('\n');
  const isAborted = entry.status === 'aborted';
  const isSummaryAuto = entry.status === 'summary-auto';
  const StatusIcon = isSummaryAuto ? Brain : isAborted ? Pause : Check;
  const iconToneClass = isSummaryAuto
    ? 'bg-violet-100 text-violet-700'
    : isAborted
      ? 'bg-amber-100 text-amber-700'
      : 'bg-emerald-100 text-emerald-700';

  return (
    <div className="flex justify-center">
      <div className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-white px-3 py-2 text-center text-[11px] text-slate-500 shadow-sm">
        <CopyButton text={copyText} className="h-7 border-0 bg-slate-50 px-2 text-[10px]" />
        <div className="flex items-center gap-2">
          {isAborted && onContinue ? (
            <button
              type="button"
              onClick={onContinue}
              disabled={isContinueLoading}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors active:scale-95 disabled:opacity-50',
                iconToneClass
              )}
              title="המשך את הסבב עד הסוף"
              aria-label="המשך את הסבב עד הסוף"
            >
              {isContinueLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <StatusIcon className="h-4 w-4" />}
            </button>
          ) : (
            <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', iconToneClass)}>
              <StatusIcon className="h-4 w-4" />
            </div>
          )}
          <div>
            <div className="font-medium text-slate-700">{entry.title}</div>
            {entry.subtitle && <div className="mt-1 opacity-80">{entry.subtitle}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function getToolIdentity(entry: CodexTimelineEntry) {
  return `${entry.toolName || ''} ${entry.title || ''}`
    .toLowerCase()
    .replaceAll('-', ' ')
    .replaceAll('.', ' ')
    .replaceAll('__', ' ')
    .trim();
}

function getToolEntryIcon(entry: CodexTimelineEntry) {
  const identity = getToolIdentity(entry);

  if (identity.includes('thinking')) {
    return Brain;
  }

  if (identity.includes('exec command') || identity.includes('write stdin') || identity.includes('terminal')) {
    return Command;
  }

  if (identity.includes('apply patch') || identity.includes('patch') || identity.includes('file change')) {
    return SquarePen;
  }

  if (identity.includes('web search') || identity.includes('search query') || identity.includes('web open') || identity.includes('web find')) {
    return Eye;
  }

  if (
    identity.includes('parallel')
    || identity.includes('spawn agent')
    || identity.includes('send input')
    || identity.includes('wait agent')
    || identity.includes('resume agent')
    || identity.includes('close agent')
    || identity.includes('agent')
  ) {
    return Bot;
  }

  if (
    identity.includes('photoshop')
    || identity.includes('canva')
    || identity.includes('imagegen')
    || identity.includes('view image')
    || identity.includes('image to design')
    || identity.includes('generate design')
    || identity.includes('applyeffects')
    || identity.includes('applyadjustments')
    || identity.includes('instructedit')
  ) {
    return FileImage;
  }

  if (identity.includes('folder') || identity.includes('tree')) {
    return FolderTree;
  }

  if (identity.includes('file') || identity.includes('read') || identity.includes('fetch') || identity.includes('resource')) {
    return FileText;
  }

  if (identity.includes('plan') || identity.includes('request_user_input')) {
    return ListPlus;
  }

  if (identity.includes('undo') || identity.includes('retry')) {
    return RefreshCw;
  }

  return Wrench;
}

function getToolEntryTone(entry: CodexTimelineEntry) {
  const identity = getToolIdentity(entry);

  if (identity.includes('thinking')) {
    return {
      button: 'hover:border-fuchsia-200 hover:text-fuchsia-700',
      icon: 'bg-fuchsia-100 text-fuchsia-600 group-hover:bg-fuchsia-200',
    };
  }

  if (identity.includes('exec command') || identity.includes('write stdin') || identity.includes('terminal')) {
    return {
      button: 'hover:border-slate-200 hover:text-slate-700',
      icon: 'bg-slate-100 text-slate-600 group-hover:bg-slate-200',
    };
  }

  if (identity.includes('apply patch') || identity.includes('patch') || identity.includes('file change')) {
    return {
      button: 'hover:border-indigo-200 hover:text-indigo-700',
      icon: 'bg-indigo-100 text-indigo-600 group-hover:bg-indigo-200',
    };
  }

  if (identity.includes('web search') || identity.includes('search query') || identity.includes('web open') || identity.includes('web find')) {
    return {
      button: 'hover:border-cyan-200 hover:text-cyan-700',
      icon: 'bg-cyan-100 text-cyan-600 group-hover:bg-cyan-200',
    };
  }

  if (
    identity.includes('parallel')
    || identity.includes('spawn agent')
    || identity.includes('send input')
    || identity.includes('wait agent')
    || identity.includes('resume agent')
    || identity.includes('close agent')
    || identity.includes('agent')
  ) {
    return {
      button: 'hover:border-violet-200 hover:text-violet-700',
      icon: 'bg-violet-100 text-violet-600 group-hover:bg-violet-200',
    };
  }

  if (
    identity.includes('photoshop')
    || identity.includes('canva')
    || identity.includes('imagegen')
    || identity.includes('view image')
    || identity.includes('image to design')
    || identity.includes('generate design')
    || identity.includes('applyeffects')
    || identity.includes('applyadjustments')
    || identity.includes('instructedit')
  ) {
    return {
      button: 'hover:border-rose-200 hover:text-rose-700',
      icon: 'bg-rose-100 text-rose-600 group-hover:bg-rose-200',
    };
  }

  if (identity.includes('folder') || identity.includes('tree')) {
    return {
      button: 'hover:border-amber-200 hover:text-amber-700',
      icon: 'bg-amber-100 text-amber-700 group-hover:bg-amber-200',
    };
  }

  if (identity.includes('file') || identity.includes('read') || identity.includes('fetch') || identity.includes('resource')) {
    return {
      button: 'hover:border-emerald-200 hover:text-emerald-700',
      icon: 'bg-emerald-100 text-emerald-600 group-hover:bg-emerald-200',
    };
  }

  if (identity.includes('plan') || identity.includes('request user input')) {
    return {
      button: 'hover:border-sky-200 hover:text-sky-700',
      icon: 'bg-sky-100 text-sky-600 group-hover:bg-sky-200',
    };
  }

  if (identity.includes('undo') || identity.includes('retry')) {
    return {
      button: 'hover:border-orange-200 hover:text-orange-700',
      icon: 'bg-orange-100 text-orange-600 group-hover:bg-orange-200',
    };
  }

  return {
    button: 'hover:border-slate-200 hover:text-slate-700',
    icon: 'bg-slate-100 text-slate-500 group-hover:bg-slate-200',
  };
}

function ToolCard({
  entry,
  onOpen,
}: {
  entry: CodexTimelineEntry;
  onOpen: (entry: CodexTimelineEntry) => void;
}) {
  const Icon = getToolEntryIcon(entry);
  const tone = getToolEntryTone(entry);

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className={cn(
        'group flex w-full flex-col items-center justify-center gap-2 rounded-[1.25rem] border border-slate-100 bg-white px-2 py-3 text-center text-slate-500 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
        tone.button
      )}
      title={entry.title || entry.toolName || 'כלי'}
    >
      <div className={cn('flex h-10 w-10 items-center justify-center rounded-full transition-colors', tone.icon)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="line-clamp-1 text-[11px] font-medium text-slate-400">
        {trimText(entry.title || entry.toolName || 'כלי', 18)}
      </div>
    </button>
  );
}

function SessionChangeDetailViewer({
  record,
  activeFileId,
  onSelectFile,
}: {
  record: SessionChangeRecordResponse | null;
  activeFileId: string | null;
  onSelectFile: (fileId: string) => void;
}) {
  const selectedFile = record?.files.find((file) => file.id === activeFileId) || record?.files[0] || null;

  if (!record) {
    return (
      <div className="flex min-h-[16rem] items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50/80 px-6 text-center text-sm leading-7 text-slate-500">
        אין נתוני שינויים שמורים עבור התשובה הזאת.
        <br />
        זה קורה אם ההודעה נוצרה לפני שהמעקב הופעל, או אם הריצה לא תועדה עד הסוף.
      </div>
    );
  }

  if (record.files.length === 0) {
    return (
      <div className="flex min-h-[16rem] items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50/80 px-6 text-center text-sm leading-7 text-slate-500">
        הריצה לא שינתה קבצים בתוך ה־workspace המתועד של השיחה הזאת.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row-reverse">
      <div className="w-full shrink-0 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white md:w-72">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            קבצים ששונו
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">
              סה״כ {record.summary.totalFiles}
            </span>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700">
              +{record.summary.additions.toLocaleString('en-US')}
            </span>
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] text-rose-700">
              -{record.summary.deletions.toLocaleString('en-US')}
            </span>
          </div>
        </div>

        <div className="max-h-[28dvh] overflow-y-auto p-2 md:max-h-[56dvh]">
          <div className="space-y-2">
            {record.files.map((file) => {
              const isActive = selectedFile?.id === file.id;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onSelectFile(file.id)}
                  className={cn(
                    'flex w-full flex-col items-stretch gap-2 rounded-[1.2rem] border px-3 py-3 text-right transition-colors',
                    isActive
                      ? 'border-sky-200 bg-sky-50/80 shadow-[0_10px_22px_-18px_rgba(14,165,233,0.55)]'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={cn(
                      'rounded-full border px-2 py-1 text-[10px] font-semibold',
                      getSessionChangeStatusClasses(file.status),
                    )}>
                      {getSessionChangeStatusLabel(file.status)}
                    </span>
                    <span dir="ltr" className="text-[10px] font-semibold tabular-nums text-slate-400">
                      +{file.additions} / -{file.deletions}
                    </span>
                  </div>
                  <div className="min-w-0 text-sm font-medium leading-6 text-slate-700 [overflow-wrap:anywhere]">
                    {file.displayPath}
                  </div>
                  {file.previousPath && file.previousPath !== file.path && (
                    <div className="text-[11px] leading-5 text-slate-400 [overflow-wrap:anywhere]">
                      {file.previousPath} → {file.path}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {selectedFile ? (
          <div className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  Diff
                </div>
                <div dir="ltr" className="mt-1 truncate text-sm font-semibold text-slate-100">
                  {selectedFile.displayPath}
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-semibold text-slate-200">
                  DIFF
                </span>
                {selectedFile.isBinary && (
                  <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2.5 py-1 font-semibold text-amber-200">
                    BINARY
                  </span>
                )}
              </div>
            </div>
            {selectedFile.diffText ? (
              <CodexCodeBlock
                code={selectedFile.diffText}
                language="diff"
                className="max-h-[56dvh] overflow-x-auto overflow-y-auto rounded-none border-0 shadow-none"
              />
            ) : (
              <div className="px-4 py-6 text-sm text-slate-300">
                אין diff טקסטואלי להצגה עבור הקובץ הזה.
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-[16rem] items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50/80 px-6 text-center text-sm leading-7 text-slate-500">
            בחר קובץ כדי לראות את ה־diff המלא.
          </div>
        )}
      </div>
    </div>
  );
}

function ToolGroupCard({
  blockId,
  entries,
  expanded,
  onToggle,
  onOpen,
}: {
  blockId: string;
  entries: CodexTimelineEntry[];
  expanded: boolean;
  onToggle: (blockId: string) => void;
  onOpen: (entry: CodexTimelineEntry) => void;
}) {
  const count = entries.length;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onToggle(blockId)}
        dir="rtl"
        className="flex w-full items-center justify-between gap-3 rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-right shadow-sm transition-colors hover:bg-slate-50"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-700">
            {`הופעלו ${count} כלים`}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">
            לחץ לפתיחת הפירוט
          </div>
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </div>
      </button>
      {expanded && (
        <div className="grid grid-cols-4 gap-2">
          {entries.map((entry) => (
            <ToolCard key={entry.id} entry={entry} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueSummaryButton({
  count,
  statusSummary,
  collapsed,
  onToggle,
  attached = false,
}: {
  count: number;
  statusSummary: Array<{ status: CodexQueueServerItem['status']; count: number; label: string }>;
  collapsed: boolean;
  onToggle: () => void;
  attached?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      dir="rtl"
      className={cn(
        'flex w-full items-center justify-between gap-3 border border-slate-200/80 bg-white px-4 py-3 text-right shadow-[0_2px_15px_rgba(0,0,0,0.02)] transition-colors hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800/70',
        attached ? 'rounded-[2rem] rounded-b-none border-b-0' : 'rounded-[2rem]'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            כל המשימות בתור
          </div>
          <span
            dir="ltr"
            className="inline-flex min-w-8 items-center justify-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {count}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {statusSummary.map((entry) => (
            <span
              key={entry.status}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <span>{entry.label}</span>
              <span dir="ltr" className="font-semibold tabular-nums text-slate-800 dark:text-slate-50">
                {entry.count}
              </span>
            </span>
          ))}
        </div>
      </div>
      <ChevronDown
        className={cn(
          'h-4 w-4 shrink-0 text-slate-500 transition-transform dark:text-slate-300',
          !collapsed && 'rotate-180'
        )}
      />
    </button>
  );
}

function MessageBubble({
  entry,
  onOpenFilePreview,
  onOpenChanges,
  onFork,
  onDelete,
  onTransfer,
  transferOptions,
  isTransfering = false,
  isChangeLoading = false,
  isDeleting = false,
  assistantLabel = 'Codex',
  commentaryLabel = 'Codex עובד',
}: {
  entry: CodexTimelineEntry;
  onOpenFilePreview: (rawPath: string) => void;
  onOpenChanges?: (entryId: string) => void;
  onFork?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onTransfer?: (entryId: string, targetProfileId: string) => void;
  transferOptions?: TransferTargetOption[];
  isTransfering?: boolean;
  isChangeLoading?: boolean;
  isDeleting?: boolean;
  assistantLabel?: string;
  commentaryLabel?: string;
}) {
  const [isTransferMenuOpen, setIsTransferMenuOpen] = useState(false);
  const isUser = entry.role === 'user';
  const isCommentary = entry.kind === 'commentary';
  const isTransfer = entry.kind === 'transfer';
  const senderLabel = isTransfer ? 'העברה' : isUser ? 'אתה' : isCommentary ? commentaryLabel : assistantLabel;
  const messageText = entry.text || '';
  const showChangesAction = Boolean(onOpenChanges) && !isUser && !isCommentary && !isTransfer && entry.kind === 'final';
  const showForkAction = Boolean(onFork) && !isTransfer;
  const showDeleteAction = Boolean(onDelete) && (isUser || (!isCommentary && !isTransfer && entry.kind === 'final'));
  const showTransferAction = Boolean(onTransfer && transferOptions?.length) && !isTransfer;
  const hasMultipleTransferTargets = (transferOptions?.length || 0) > 1;

  return (
    <div className="flex w-full">
      <div className={cn('flex w-full items-end gap-2', isUser ? 'flex-row' : 'flex-row-reverse')}>
        {isUser && (
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 shadow-sm transition-all"
          >
            <User className="h-4 w-4" />
          </div>
        )}

        <div
          className={cn(
            'relative flex min-w-0 max-w-none flex-col gap-1 rounded-[1.25rem] px-4 py-3 text-[15px] leading-relaxed shadow-sm',
            isTransfer ? 'max-w-[min(100%,42rem)] flex-none' : isUser ? 'flex-1' : 'w-full',
            isUser
              ? 'rounded-tr-sm border border-indigo-100/50 bg-gradient-to-br from-indigo-50 to-blue-50 text-indigo-950 dark:border-indigo-800/70 dark:from-indigo-950/70 dark:to-slate-900 dark:text-indigo-100'
              : isTransfer
                ? 'rounded-tl-sm border border-orange-200/80 bg-gradient-to-br from-orange-50 to-amber-50 text-slate-700 shadow-[0_10px_24px_rgba(251,146,60,0.10)]'
              : isCommentary
                ? 'rounded-tl-sm border border-cyan-100 bg-cyan-50/60 text-slate-700'
                : 'rounded-tl-sm border border-slate-100/80 bg-white text-slate-700'
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-[10px] font-medium">
            <span className={cn(
              isUser
                ? 'text-indigo-500/80 dark:text-indigo-200/90'
                : isTransfer
                  ? 'text-orange-500/90'
                  : 'text-slate-400'
            )}>{senderLabel}</span>
            <span className={cn(
              isUser
                ? 'text-indigo-400/70 dark:text-indigo-300/75'
                : isTransfer
                  ? 'text-orange-400/80'
                  : 'text-slate-400'
            )}>
              {formatTimestamp(entry.timestamp)}
            </span>
          </div>
          <MessageMarkdown text={messageText} isUser={isUser} onOpenFilePreview={onOpenFilePreview} />
          <div className="mt-2 flex items-center justify-end gap-1">
            <CopyButton
              text={messageText}
              ariaLabel="העתק הודעה"
              className={cn(
                'h-7 w-7 border-0 text-[10px]',
                isUser
                  ? 'bg-white/20 text-indigo-700 hover:bg-white/30 dark:bg-slate-800/60 dark:text-indigo-100 dark:hover:bg-slate-700/80'
                  : isTransfer
                    ? 'bg-white/70 text-orange-500 hover:bg-white'
                    : 'bg-slate-50'
              )}
            />
            {showChangesAction && (
              <button
                type="button"
                onClick={() => onOpenChanges?.(entry.id)}
                disabled={isChangeLoading}
                className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  isUser ? 'bg-white/20 text-indigo-700 hover:bg-white/30 dark:bg-slate-800/60 dark:text-indigo-100 dark:hover:bg-slate-700/80' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                )}
                title="קבצים שהשיחה שינתה"
                aria-label="קבצים שהשיחה שינתה"
              >
                {isChangeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDiff className="h-3.5 w-3.5" />}
              </button>
            )}
            {showForkAction && (
              <button
                type="button"
                onClick={() => onFork?.(entry.id)}
                className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[10px] transition-colors',
                  isUser ? 'bg-white/20 text-indigo-700 hover:bg-white/30 dark:bg-slate-800/60 dark:text-indigo-100 dark:hover:bg-slate-700/80' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                )}
                title="מזלג מהודעה זו"
                aria-label="מזלג מהודעה זו"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            )}
            {showDeleteAction && (
              <button
                type="button"
                onClick={() => onDelete?.(entry.id)}
                disabled={isDeleting}
                className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  isUser ? 'bg-white/20 text-indigo-700 hover:bg-white/30 dark:bg-slate-800/60 dark:text-indigo-100 dark:hover:bg-slate-700/80' : 'bg-slate-50 text-rose-500 hover:bg-rose-50'
                )}
                title="מחק את זוג ההודעות הזה"
                aria-label="מחק את זוג ההודעות הזה"
              >
                {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            )}
            {showTransferAction && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (!transferOptions?.length) {
                      return;
                    }

                    if (transferOptions.length === 1) {
                      onTransfer?.(entry.id, transferOptions[0].profileId);
                      return;
                    }

                    setIsTransferMenuOpen((current) => !current);
                  }}
                  disabled={isTransfering}
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    isUser ? 'bg-white/20 text-indigo-700 hover:bg-white/30 dark:bg-slate-800/60 dark:text-indigo-100 dark:hover:bg-slate-700/80' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                  )}
                  title={transferOptions?.length === 1 ? `העבר ל-${transferOptions[0].label}` : 'העבר לספק אחר'}
                  aria-label={transferOptions?.length === 1 ? `העבר ל-${transferOptions[0].label}` : 'העבר לספק אחר'}
                >
                  {isTransfering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Repeat className="h-3.5 w-3.5" />}
                </button>
                {hasMultipleTransferTargets && isTransferMenuOpen && (
                  <div
                    dir="rtl"
                    className="absolute bottom-full right-0 z-10 mb-2 w-44 max-w-[calc(100vw-2.5rem)] rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_16px_35px_-24px_rgba(15,23,42,0.24)]"
                  >
                    <div className="mb-1 px-2 text-right text-[10px] font-semibold tracking-[0.16em] text-slate-400">
                      העבר ל
                    </div>
                    <div className="space-y-1">
                      {transferOptions?.map((option) => (
                        <button
                          key={option.profileId}
                          type="button"
                          onClick={() => {
                            setIsTransferMenuOpen(false);
                            onTransfer?.(entry.id, option.profileId);
                          }}
                          className="flex w-full items-center justify-start gap-2 rounded-xl px-3 py-2 text-right text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <Repeat className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                          <span className="min-w-0 flex-1 truncate text-right">{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function QueueItemCard({
  item,
  onCancel,
  onDelete,
  onEdit,
  onRetry,
}: {
  item: CodexQueueServerItem;
  onCancel: (itemId: string) => void;
  onDelete: (itemId: string) => void;
  onEdit: (item: CodexQueueServerItem) => void;
  onRetry: (itemId: string) => void;
}) {
  const attachmentText = item.attachments.length > 0
    ? `${item.attachments.length} קבצים`
    : 'ללא קבצים';
  const isRecurring = item.scheduleMode === 'recurring';
  const scheduleText = isRecurring
    ? `הפעלה הבאה ${formatTimestamp(item.scheduledAt)}`
    : item.status === 'scheduled'
      ? `מיועד ל-${formatTimestamp(item.scheduledAt)}`
      : item.startedAt
        ? `התחיל ב-${formatTimestamp(item.startedAt)}`
        : `נוצר ב-${formatTimestamp(item.createdAt)}`;

  return (
    <div dir="rtl" className="rounded-[1.25rem] border border-slate-100 bg-white px-4 py-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={cn('rounded-full px-3 py-1 text-[11px] font-medium', getQueueStatusClass(item.status))}>
          {getQueueStatusLabel(item.status)}
        </Badge>
        {isRecurring && (
          <Badge className="rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-[11px] font-medium text-indigo-700">
            <Repeat className="ml-1 h-3.5 w-3.5" />
            {getRecurringFrequencyLabel(item.recurringFrequency)}
          </Badge>
        )}
        <span className="text-[11px] text-slate-400">{scheduleText}</span>
      </div>

      <div className="mt-3 text-sm font-medium leading-7 text-slate-800">
        {item.promptPreview || 'קבצים בלבד'}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span>{attachmentText}</span>
        <span>•</span>
        <span>ניסיון {item.attempts}</span>
        {isRecurring && item.lastRunAt && (
          <>
            <span>•</span>
            <span>
              ריצה אחרונה {formatTimestamp(item.lastRunAt)}
              {item.lastRunStatus === 'failed' ? ' · נכשלה' : item.lastRunStatus === 'completed' ? ' · הושלמה' : ''}
            </span>
          </>
        )}
        {item.sessionId && (
          <>
            <span>•</span>
            <span dir="ltr">{item.sessionId}</span>
          </>
        )}
      </div>

        {item.error && (
        <div className="mt-3 rounded-[16px] border border-red-100 bg-red-50/70 px-3 py-2 text-xs leading-6 text-red-700">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-medium">שגיאה אחרונה</div>
            <CopyButton text={item.error} ariaLabel="העתק שגיאה" className="h-7 w-7 border-red-100 bg-white/80 text-[10px] text-red-700" />
          </div>
          {item.error}
        </div>
      )}

      {item.finalMessage && (
        <div className="mt-3 rounded-[16px] border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs leading-6 text-emerald-800">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-medium">פלט אחרון</div>
            <CopyButton text={item.finalMessage} ariaLabel="העתק פלט" className="h-7 w-7 border-emerald-100 bg-white/80 text-[10px] text-emerald-700" />
          </div>
          {trimText(item.finalMessage, 180)}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton
          text={[
            item.promptPreview || item.prompt || 'קבצים בלבד',
            item.finalMessage || '',
            item.error || '',
          ].filter(Boolean).join('\n\n')}
          ariaLabel="העתק משימה"
          className="h-9 w-9 rounded-[16px] text-xs"
        />
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Button
            variant="outline"
            className="h-9 rounded-[16px] border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
            onClick={() => onEdit(item)}
          >
            ערוך
          </Button>
        )}
        {(item.status === 'running' || item.status === 'cancelling') && (
          <Button
            variant="outline"
            className="h-9 rounded-[16px] border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50"
            onClick={() => onCancel(item.id)}
            disabled={item.status === 'cancelling'}
          >
            {item.status === 'cancelling' ? 'עוצר...' : 'עצור'}
          </Button>
        )}
        {(item.status === 'scheduled' || item.status === 'queued') && (
          <Button
            variant="outline"
            className="h-9 rounded-[16px] border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
            onClick={() => onCancel(item.id)}
          >
            בטל
          </Button>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Button
            variant="outline"
            className="h-9 rounded-[16px] border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
            onClick={() => onRetry(item.id)}
          >
            נסה שוב
          </Button>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Button
            variant="outline"
            className="h-9 rounded-[16px] border-red-200 bg-white text-xs text-red-700 hover:bg-red-50"
            onClick={() => onDelete(item.id)}
          >
            מחק
          </Button>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  session,
  isSelected,
  isActive,
  isArchivedView,
  onSelect,
  onManageTopic,
  onToggleHidden,
  isPreviewOpen,
  onPreviewOpen,
  onPreviewClose,
}: {
  session: CodexSessionSummary;
  isSelected: boolean;
  isActive: boolean;
  isArchivedView: boolean;
  onSelect: () => void;
  onManageTopic: () => void;
  onToggleHidden: (hidden: boolean) => void;
  isPreviewOpen: boolean;
  onPreviewOpen: (sessionId: string) => void;
  onPreviewClose: () => void;
}) {
  const pressTimerRef = useRef<number | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => () => {
    if (pressTimerRef.current) {
      window.clearTimeout(pressTimerRef.current);
    }
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
    }
  }, []);

  function clearPressTimer() {
    if (pressTimerRef.current) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }

  function schedulePreview() {
    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      onPreviewOpen(session.id);
      if (previewTimerRef.current) {
        window.clearTimeout(previewTimerRef.current);
      }
      previewTimerRef.current = window.setTimeout(() => {
        onPreviewClose();
      }, 3200);
    }, 420);
  }

  const topicColors = session.topic ? getTopicColorPreset(session.topic.colorKey) : null;

  return (
    <div className="relative">
      <button
        type="button"
        dir="rtl"
        onPointerDown={schedulePreview}
        onPointerUp={clearPressTimer}
        onPointerLeave={clearPressTimer}
        onPointerCancel={clearPressTimer}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onSelect();
        }}
        className={cn(
          'w-full rounded-2xl px-3 py-3 text-right transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200',
          isSelected
            ? 'bg-indigo-50/60 opacity-100'
            : 'bg-transparent opacity-80 hover:bg-slate-50 hover:opacity-100'
        )}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="line-clamp-1 text-sm font-medium leading-6 text-slate-700">
                {getSessionDisplayTitle(session)}
            </div>
            {session.topic && topicColors && (
              <div className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]" style={{
                backgroundColor: topicColors.bg,
                color: topicColors.text,
                borderColor: topicColors.border,
              }}>
                <span className="truncate">{session.topic.name}</span>
                <span>{session.topic.icon}</span>
              </div>
            )}
            <div className="mt-1 text-[11px] text-slate-400">
              {formatTimestamp(session.updatedAt)}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-1.5">
            {isActive && (
              <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </div>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onManageTopic();
              }}
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title="נהל נושא"
            >
              <Tag className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleHidden(!session.hidden);
              }}
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title={isArchivedView ? 'החזר לרשימה' : 'הסתר שיחה'}
            >
              {isArchivedView ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </button>

      {isPreviewOpen && (
        <div className="pointer-events-none absolute inset-x-2 top-full z-20 mt-2 rounded-2xl border border-slate-100 bg-white/95 p-4 text-right shadow-[0_18px_45px_-24px_rgba(15,23,42,0.25)] backdrop-blur">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            תצוגה מהירה
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-700">{session.title}</div>
          <div className="mt-3 text-[11px] font-medium text-slate-400">תחילת השיחה</div>
          <div className="mt-1 text-sm leading-6 text-slate-600">{trimText(session.startPreview, 160)}</div>
          <div className="mt-3 text-[11px] font-medium text-slate-400">סוף השיחה</div>
          <div className="mt-1 text-sm leading-6 text-slate-600">{trimText(session.endPreview, 160)}</div>
        </div>
      )}
    </div>
  );
}

function SidebarPanel({
  profiles,
  profileId,
  selectedProvider,
  selectedProfile,
  workspaceMode,
  search,
  sessions,
  groupedSessions,
  activeSessionIds,
  installMode,
  showArchived,
  selectedSessionId,
  isRefreshing,
  onClose,
  onProviderChange,
  onProfileChange,
  onSearchChange,
  onRefresh,
  onInstallApp,
  isLoggingOut,
  onLogout,
  onNewConversation,
  onChooseFolder,
  onToggleWorkspaceMode,
  onManageTopic,
  onToggleArchived,
  onToggleSessionHidden,
  onSelectSession,
  themeMode,
  onThemeModeChange,
}: {
  profiles: CodexProfile[];
  profileId: string;
  selectedProvider: CodexProfile['provider'];
  selectedProfile: CodexProfile | null;
  workspaceMode: WorkspaceMode;
  search: string;
  sessions: CodexSessionSummary[];
  groupedSessions: SessionFolderGroup[];
  activeSessionIds: Set<string>;
  installMode: 'installed' | 'ready' | 'manual';
  showArchived: boolean;
  selectedSessionId: string | null;
  isRefreshing: boolean;
  onClose?: () => void;
  onProviderChange: (value: CodexProfile['provider']) => void;
  onProfileChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onInstallApp: () => void;
  isLoggingOut: boolean;
  onLogout: () => void;
  onNewConversation: (cwd?: string | null) => void;
  onChooseFolder: () => void;
  onToggleWorkspaceMode: () => void;
  onManageTopic: (session: CodexSessionSummary) => void;
  onToggleArchived: () => void;
  onToggleSessionHidden: (sessionId: string, hidden: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  const collapsedFoldersStorageKey = `${SIDEBAR_COLLAPSED_FOLDERS_STORAGE_PREFIX}:${profileId}`;
  const collapsedTopicsStorageKey = `${SIDEBAR_COLLAPSED_TOPICS_STORAGE_PREFIX}:${profileId}`;
  const providerOptions = PROVIDER_DISPLAY_ORDER.filter((provider) => profiles.some((profile) => profile.provider === provider));
  const providerProfiles = profiles.filter((profile) => profile.provider === selectedProvider);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>(() => readBooleanMapFromStorage(collapsedFoldersStorageKey));
  const [collapsedTopics, setCollapsedTopics] = useState<Record<string, boolean>>(() => readBooleanMapFromStorage(collapsedTopicsStorageKey));

  useEffect(() => {
    setCollapsedFolders(readBooleanMapFromStorage(collapsedFoldersStorageKey));
  }, [collapsedFoldersStorageKey]);

  useEffect(() => {
    setCollapsedTopics(readBooleanMapFromStorage(collapsedTopicsStorageKey));
  }, [collapsedTopicsStorageKey]);

  useEffect(() => {
    writeBooleanMapToStorage(collapsedFoldersStorageKey, collapsedFolders);
  }, [collapsedFolders, collapsedFoldersStorageKey]);

  useEffect(() => {
    writeBooleanMapToStorage(collapsedTopicsStorageKey, collapsedTopics);
  }, [collapsedTopics, collapsedTopicsStorageKey]);

  return (
    <div dir="rtl" className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <div className="shrink-0 border-b border-slate-100 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">היסטוריית שיחות</h2>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-2 p-4">
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => onNewConversation()}
              className="flex min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-2xl bg-indigo-50/50 px-2 py-3 text-center text-[12px] font-medium leading-4 text-indigo-700 transition-colors active:scale-95"
            >
              <SquarePen className="h-4 w-4 shrink-0" />
              <span className="line-clamp-2 min-w-0">שיחה חדשה</span>
            </button>

            <button
              onClick={onChooseFolder}
              className="flex min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-2xl border border-slate-200 bg-white px-2 py-3 text-center text-[12px] font-medium leading-4 text-slate-700 transition-colors hover:bg-slate-50 active:scale-95"
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="line-clamp-2 min-w-0">בחר תיקייה</span>
            </button>

            <button
              onClick={onToggleArchived}
              className={cn(
                'flex min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-2xl border px-2 py-3 text-center text-[12px] font-medium leading-4 transition-colors active:scale-95',
                showArchived
                  ? 'border-slate-200 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              )}
            >
              <Archive className="h-4 w-4 shrink-0" />
              <span className="line-clamp-2 min-w-0">{showArchived ? 'חזור לשיחות' : 'ארכיון'}</span>
            </button>

            <button
              onClick={onToggleWorkspaceMode}
              className={cn(
                'flex min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-2xl border px-2 py-3 text-center text-[12px] font-medium leading-4 transition-colors active:scale-95',
                workspaceMode === 'support'
                  ? 'border-cyan-200 bg-cyan-50 text-cyan-700'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              )}
            >
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span className="line-clamp-2 min-w-0">{workspaceMode === 'support' ? 'חזור רגיל' : 'מצב תמיכה'}</span>
            </button>
          </div>

          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="חפש שיחה או תיקייה"
            className="block w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-right text-sm text-slate-700 outline-none transition focus:border-indigo-300"
          />

          <div className="mt-4 flex flex-col gap-2">
            <span className="block w-full px-2 text-right text-xs font-semibold tracking-wide text-slate-400">
              {showArchived ? 'שיחות מוסתרות' : 'קודם לכן'}
            </span>
            {isRefreshing && sessions.length === 0 ? (
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-sm leading-7 text-slate-500">
                טוען שיחות...
              </div>
            ) : groupedSessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm leading-7 text-slate-500">
                {showArchived ? 'אין שיחות מוסתרות.' : 'עדיין אין שיחות להצגה.'}
              </div>
            ) : (
              groupedSessions.map((group) => (
                <div key={group.key} className="rounded-[1.4rem] border border-slate-100 bg-slate-50/45 p-2">
                  <div className="flex min-w-0 items-start gap-3 px-2 py-2">
                    <button
                      type="button"
                      onClick={() => setCollapsedFolders((current) => {
                        const next = { ...current };
                        if (next[group.key]) {
                          delete next[group.key];
                        } else {
                          next[group.key] = true;
                        }
                        return next;
                      })}
                      className="flex min-w-0 flex-1 items-start justify-start gap-3 overflow-hidden text-right"
                    >
                      <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform', collapsedFolders[group.key] && 'rotate-90')} />
                      <Folder className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0 flex-1 text-right">
                        <div className="truncate text-sm font-semibold text-slate-700">{group.label}</div>
                        {group.pathLabel && (
                          <div className="mt-1 truncate text-[11px] text-slate-400" dir="ltr" title={group.cwd || undefined}>
                            {group.pathLabel}
                          </div>
                        )}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onNewConversation(group.cwd)}
                      className="shrink-0 rounded-full bg-white p-2 text-slate-400 shadow-sm transition-colors hover:text-indigo-600"
                      title="שיחה חדשה בתיקייה הזו"
                    >
                      <SquarePen className="h-4 w-4" />
                    </button>
                  </div>

                  {!collapsedFolders[group.key] && (
                    <div className="mr-3 space-y-3 border-r border-slate-100/80 pr-3">
                    {buildSessionTopicGroups(group.sessions).map((topicGroup) => {
                      const topicColors = topicGroup.topic ? getTopicColorPreset(topicGroup.topic.colorKey) : null;
                      const topicCollapseKey = `${group.key}:${topicGroup.key}`;
                      return (
                        <div key={topicGroup.key} className="space-y-1">
                          <button
                            type="button"
                            onClick={() => setCollapsedTopics((current) => {
                              const next = { ...current };
                              if (next[topicCollapseKey]) {
                                delete next[topicCollapseKey];
                              } else {
                                next[topicCollapseKey] = true;
                              }
                              return next;
                            })}
                            className="flex w-full min-w-0 items-center justify-start gap-2 px-1 pt-1 text-right"
                          >
                            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', collapsedTopics[topicCollapseKey] && 'rotate-90')} />
                            <div
                              className="inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                              style={topicGroup.topic && topicColors
                                ? {
                                  backgroundColor: topicColors.bg,
                                  color: topicColors.text,
                                  borderColor: topicColors.border,
                              }
                                : undefined}
                            >
                              <span>{topicGroup.topic?.icon || '•'}</span>
                              <span className="truncate">{topicGroup.label}</span>
                            </div>
                          </button>
                          {!collapsedTopics[topicCollapseKey] && (
                            <div className="mr-3 space-y-2 border-r border-slate-100/70 pr-3">
                              {topicGroup.sessions.map((session) => (
                              <SessionCard
                                key={session.id}
                                session={session}
                                isSelected={selectedSessionId === session.id}
                                isActive={activeSessionIds.has(session.id)}
                                isArchivedView={showArchived}
                                onSelect={() => onSelectSession(session.id)}
                                onManageTopic={() => onManageTopic(session)}
                                onToggleHidden={(hidden) => onToggleSessionHidden(session.id, hidden)}
                                isPreviewOpen={previewSessionId === session.id}
                                onPreviewOpen={setPreviewSessionId}
                                onPreviewClose={() => setPreviewSessionId((current) => current === session.id ? null : current)}
                              />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-slate-100 p-4">
        {isSettingsOpen && (
          <div className="mb-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-right">
            <div className="text-[11px] font-semibold tracking-[0.18em] text-slate-500">
              שירות
            </div>
            <div className={cn('mt-2 grid gap-2', providerOptions.length >= 3 ? 'grid-cols-3' : 'grid-cols-2')}>
              {providerOptions.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => onProviderChange(provider)}
                  className={cn(
                    'rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
                    selectedProvider === provider
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  )}
                >
                  {getProviderDisplayLabel(provider)}
                </button>
              ))}
            </div>
            <div className="text-[11px] font-semibold tracking-[0.18em] text-slate-500">
              פרופיל
            </div>
            <select
              value={profileId}
              onChange={(event) => onProfileChange(event.target.value)}
              className="mt-2 w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-3 text-right text-sm text-slate-700 outline-none transition focus:border-indigo-300"
            >
              {providerProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
              <button
                onClick={onRefresh}
                disabled={isRefreshing}
                className="mt-3 flex w-full items-center justify-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-sm text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-60"
              >
                רענן שיחות
                <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </button>
              <button
                onClick={onInstallApp}
                disabled={installMode === 'installed'}
                className="mt-3 flex w-full items-center justify-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-right text-sm text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-default disabled:opacity-60"
              >
                {installMode === 'installed'
                ? 'מותקן במסך הבית'
                : installMode === 'ready'
                  ? 'התקן בטלפון'
                  : 'איך מתקינים'}
                <Download className="h-4 w-4" />
            </button>
            <div className="mt-2 text-xs leading-6 text-slate-400">
              {installMode === 'installed'
                ? 'האפליקציה כבר מותקנת ותיפתח במסך מלא מהטלפון.'
                : installMode === 'ready'
                  ? 'הדפדפן מוכן ל־native install מתוך המסך הזה.'
                  : 'אם אין prompt אוטומטי, נציג הוראות Add to Home Screen.'}
            </div>
            <div className="mt-4 text-[11px] font-semibold tracking-[0.18em] text-slate-500">
              ערכת נושא
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onThemeModeChange('light')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
                  themeMode === 'light'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                )}
              >
                בהיר
                <Sun className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onThemeModeChange('dark')}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
                  themeMode === 'dark'
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                )}
              >
                כהה
                <Moon className="h-4 w-4" />
              </button>
            </div>
            {selectedProfile && (
              <div className="mt-2 truncate text-[11px] text-slate-400" dir="ltr" title={selectedProfile.workspaceCwd}>
                {selectedProfile.workspaceCwd}
              </div>
            )}

            <button
              type="button"
              onClick={onLogout}
              disabled={isLoggingOut}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50/80 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-60"
            >
              {isLoggingOut ? 'מתנתק...' : 'התנתק'}
              {isLoggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            </button>
          </div>
        )}

        <button
          onClick={() => setIsSettingsOpen((current) => !current)}
          className="flex w-full items-center justify-center gap-3 overflow-hidden rounded-2xl p-3 text-center text-slate-600 transition-colors hover:bg-slate-50"
        >
          <Settings2 className="h-5 w-5 shrink-0" />
          <span className="min-w-0 truncate text-sm font-medium">הגדרות חשבון</span>
        </button>
      </div>
    </div>
  );
}

function FolderPickerDialog({
  browser,
  isLoading,
  error,
  pathValue,
  canGoBack,
  canGoForward,
  onClose,
  onPathChange,
  onOpenPath,
  onNavigateBack,
  onNavigateForward,
  onNavigateTo,
  onSelectCurrent,
}: {
  browser: CodexFolderBrowseResult | null;
  isLoading: boolean;
  error: string | null;
  pathValue: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onClose: () => void;
  onPathChange: (value: string) => void;
  onOpenPath: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onNavigateTo: (path: string) => void;
  onSelectCurrent: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close folder picker"
      />
      <div className="relative z-10 flex w-full max-w-2xl max-h-[82dvh] flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <FolderOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Folder Picker
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">
                בחר תיקייה לשיחה חדשה
              </div>
              {browser && (
                <div className="mt-1 truncate text-xs text-slate-500" dir="ltr" title={browser.currentPath}>
                  {browser.currentPath}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
          <div className="flex min-w-full items-center gap-2">
            <input
              type="text"
              value={pathValue}
              onChange={(event) => onPathChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onOpenPath();
                }
              }}
              placeholder="/root/projects או C:\\repo"
              dir="ltr"
              className="h-10 flex-1 rounded-full border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-slate-300"
            />
            <button
              type="button"
              onClick={onOpenPath}
              className="shrink-0 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              פתח נתיב
            </button>
          </div>
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canGoBack}
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition disabled:opacity-40"
            title="אחורה"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canGoForward}
            className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition disabled:opacity-40"
            title="קדימה"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {browser?.parentPath && (
            <button
              type="button"
              onClick={() => onNavigateTo(browser.parentPath!)}
              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 transition hover:bg-slate-50"
              title="תיקיית אב"
            >
              למעלה
            </button>
          )}
          {browser?.rootPath && browser.currentPath !== browser.rootPath && (
            <button
              type="button"
              onClick={() => onNavigateTo(browser.rootPath)}
              className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 transition hover:bg-slate-50"
              title="חזור ל-root"
            >
              root
            </button>
          )}
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex items-center gap-2">
              {browser?.breadcrumbs.map((crumb) => (
                <button
                  key={crumb.path}
                  type="button"
                  onClick={() => onNavigateTo(crumb.path)}
                  className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-200"
                >
                  {crumb.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-b border-slate-100 px-5 py-3">
          <div className="flex flex-wrap gap-2">
            {browser?.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => onNavigateTo(root.path)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs transition',
                  browser.rootPath === root.path
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                )}
              >
                {root.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {isLoading ? (
            <div className="flex min-h-[260px] items-center justify-center rounded-[1.5rem] border border-slate-100 bg-slate-50/70 text-sm text-slate-500">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>טוען תיקיות...</span>
              </div>
            </div>
          ) : error ? (
            <div className="rounded-[1.5rem] border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
              {error}
            </div>
          ) : browser ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={onSelectCurrent}
                className="flex w-full items-center justify-between gap-3 rounded-[1.5rem] border border-indigo-100 bg-indigo-50/60 px-4 py-4 text-right"
              >
                <div>
                  <div className="text-sm font-semibold text-indigo-700">בחר את התיקייה הנוכחית</div>
                  <div className="mt-1 text-xs text-indigo-500" dir="ltr">
                    {browser.currentPath}
                  </div>
                </div>
                <FolderOpen className="h-5 w-5 text-indigo-500" />
              </button>

              {browser.entries.length === 0 ? (
                <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  אין תתי־תיקיות להצגה כאן.
                </div>
              ) : (
                browser.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => onNavigateTo(entry.path)}
                    className="flex w-full items-center justify-between gap-3 rounded-[1.25rem] border border-slate-100 bg-white px-4 py-4 text-right shadow-sm transition-colors hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{entry.name}</div>
                      <div className="mt-1 truncate text-xs text-slate-500" dir="ltr" title={entry.path}>
                        {entry.path}
                      </div>
                    </div>
                    <ChevronLeft className="h-4 w-4 shrink-0 text-slate-400" />
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const VOXEL_GAME_WIDTH = 360;
const VOXEL_GAME_HEIGHT = 520;

type VoxelTouchTarget = {
  x: number;
  y: number;
  active: boolean;
};

type VoxelBlock = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type VoxelEnemy = {
  x: number;
  y: number;
  size: number;
  speed: number;
  hue: number;
  hp: number;
};

type VoxelBullet = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
};

type VoxelParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  hue: number;
};

type VoxelRing = {
  x: number;
  y: number;
  radius: number;
  vy: number;
  drift: number;
  hue: number;
  spin: number;
};

type VoxelGameState = {
  player: {
    x: number;
    y: number;
    size: number;
    speed: number;
    health: number;
    ammo: number;
    maxAmmo: number;
    shootCooldown: number;
  };
  blocks: VoxelBlock[];
  enemies: VoxelEnemy[];
  bullets: VoxelBullet[];
  particles: VoxelParticle[];
  rings: VoxelRing[];
  kills: number;
  score: number;
  combo: number;
  boost: number;
  wave: number;
  spawnTimer: number;
  ringTimer: number;
  nextSpawnDelay: number;
  shake: number;
  time: number;
};

function createVoxelBlocks(): VoxelBlock[] {
  return [];
}

function createVoxelGameState(): VoxelGameState {
  return {
    player: {
      x: VOXEL_GAME_WIDTH / 2,
      y: VOXEL_GAME_HEIGHT / 2,
      size: 16,
      speed: 260,
      health: 100,
      ammo: 12,
      maxAmmo: 18,
      shootCooldown: 0,
    },
    blocks: createVoxelBlocks(),
    enemies: [],
    bullets: [],
    particles: [],
    rings: [],
    kills: 0,
    score: 0,
    combo: 0,
    boost: 0,
    wave: 1,
    spawnTimer: 0,
    ringTimer: 0,
    nextSpawnDelay: 0.85,
    shake: 0,
    time: 0,
  };
}

function intersectsBlock(x: number, y: number, size: number, blocks: VoxelBlock[]): boolean {
  return blocks.some((block) => (
    x + size > block.x
    && x - size < block.x + block.w
    && y + size > block.y
    && y - size < block.y + block.h
  ));
}

function spawnVoxelEnemy(state: VoxelGameState) {
  const side = Math.floor(Math.random() * 4);
  const margin = 18;
  let x = margin;
  let y = margin;

  if (side === 0) {
    x = Math.random() * VOXEL_GAME_WIDTH;
    y = -margin;
  } else if (side === 1) {
    x = VOXEL_GAME_WIDTH + margin;
    y = Math.random() * VOXEL_GAME_HEIGHT;
  } else if (side === 2) {
    x = Math.random() * VOXEL_GAME_WIDTH;
    y = VOXEL_GAME_HEIGHT + margin;
  } else {
    x = -margin;
    y = Math.random() * VOXEL_GAME_HEIGHT;
  }

  state.enemies.push({
    x,
    y,
    size: 13 + Math.random() * 4,
    speed: 34 + state.wave * 7 + Math.random() * 10,
    hue: 205 + Math.random() * 70,
    hp: 1 + Math.floor(state.wave / 4),
  });
}

function spawnVoxelBurst(state: VoxelGameState, x: number, y: number, hue: number, count = 12) {
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.55;
    const speed = 40 + Math.random() * 110;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.4 + Math.random() * 0.45,
      size: 2 + Math.random() * 4,
      hue,
    });
  }
}

function spawnSkyRing(state: VoxelGameState) {
  state.rings.push({
    x: 48 + Math.random() * (VOXEL_GAME_WIDTH - 96),
    y: -30,
    radius: 14 + Math.random() * 8,
    vy: 70 + Math.random() * 45,
    drift: (Math.random() - 0.5) * 26,
    hue: 180 + Math.random() * 140,
    spin: Math.random() * Math.PI * 2,
  });
}

function updateVoxelGame(state: VoxelGameState, _touchTarget: VoxelTouchTarget, dt: number) {
  state.time += dt;
  state.player.shootCooldown = Math.max(0, state.player.shootCooldown - dt);
  state.shake = Math.max(0, state.shake - dt * 4);
  state.boost = Math.max(0, state.boost - dt * 3.2);

  const primaryTarget = [...state.enemies]
    .sort((left, right) => (
      Math.hypot(left.x - state.player.x, left.y - state.player.y)
      - Math.hypot(right.x - state.player.x, right.y - state.player.y)
    ))[0];

  if (primaryTarget && state.player.shootCooldown <= 0 && state.player.ammo > 0) {
    const angle = primaryTarget
      ? Math.atan2(primaryTarget.y - state.player.y, primaryTarget.x - state.player.x)
      : 0;
    const speed = 280;

    state.bullets.push({
      x: state.player.x,
      y: state.player.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.9,
    });
    state.player.ammo = Math.max(0, state.player.ammo - 1);
    state.player.shootCooldown = Math.max(0.09, 0.22 - state.boost * 0.0012);
  }

  state.spawnTimer += dt;
  state.ringTimer += dt;
  if (state.spawnTimer >= state.nextSpawnDelay) {
    state.spawnTimer = 0;
    state.nextSpawnDelay = Math.max(0.28, 0.85 - state.wave * 0.035);
    spawnVoxelEnemy(state);
    if (state.wave >= 3 && Math.random() > 0.55) {
      spawnVoxelEnemy(state);
    }
  }

  const ringSpawnDelay = state.player.ammo <= 4 ? 1.15 : 2.35;
  const shouldForceRecoveryRing = state.player.ammo === 0 && state.rings.length === 0 && state.ringTimer >= 0.42;
  if ((state.ringTimer >= ringSpawnDelay || shouldForceRecoveryRing) && state.rings.length < 2) {
    state.ringTimer = 0;
    spawnSkyRing(state);
  }

  state.rings = state.rings.filter((ring) => {
    ring.y += ring.vy * dt;
    ring.x += Math.sin(state.time + ring.spin) * ring.drift * dt;
    ring.spin += dt * 2.2;

    if (Math.hypot(ring.x - state.player.x, ring.y - state.player.y) < ring.radius + state.player.size * 0.85) {
      state.score += 18 + state.combo * 4;
      state.combo = Math.min(12, state.combo + 1);
      state.boost = Math.min(100, state.boost + 12);
      state.player.health = Math.min(100, state.player.health + 2);
      state.player.ammo = Math.min(state.player.maxAmmo, state.player.ammo + 6);
      spawnVoxelBurst(state, ring.x, ring.y, ring.hue, 18);
      return false;
    }

    if (ring.y > VOXEL_GAME_HEIGHT + 40) {
      state.combo = Math.max(0, state.combo - 1);
      return false;
    }

    return true;
  });

  state.bullets = state.bullets.filter((bullet) => {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;

    if (
      bullet.life <= 0
      || bullet.x < -24
      || bullet.x > VOXEL_GAME_WIDTH + 24
      || bullet.y < -24
      || bullet.y > VOXEL_GAME_HEIGHT + 24
      || intersectsBlock(bullet.x, bullet.y, 4, state.blocks)
    ) {
      return false;
    }

    const enemyIndex = state.enemies.findIndex((enemy) => (
      Math.hypot(enemy.x - bullet.x, enemy.y - bullet.y) < enemy.size + 5
    ));
    if (enemyIndex >= 0) {
      const enemy = state.enemies[enemyIndex];
      enemy.hp -= 1;
      state.shake = 0.12;
      spawnVoxelBurst(state, bullet.x, bullet.y, enemy.hue, 6);
      if (enemy.hp <= 0) {
        state.enemies.splice(enemyIndex, 1);
        state.kills += 1;
        state.score += 10 * state.wave;
        state.boost = Math.min(100, state.boost + 6);
        if (state.kills % 8 === 0) {
          state.wave += 1;
          state.player.health = Math.min(100, state.player.health + 8);
        }
        spawnVoxelBurst(state, enemy.x, enemy.y, enemy.hue + 20, 16);
      }
      return false;
    }

    return true;
  });

  for (const enemy of state.enemies) {
    const dx = state.player.x - enemy.x;
    const dy = state.player.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    const stepX = (dx / distance) * enemy.speed * dt;
    const stepY = (dy / distance) * enemy.speed * dt;
    const nextEnemyX = enemy.x + stepX;
    const nextEnemyY = enemy.y + stepY;

    if (!intersectsBlock(nextEnemyX, enemy.y, enemy.size, state.blocks)) {
      enemy.x = nextEnemyX;
    }
    if (!intersectsBlock(enemy.x, nextEnemyY, enemy.size, state.blocks)) {
      enemy.y = nextEnemyY;
    }

    if (Math.hypot(enemy.x - state.player.x, enemy.y - state.player.y) < enemy.size + state.player.size) {
      state.player.health = Math.max(0, state.player.health - dt * (10 + state.wave * 1.3));
      state.combo = 0;
      state.shake = 0.22;
    }
  }

  state.particles.push({
    x: state.player.x - 2 + (Math.random() - 0.5) * 4,
    y: state.player.y + state.player.size * 0.9,
    vx: (Math.random() - 0.5) * 18,
    vy: 26 + Math.random() * 30,
    life: 0.24 + Math.random() * 0.12,
    size: 2 + Math.random() * 3,
    hue: 190 + Math.random() * 30,
  });

  state.particles = state.particles.filter((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.97;
    particle.vy *= 0.97;
    particle.life -= dt;
    return particle.life > 0;
  });
}

function drawVoxelGame(context: CanvasRenderingContext2D, state: VoxelGameState) {
  context.clearRect(0, 0, VOXEL_GAME_WIDTH, VOXEL_GAME_HEIGHT);
  context.save();

  const shakeX = state.shake > 0 ? (Math.random() - 0.5) * state.shake * 18 : 0;
  const shakeY = state.shake > 0 ? (Math.random() - 0.5) * state.shake * 18 : 0;
  context.translate(shakeX, shakeY);

  const background = context.createLinearGradient(0, 0, 0, VOXEL_GAME_HEIGHT);
  background.addColorStop(0, '#CBE8FF');
  background.addColorStop(0.55, '#9DD4FF');
  background.addColorStop(1, '#5FA8FF');
  context.fillStyle = background;
  context.fillRect(0, 0, VOXEL_GAME_WIDTH, VOXEL_GAME_HEIGHT);

  const sunGradient = context.createRadialGradient(290, 82, 12, 290, 82, 92);
  sunGradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  sunGradient.addColorStop(0.3, 'rgba(254,240,138,0.95)');
  sunGradient.addColorStop(1, 'rgba(254,240,138,0)');
  context.fillStyle = sunGradient;
  context.beginPath();
  context.arc(290, 82, 92, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.08)';
  for (let stripe = 0; stripe < 7; stripe += 1) {
    const stripeY = ((state.time * (26 + stripe * 2)) + stripe * 88) % (VOXEL_GAME_HEIGHT + 120) - 60;
    context.fillRect(-30, stripeY, VOXEL_GAME_WIDTH + 60, 2);
  }

  context.fillStyle = 'rgba(255,255,255,0.12)';
  for (let x = 0; x <= VOXEL_GAME_WIDTH; x += 24) {
    context.fillRect(x, 0, 1, VOXEL_GAME_HEIGHT);
  }
  for (let y = 0; y <= VOXEL_GAME_HEIGHT; y += 24) {
    context.fillRect(0, y, VOXEL_GAME_WIDTH, 1);
  }

  for (let cloudIndex = 0; cloudIndex < 5; cloudIndex += 1) {
    const cloudX = ((state.time * (8 + cloudIndex * 2) + cloudIndex * 95) % (VOXEL_GAME_WIDTH + 100)) - 60;
    const cloudY = 50 + cloudIndex * 76;
    context.fillStyle = 'rgba(255,255,255,0.24)';
    context.beginPath();
    context.arc(cloudX, cloudY, 18, 0, Math.PI * 2);
    context.arc(cloudX + 18, cloudY - 8, 16, 0, Math.PI * 2);
    context.arc(cloudX + 36, cloudY, 18, 0, Math.PI * 2);
    context.fill();
  }

  for (const particle of state.particles) {
    context.fillStyle = `hsla(${particle.hue}, 95%, 60%, ${Math.max(0, particle.life)})`;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    context.fill();
  }

  for (const ring of state.rings) {
    context.save();
    context.translate(ring.x, ring.y);
    context.rotate(ring.spin);
    context.strokeStyle = `hsla(${ring.hue}, 94%, 58%, 0.95)`;
    context.lineWidth = 5;
    context.beginPath();
    context.arc(0, 0, ring.radius, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = 'rgba(255,255,255,0.65)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(0, 0, ring.radius - 4, Math.PI * 0.2, Math.PI * 1.25);
    context.stroke();
    context.restore();
  }

  for (const bullet of state.bullets) {
    context.fillStyle = '#111827';
    context.beginPath();
    context.arc(bullet.x, bullet.y, 3.5, 0, Math.PI * 2);
    context.fill();
  }

  for (const enemy of state.enemies) {
    context.save();
    context.translate(enemy.x, enemy.y);
    context.fillStyle = `hsl(${enemy.hue}, 82%, 56%)`;
    context.beginPath();
    context.moveTo(0, -enemy.size - 2);
    context.lineTo(enemy.size, enemy.size + 2);
    context.lineTo(-enemy.size, enemy.size + 2);
    context.closePath();
    context.fill();
    context.fillStyle = 'rgba(255,255,255,0.28)';
    context.fillRect(-enemy.size * 0.65, -enemy.size * 0.65, enemy.size * 1.3, enemy.size * 0.42);
    context.restore();
  }

  const playerPulse = 0.9 + Math.sin(state.time * 6) * 0.05;
  context.save();
  context.translate(state.player.x, state.player.y);
  context.scale(playerPulse, playerPulse);
  context.rotate(Math.sin(state.time * 2.5) * 0.08);
  context.fillStyle = '#0F172A';
  context.beginPath();
  context.moveTo(0, -state.player.size - 8);
  context.lineTo(state.player.size * 0.7, state.player.size);
  context.lineTo(state.player.size * 0.2, state.player.size * 0.4);
  context.lineTo(-state.player.size * 0.2, state.player.size * 0.4);
  context.lineTo(-state.player.size * 0.7, state.player.size);
  context.closePath();
  context.fill();
  context.fillStyle = '#38BDF8';
  context.fillRect(-state.player.size * 0.85, -1.5, state.player.size * 1.7, 6);
  context.fillStyle = '#E0F2FE';
  context.beginPath();
  context.arc(0, -state.player.size * 0.2, 5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = 'rgba(255,255,255,0.65)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(-state.player.size * 0.7, state.player.size * 0.9);
  context.lineTo(-state.player.size * 1.55, state.player.size * 1.65);
  context.moveTo(state.player.size * 0.7, state.player.size * 0.9);
  context.lineTo(state.player.size * 1.55, state.player.size * 1.65);
  context.stroke();
  context.restore();

  context.restore();
}

function getPlayerFlightBounds(playerSize: number) {
  return {
    minX: playerSize * 1.6,
    maxX: VOXEL_GAME_WIDTH - playerSize * 1.6,
    minY: playerSize + 14,
    maxY: VOXEL_GAME_HEIGHT - playerSize * 1.8,
  };
}

const SIDEBAR_COLLAPSED_FOLDERS_STORAGE_PREFIX = 'codex.sidebar.collapsedFolders';
const SIDEBAR_COLLAPSED_TOPICS_STORAGE_PREFIX = 'codex.sidebar.collapsedTopics';
const THEME_MODE_STORAGE_PREFIX = 'codex.theme.mode';

function readBooleanMapFromStorage(storageKey: string): Record<string, boolean> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === true)
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeBooleanMapToStorage(storageKey: string, value: Record<string, boolean>) {
  if (typeof window === 'undefined') {
    return;
  }

  const truthyEntries = Object.entries(value).filter(([, entryValue]) => entryValue === true);
  if (truthyEntries.length === 0) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(truthyEntries)));
}

function getThemeModeStorageKey(profileId: string): string {
  return `${THEME_MODE_STORAGE_PREFIX}:${profileId}`;
}

function readThemeModeForProfile(profileId: string): ThemeMode {
  if (typeof window === 'undefined' || !profileId) {
    return 'light';
  }

  const raw = window.localStorage.getItem(getThemeModeStorageKey(profileId));
  return raw === 'dark' ? 'dark' : 'light';
}

function writeThemeModeForProfile(profileId: string, mode: ThemeMode) {
  if (typeof window === 'undefined' || !profileId) {
    return;
  }

  window.localStorage.setItem(getThemeModeStorageKey(profileId), mode);
}

function FileTreeDialog({
  browser,
  loadedNodes,
  expandedPaths,
  loadingPaths,
  error,
  pathValue,
  filterValue,
  onClose,
  onPathChange,
  onFilterChange,
  onOpenPath,
  onNavigateTo,
  onToggleDirectory,
  onPreviewFile,
}: {
  browser: CodexFileTreeBrowseResult | null;
  loadedNodes: Record<string, CodexFileTreeBrowseResult>;
  expandedPaths: Record<string, boolean>;
  loadingPaths: Record<string, boolean>;
  error: string | null;
  pathValue: string;
  filterValue: string;
  onClose: () => void;
  onPathChange: (value: string) => void;
  onFilterChange: (value: string) => void;
  onOpenPath: () => void;
  onNavigateTo: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPreviewFile: (path: string) => void;
}) {
  const normalizedFilter = filterValue.trim().toLowerCase();

  const matchesEntry = (entry: CodexFileTreeEntry): boolean => {
    if (!normalizedFilter) {
      return true;
    }

    const haystack = `${entry.name}\n${entry.path}\n${entry.extension || ''}`.toLowerCase();
    if (haystack.includes(normalizedFilter)) {
      return true;
    }

    if (entry.kind === 'directory') {
      const childBrowser = loadedNodes[entry.path];
      return childBrowser?.entries.some(matchesEntry) || false;
    }

    return false;
  };

  const renderEntries = (entries: CodexFileTreeEntry[], depth = 0) => (
    <div className="space-y-2">
      {entries.filter(matchesEntry).map((entry) => {
        const isDirectory = entry.kind === 'directory';
        const isExpanded = Boolean(expandedPaths[entry.path]);
        const childBrowser = loadedNodes[entry.path];
        const isLoading = Boolean(loadingPaths[entry.path]);

        return (
          <div key={entry.path} className="space-y-2">
            <div
              className="flex items-center gap-2 rounded-[1.25rem] border border-slate-100 bg-white px-3 py-2.5 shadow-sm"
              style={{ marginInlineStart: `${depth * 14}px` }}
            >
              <button
                type="button"
                onClick={() => (isDirectory ? onToggleDirectory(entry.path) : onPreviewFile(entry.path))}
                className="flex min-w-0 flex-1 items-center gap-3 text-right"
              >
                <div className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                  isDirectory ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'
                )}>
                  {isDirectory ? <Folder className="h-4 w-4" /> : <File className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-800">{entry.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400" dir="ltr" title={entry.path}>
                    {entry.path}
                  </div>
                </div>
              </button>
              {isDirectory ? (
                <button
                  type="button"
                  onClick={() => onToggleDirectory(entry.path)}
                  className="rounded-full bg-slate-50 p-2 text-slate-500 transition hover:bg-slate-100"
                  aria-label={isExpanded ? 'כווץ תיקייה' : 'פתח תיקייה'}
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')} />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onPreviewFile(entry.path)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100"
                >
                  <Eye className="h-3.5 w-3.5" />
                  <span>צפייה</span>
                </button>
              )}
              <CopyButton text={entry.path} ariaLabel="העתק נתיב" className="h-8 w-8 border-0 bg-slate-50" />
            </div>
            {isDirectory && isExpanded && childBrowser && renderEntries(childBrowser.entries, depth + 1)}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[76] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close file tree"
      />
      <div className="relative z-10 flex w-full max-w-3xl max-h-[84dvh] flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <FolderTree className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                File Tree
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">
                עץ קבצים לתיקייה הפעילה
              </div>
              {browser && (
                <div className="mt-1 truncate text-xs text-slate-500" dir="ltr" title={browser.currentPath}>
                  {browser.currentPath}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-slate-100 px-5 py-3">
          <div className="flex min-w-full items-center gap-2">
            <input
              type="text"
              value={pathValue}
              onChange={(event) => onPathChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onOpenPath();
                }
              }}
              placeholder="/workspace/project"
              dir="ltr"
              className="h-10 flex-1 rounded-full border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-slate-300"
            />
            <button
              type="button"
              onClick={onOpenPath}
              className="shrink-0 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              טען עץ
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={filterValue}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder="סנן קבצים ותיקיות"
              className="h-10 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-slate-300"
            />
            {browser?.parentPath && (
              <button
                type="button"
                onClick={() => onNavigateTo(browser.parentPath!)}
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 transition hover:bg-slate-50"
              >
                למעלה
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {browser?.breadcrumbs.map((crumb) => (
              <button
                key={crumb.path}
                type="button"
                onClick={() => onNavigateTo(crumb.path)}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-200"
              >
                {crumb.name}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {error ? (
            <div className="rounded-[1.5rem] border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
              {error}
            </div>
          ) : !browser ? (
            <div className="flex min-h-[260px] items-center justify-center rounded-[1.5rem] border border-slate-100 bg-slate-50/70 text-sm text-slate-500">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>טוען עץ קבצים...</span>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {browser.truncated && (
                <div className="rounded-[1.25rem] border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  התיקייה גדולה מאוד, ולכן נטענה רק רשימה חלקית. אפשר לפתוח תת־תיקייה או לסנן.
                </div>
              )}
              {browser.entries.length === 0 ? (
                <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  אין קבצים או תתי־תיקיות להצגה כאן.
                </div>
              ) : (
                renderEntries(browser.entries)
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const RUNNER_GAME_WIDTH = 360;
const RUNNER_GAME_HEIGHT = 520;
const RUNNER_BASELINE_Y = 424;

type RunnerSegment = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  accentHue: number;
};

type RunnerObstacle = {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hue: number;
  kind: 'crate' | 'spike' | 'drone';
};

type RunnerCoin = {
  id: number;
  x: number;
  y: number;
  r: number;
  kind: 'coin' | 'gem';
  bob: number;
  spin: number;
};

type RunnerParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  hue: number;
  alpha: number;
};

type RunnerCloud = {
  x: number;
  y: number;
  w: number;
  h: number;
  speed: number;
  opacity: number;
};

type RunnerGameState = {
  player: {
    x: number;
    y: number;
    w: number;
    h: number;
    vy: number;
    grounded: boolean;
    airJumpRemaining: number;
    health: number;
    invulnerability: number;
    tilt: number;
    stretch: number;
    squash: number;
  };
  segments: RunnerSegment[];
  obstacles: RunnerObstacle[];
  coins: RunnerCoin[];
  particles: RunnerParticle[];
  clouds: RunnerCloud[];
  score: number;
  distance: number;
  combo: number;
  feverCharge: number;
  feverTimer: number;
  speed: number;
  stage: number;
  time: number;
  nextId: number;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function drawRoundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
) {
  const safeRadius = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + w, y, x + w, y + h, safeRadius);
  context.arcTo(x + w, y + h, x, y + h, safeRadius);
  context.arcTo(x, y + h, x, y, safeRadius);
  context.arcTo(x, y, x + w, y, safeRadius);
  context.closePath();
}

function spawnRunnerBurst(
  state: RunnerGameState,
  x: number,
  y: number,
  hue: number,
  count = 14
) {
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.45;
    const speed = 28 + Math.random() * 90;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.22 + Math.random() * 0.35,
      size: 2 + Math.random() * 3,
      hue,
      alpha: 0.65 + Math.random() * 0.3,
    });
  }
}

function spawnRunnerLandingDust(state: RunnerGameState, amount = 8) {
  for (let index = 0; index < amount; index += 1) {
    state.particles.push({
      x: state.player.x + randomBetween(-8, 8),
      y: state.player.y + state.player.h / 2 - 3,
      vx: randomBetween(-28, 32),
      vy: randomBetween(-12, 12),
      life: 0.18 + Math.random() * 0.16,
      size: 3 + Math.random() * 3,
      hue: 32 + Math.random() * 26,
      alpha: 0.35 + Math.random() * 0.18,
    });
  }
}

function spawnRunnerCoinArc(state: RunnerGameState, segment: RunnerSegment) {
  const count = Math.random() > 0.66 ? 6 : 4 + Math.floor(Math.random() * 2);
  const arcHeight = 30 + Math.random() * 48;
  const startInset = 24 + Math.random() * 16;
  const endInset = 24 + Math.random() * 18;
  for (let index = 0; index < count; index += 1) {
    const progress = count === 1 ? 0.5 : index / (count - 1);
    const x = segment.x + startInset + progress * Math.max(18, segment.w - startInset - endInset);
    const y = segment.y - 44 - Math.sin(progress * Math.PI) * arcHeight;
    const isGem = count >= 5 && index === Math.floor(count / 2) && Math.random() > 0.44;
    state.coins.push({
      id: state.nextId++,
      x,
      y,
      r: isGem ? 8 : 6.2,
      kind: isGem ? 'gem' : 'coin',
      bob: Math.random() * Math.PI * 2,
      spin: Math.random() * Math.PI * 2,
    });
  }
}

function spawnRunnerObstacle(state: RunnerGameState, segment: RunnerSegment) {
  if (segment.w < 118 || Math.random() < 0.2) {
    return;
  }

  const obstacleCount = segment.w > 170 && Math.random() > 0.6 ? 2 : 1;
  for (let index = 0; index < obstacleCount; index += 1) {
    const kindRoll = Math.random();
    const kind: RunnerObstacle['kind'] = kindRoll > 0.8 ? 'drone' : kindRoll > 0.46 ? 'crate' : 'spike';
    const obstacleW = kind === 'spike' ? 30 : kind === 'drone' ? 28 : 34;
    const obstacleH = kind === 'spike' ? 18 : kind === 'drone' ? 26 : 34;
    const maxX = segment.x + segment.w - obstacleW - 28;
    const minX = segment.x + 28;
    if (maxX <= minX) {
      return;
    }

    const slotSpacing = obstacleCount === 1 ? 0.5 : 0.28 + index * 0.38;
    const x = clampNumber(
      minX + slotSpacing * (maxX - minX) + randomBetween(-10, 10),
      minX,
      maxX
    );
    const y = kind === 'drone'
      ? segment.y - obstacleH - randomBetween(34, 68)
      : segment.y - obstacleH;

    state.obstacles.push({
      id: state.nextId++,
      x,
      y,
      w: obstacleW,
      h: obstacleH,
      kind,
      hue: kind === 'spike'
        ? 348 + Math.random() * 18
        : kind === 'drone'
          ? 208 + Math.random() * 24
          : 22 + Math.random() * 20,
    });
  }
}

function spawnRunnerSegment(state: RunnerGameState) {
  const lastSegment = state.segments[state.segments.length - 1];
  const previousY = lastSegment?.y ?? RUNNER_BASELINE_Y;
  let gap = randomBetween(34, 74);
  const y = clampNumber(previousY + randomBetween(-48, 44), 332, 438);

  if (y < previousY - 24) {
    gap = Math.min(gap, 56);
  }
  if (y > previousY + 28) {
    gap = Math.min(gap, 62);
  }

  const w = randomBetween(118, 194);
  const x = (lastSegment ? lastSegment.x + lastSegment.w : -60) + gap;
  const segment: RunnerSegment = {
    id: state.nextId++,
    x,
    y,
    w,
    h: RUNNER_GAME_HEIGHT - y + 24,
    accentHue: 24 + Math.random() * 52,
  };
  state.segments.push(segment);

  spawnRunnerCoinArc(state, segment);
  spawnRunnerObstacle(state, segment);
}

function createRunnerClouds(): RunnerCloud[] {
  return Array.from({ length: 7 }, (_, index) => ({
    x: (RUNNER_GAME_WIDTH / 7) * index + randomBetween(-18, 12),
    y: 52 + Math.random() * 150,
    w: 56 + Math.random() * 54,
    h: 24 + Math.random() * 18,
    speed: 10 + Math.random() * 18,
    opacity: 0.16 + Math.random() * 0.15,
  }));
}

function createRunnerGameState(): RunnerGameState {
  const state: RunnerGameState = {
    player: {
      x: 92,
      y: RUNNER_BASELINE_Y - 19,
      w: 28,
      h: 38,
      vy: 0,
      grounded: true,
      airJumpRemaining: 1,
      health: 100,
      invulnerability: 0,
      tilt: 0,
      stretch: 1,
      squash: 1,
    },
    segments: [
      { id: 1, x: -56, y: RUNNER_BASELINE_Y, w: 214, h: RUNNER_GAME_HEIGHT - RUNNER_BASELINE_Y + 24, accentHue: 24 },
      { id: 2, x: 178, y: RUNNER_BASELINE_Y - 16, w: 184, h: RUNNER_GAME_HEIGHT - (RUNNER_BASELINE_Y - 16) + 24, accentHue: 38 },
    ],
    obstacles: [],
    coins: [],
    particles: [],
    clouds: createRunnerClouds(),
    score: 0,
    distance: 0,
    combo: 0,
    feverCharge: 14,
    feverTimer: 0,
    speed: 182,
    stage: 1,
    time: 0,
    nextId: 3,
  };

  spawnRunnerCoinArc(state, state.segments[0]);
  spawnRunnerCoinArc(state, state.segments[1]);
  while (state.segments[state.segments.length - 1].x + state.segments[state.segments.length - 1].w < RUNNER_GAME_WIDTH + 180) {
    spawnRunnerSegment(state);
  }
  return state;
}

function triggerRunnerJump(state: RunnerGameState) {
  if (state.player.health <= 0) {
    return false;
  }

  const canGroundJump = state.player.grounded;
  const canAirJump = !state.player.grounded && state.player.airJumpRemaining > 0;
  if (!canGroundJump && !canAirJump) {
    return false;
  }

  state.player.vy = canGroundJump
    ? -426 - Math.min(26, state.speed * 0.04)
    : -392 - Math.min(20, state.speed * 0.03);
  state.player.grounded = false;
  if (canAirJump) {
    state.player.airJumpRemaining -= 1;
    state.combo = Math.max(1, state.combo);
    state.feverCharge = Math.min(100, state.feverCharge + 4);
  } else {
    state.player.airJumpRemaining = 1;
  }
  state.player.stretch = 1.18;
  state.player.squash = 0.88;
  spawnRunnerBurst(state, state.player.x - 4, state.player.y + 12, canGroundJump ? 24 : 288, canGroundJump ? 8 : 11);
  return true;
}

function updateRunnerGame(state: RunnerGameState, dt: number) {
  state.time += dt;
  state.player.invulnerability = Math.max(0, state.player.invulnerability - dt);
  state.player.stretch += (1 - state.player.stretch) * Math.min(1, dt * 8);
  state.player.squash += (1 - state.player.squash) * Math.min(1, dt * 10);

  if (state.feverTimer > 0) {
    state.feverTimer = Math.max(0, state.feverTimer - dt);
  }

  const targetSpeed = 182 + Math.min(156, state.distance * 0.048) + (state.feverTimer > 0 ? 58 : 0);
  state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 2.4);
  state.distance += state.speed * dt * 0.1;
  state.stage = 1 + Math.floor(state.distance / 120);

  const shift = state.speed * dt;
  state.segments.forEach((segment) => {
    segment.x -= shift;
  });
  state.obstacles.forEach((obstacle) => {
    obstacle.x -= shift;
    if (obstacle.kind === 'drone') {
      obstacle.y += Math.sin(state.time * 6 + obstacle.id) * 0.42;
    }
  });
  state.coins.forEach((coin) => {
    coin.x -= shift;
    coin.bob += dt * (coin.kind === 'gem' ? 4.4 : 3.2);
    coin.spin += dt * (coin.kind === 'gem' ? 6.8 : 5.2);
  });
  state.clouds.forEach((cloud) => {
    cloud.x -= cloud.speed * dt;
    if (cloud.x + cloud.w < -24) {
      cloud.x = RUNNER_GAME_WIDTH + randomBetween(12, 62);
      cloud.y = 48 + Math.random() * 152;
      cloud.w = 56 + Math.random() * 54;
      cloud.h = 24 + Math.random() * 18;
      cloud.speed = 10 + Math.random() * 18;
      cloud.opacity = 0.16 + Math.random() * 0.15;
    }
  });

  while (state.segments[state.segments.length - 1].x + state.segments[state.segments.length - 1].w < RUNNER_GAME_WIDTH + 180) {
    spawnRunnerSegment(state);
  }

  const previousBottom = state.player.y + state.player.h / 2;
  state.player.vy += 1120 * dt;
  state.player.y += state.player.vy * dt;
  const nextBottom = state.player.y + state.player.h / 2;

  let landingY: number | null = null;
  for (const segment of state.segments) {
    const overlapsSegment = (
      state.player.x + state.player.w * 0.34 > segment.x
      && state.player.x - state.player.w * 0.34 < segment.x + segment.w
    );
    if (!overlapsSegment) {
      continue;
    }
    if (state.player.vy >= 0 && previousBottom <= segment.y + 10 && nextBottom >= segment.y) {
      landingY = landingY === null ? segment.y : Math.min(landingY, segment.y);
    }
  }

  if (landingY !== null) {
    if (!state.player.grounded) {
      spawnRunnerLandingDust(state, 10);
    }
    state.player.y = landingY - state.player.h / 2;
    state.player.vy = 0;
    state.player.grounded = true;
    state.player.airJumpRemaining = 1;
    state.player.stretch = 0.92;
    state.player.squash = 1.08;
  } else {
    state.player.grounded = false;
  }

  state.player.tilt += (
    clampNumber(state.player.vy * 0.0016, -0.42, 0.5)
    - state.player.tilt
  ) * Math.min(1, dt * 8);

  state.coins = state.coins.filter((coin) => {
    if (coin.x + coin.r < -24) {
      return false;
    }

    const coinY = coin.y + Math.sin(coin.bob) * (coin.kind === 'gem' ? 4 : 3);
    if (Math.hypot(coin.x - state.player.x, coinY - state.player.y) < coin.r + state.player.w * 0.35) {
      const baseScore = coin.kind === 'gem' ? 88 : 22;
      const multiplier = state.feverTimer > 0 ? 2.2 : 1 + Math.min(0.9, state.combo * 0.05);
      state.score += Math.round(baseScore * multiplier);
      state.combo += 1;
      state.feverCharge = Math.min(100, state.feverCharge + (coin.kind === 'gem' ? 18 : 8));
      state.player.health = Math.min(100, state.player.health + (coin.kind === 'gem' ? 4 : 1));
      spawnRunnerBurst(state, coin.x, coinY, coin.kind === 'gem' ? 205 : 44, coin.kind === 'gem' ? 16 : 10);
      if (state.feverCharge >= 100 && state.feverTimer <= 0) {
        state.feverTimer = 6.6;
        state.feverCharge = 0;
      }
      return false;
    }

    return true;
  });

  state.obstacles = state.obstacles.filter((obstacle) => {
    if (obstacle.x + obstacle.w < -36) {
      return false;
    }

    const overlaps = (
      state.player.x + state.player.w * 0.38 > obstacle.x
      && state.player.x - state.player.w * 0.38 < obstacle.x + obstacle.w
      && state.player.y + state.player.h * 0.42 > obstacle.y
      && state.player.y - state.player.h * 0.42 < obstacle.y + obstacle.h
    );
    if (!overlaps) {
      return true;
    }

    if (state.feverTimer > 0) {
      state.score += 140;
      state.combo += 1;
      spawnRunnerBurst(state, obstacle.x + obstacle.w / 2, obstacle.y + obstacle.h / 2, 30 + obstacle.hue, 18);
      return false;
    }

    if (state.player.invulnerability > 0) {
      return true;
    }

    state.player.health = Math.max(0, state.player.health - (obstacle.kind === 'spike' ? 30 : obstacle.kind === 'drone' ? 24 : 18));
    state.player.invulnerability = 1.15;
    state.player.vy = -260;
    state.player.grounded = false;
    state.combo = 0;
    state.player.stretch = 1.14;
    state.player.squash = 0.86;
    spawnRunnerBurst(state, state.player.x + 8, state.player.y - 4, 348, 16);
    return obstacle.kind === 'spike';
  });

  state.segments = state.segments.filter((segment) => segment.x + segment.w > -90);

  state.particles.push({
    x: state.player.x - state.player.w * 0.34 + (Math.random() - 0.5) * 4,
    y: state.player.y + state.player.h * 0.4,
    vx: -24 - Math.random() * 22,
    vy: 10 + Math.random() * 16,
    life: 0.14 + Math.random() * 0.08,
    size: 2 + Math.random() * 2,
    hue: state.feverTimer > 0 ? 182 + Math.random() * 80 : 34 + Math.random() * 18,
    alpha: 0.28 + Math.random() * 0.14,
  });

  state.particles = state.particles.filter((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.98;
    particle.vy = particle.vy * 0.96 + 6 * dt;
    particle.life -= dt;
    return particle.life > 0;
  });

  if (state.player.y - state.player.h / 2 > RUNNER_GAME_HEIGHT + 64) {
    state.player.health = 0;
  }
}

function drawRunnerGame(context: CanvasRenderingContext2D, state: RunnerGameState) {
  context.clearRect(0, 0, RUNNER_GAME_WIDTH, RUNNER_GAME_HEIGHT);
  context.save();

  const shakeAmount = state.player.invulnerability > 0 ? state.player.invulnerability * 3 : 0;
  if (shakeAmount > 0) {
    context.translate((Math.random() - 0.5) * shakeAmount, (Math.random() - 0.5) * shakeAmount);
  }

  const background = context.createLinearGradient(0, 0, 0, RUNNER_GAME_HEIGHT);
  background.addColorStop(0, '#FFF7FB');
  background.addColorStop(0.26, '#FFD8C7');
  background.addColorStop(0.56, '#FDBA74');
  background.addColorStop(1, '#4F46E5');
  context.fillStyle = background;
  context.fillRect(0, 0, RUNNER_GAME_WIDTH, RUNNER_GAME_HEIGHT);

  const sunGlow = context.createRadialGradient(286, 108, 20, 286, 108, 130);
  sunGlow.addColorStop(0, 'rgba(255,255,255,0.98)');
  sunGlow.addColorStop(0.28, 'rgba(253,224,71,0.85)');
  sunGlow.addColorStop(1, 'rgba(251,146,60,0)');
  context.fillStyle = sunGlow;
  context.beginPath();
  context.arc(286, 108, 128, 0, Math.PI * 2);
  context.fill();

  const horizonOffset = state.distance * 4.4;
  const mountainLayers = [
    { color: 'rgba(251,191,36,0.22)', baseY: 336, amplitude: 28, frequency: 140, parallax: 0.18 },
    { color: 'rgba(244,114,182,0.24)', baseY: 374, amplitude: 36, frequency: 118, parallax: 0.32 },
    { color: 'rgba(59,130,246,0.22)', baseY: 408, amplitude: 30, frequency: 100, parallax: 0.48 },
  ] as const;

  for (const layer of mountainLayers) {
    context.beginPath();
    context.moveTo(0, RUNNER_GAME_HEIGHT);
    for (let x = 0; x <= RUNNER_GAME_WIDTH + 16; x += 12) {
      const angle = ((x + horizonOffset * layer.parallax) / layer.frequency) * Math.PI;
      const y = layer.baseY - Math.sin(angle) * layer.amplitude - Math.cos(angle * 0.55) * (layer.amplitude * 0.25);
      context.lineTo(x, y);
    }
    context.lineTo(RUNNER_GAME_WIDTH, RUNNER_GAME_HEIGHT);
    context.closePath();
    context.fillStyle = layer.color;
    context.fill();
  }

  for (const cloud of state.clouds) {
    context.save();
    context.fillStyle = `rgba(255,255,255,${cloud.opacity})`;
    context.beginPath();
    context.ellipse(cloud.x, cloud.y, cloud.w * 0.36, cloud.h * 0.48, 0, 0, Math.PI * 2);
    context.ellipse(cloud.x - cloud.w * 0.2, cloud.y + 6, cloud.w * 0.25, cloud.h * 0.38, 0, 0, Math.PI * 2);
    context.ellipse(cloud.x + cloud.w * 0.22, cloud.y + 8, cloud.w * 0.24, cloud.h * 0.34, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  for (const segment of state.segments) {
    context.save();
    context.shadowColor = 'rgba(79,70,229,0.12)';
    context.shadowBlur = 18;
    const segmentGradient = context.createLinearGradient(segment.x, segment.y, segment.x, segment.y + segment.h);
    segmentGradient.addColorStop(0, `hsl(${segment.accentHue}, 95%, 74%)`);
    segmentGradient.addColorStop(0.12, `hsl(${segment.accentHue + 12}, 88%, 63%)`);
    segmentGradient.addColorStop(1, 'hsl(255, 54%, 34%)');
    drawRoundedRectPath(context, segment.x, segment.y, segment.w, segment.h, 18);
    context.fillStyle = segmentGradient;
    context.fill();

    const turfGradient = context.createLinearGradient(segment.x, segment.y, segment.x, segment.y + 12);
    turfGradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    turfGradient.addColorStop(1, 'rgba(254,215,170,0.9)');
    drawRoundedRectPath(context, segment.x, segment.y - 3, segment.w, 12, 10);
    context.fillStyle = turfGradient;
    context.fill();

    context.fillStyle = 'rgba(255,255,255,0.14)';
    for (let stripeX = segment.x + 12; stripeX < segment.x + segment.w - 8; stripeX += 22) {
      context.fillRect(stripeX, segment.y + 18, 6, segment.h - 24);
    }
    context.restore();
  }

  for (const coin of state.coins) {
    const drawY = coin.y + Math.sin(coin.bob) * (coin.kind === 'gem' ? 4 : 3);
    context.save();
    context.translate(coin.x, drawY);
    context.rotate(Math.sin(coin.spin) * 0.34);
    context.shadowColor = coin.kind === 'gem' ? 'rgba(59,130,246,0.32)' : 'rgba(251,191,36,0.28)';
    context.shadowBlur = 12;
    const coinGradient = context.createRadialGradient(0, -1, coin.r * 0.2, 0, 0, coin.r);
    if (coin.kind === 'gem') {
      coinGradient.addColorStop(0, '#F0FDFA');
      coinGradient.addColorStop(0.55, '#67E8F9');
      coinGradient.addColorStop(1, '#2563EB');
    } else {
      coinGradient.addColorStop(0, '#FFF7BF');
      coinGradient.addColorStop(0.55, '#FCD34D');
      coinGradient.addColorStop(1, '#F97316');
    }
    context.fillStyle = coinGradient;
    context.beginPath();
    context.ellipse(0, 0, coin.r * 0.82, coin.r, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = 'rgba(255,255,255,0.72)';
    context.fillRect(-coin.r * 0.18, -coin.r * 0.75, coin.r * 0.18, coin.r * 1.5);
    context.restore();
  }

  for (const obstacle of state.obstacles) {
    context.save();
    if (obstacle.kind === 'spike') {
      const spikeGradient = context.createLinearGradient(obstacle.x, obstacle.y, obstacle.x, obstacle.y + obstacle.h);
      spikeGradient.addColorStop(0, '#FCA5A5');
      spikeGradient.addColorStop(1, '#DB2777');
      context.fillStyle = spikeGradient;
      context.beginPath();
      context.moveTo(obstacle.x, obstacle.y + obstacle.h);
      context.lineTo(obstacle.x + obstacle.w * 0.25, obstacle.y);
      context.lineTo(obstacle.x + obstacle.w * 0.5, obstacle.y + obstacle.h);
      context.lineTo(obstacle.x + obstacle.w * 0.75, obstacle.y);
      context.lineTo(obstacle.x + obstacle.w, obstacle.y + obstacle.h);
      context.closePath();
      context.fill();
    } else if (obstacle.kind === 'drone') {
      context.shadowColor = 'rgba(59,130,246,0.28)';
      context.shadowBlur = 12;
      const droneGradient = context.createLinearGradient(obstacle.x, obstacle.y, obstacle.x, obstacle.y + obstacle.h);
      droneGradient.addColorStop(0, '#DBEAFE');
      droneGradient.addColorStop(1, '#60A5FA');
      drawRoundedRectPath(context, obstacle.x, obstacle.y, obstacle.w, obstacle.h, 10);
      context.fillStyle = droneGradient;
      context.fill();
      context.fillStyle = 'rgba(15,23,42,0.78)';
      context.fillRect(obstacle.x + 6, obstacle.y + 9, obstacle.w - 12, 5);
      context.fillStyle = 'rgba(255,255,255,0.7)';
      context.fillRect(obstacle.x + 8, obstacle.y + obstacle.h - 8, obstacle.w - 16, 3);
    } else {
      context.shadowColor = 'rgba(251,146,60,0.22)';
      context.shadowBlur = 12;
      const crateGradient = context.createLinearGradient(obstacle.x, obstacle.y, obstacle.x, obstacle.y + obstacle.h);
      crateGradient.addColorStop(0, '#FED7AA');
      crateGradient.addColorStop(1, '#EA580C');
      drawRoundedRectPath(context, obstacle.x, obstacle.y, obstacle.w, obstacle.h, 10);
      context.fillStyle = crateGradient;
      context.fill();
      context.strokeStyle = 'rgba(255,255,255,0.52)';
      context.lineWidth = 2;
      context.strokeRect(obstacle.x + 5, obstacle.y + 5, obstacle.w - 10, obstacle.h - 10);
      context.beginPath();
      context.moveTo(obstacle.x + 7, obstacle.y + 7);
      context.lineTo(obstacle.x + obstacle.w - 7, obstacle.y + obstacle.h - 7);
      context.moveTo(obstacle.x + obstacle.w - 7, obstacle.y + 7);
      context.lineTo(obstacle.x + 7, obstacle.y + obstacle.h - 7);
      context.stroke();
    }
    context.restore();
  }

  for (const particle of state.particles) {
    context.fillStyle = `hsla(${particle.hue} 90% 65% / ${particle.alpha * Math.max(0, particle.life * 2)})`;
    context.beginPath();
    context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
    context.fill();
  }

  context.save();
  context.translate(state.player.x, state.player.y);
  context.rotate(state.player.tilt);
  context.scale(state.player.stretch, state.player.squash);

  context.fillStyle = 'rgba(15,23,42,0.14)';
  context.beginPath();
  context.ellipse(0, state.player.h * 0.62, state.player.w * 0.6, 7, 0, 0, Math.PI * 2);
  context.fill();

  const runPhase = state.time * (state.player.grounded ? 11 : 5.5);
  const legSwing = Math.sin(runPhase) * (state.player.grounded ? 6 : 2);
  context.strokeStyle = '#1E293B';
  context.lineWidth = 5;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(-7, 10);
  context.lineTo(-10 + legSwing, 24);
  context.moveTo(7, 10);
  context.lineTo(10 - legSwing, 24);
  context.stroke();

  const bodyGradient = context.createLinearGradient(0, -state.player.h / 2, 0, state.player.h / 2);
  bodyGradient.addColorStop(0, state.feverTimer > 0 ? '#FDF2F8' : '#FEF3C7');
  bodyGradient.addColorStop(0.42, '#FB7185');
  bodyGradient.addColorStop(1, state.feverTimer > 0 ? '#7C3AED' : '#2563EB');
  drawRoundedRectPath(context, -state.player.w / 2, -state.player.h / 2, state.player.w, state.player.h, 11);
  context.fillStyle = bodyGradient;
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.66)';
  drawRoundedRectPath(context, -state.player.w / 2 + 3, -state.player.h / 2 + 3, state.player.w - 6, 8, 5);
  context.fill();

  context.fillStyle = '#FFF7ED';
  context.beginPath();
  context.ellipse(0, -7, 8, 8.5, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#0F172A';
  context.beginPath();
  context.arc(-3.2, -8, 1.4, 0, Math.PI * 2);
  context.arc(3.4, -8, 1.4, 0, Math.PI * 2);
  context.fill();
  context.fillRect(-4.4, -2, 8.8, 3.2);

  context.fillStyle = state.feverTimer > 0 ? '#22D3EE' : '#F97316';
  context.beginPath();
  context.moveTo(-state.player.w / 2 + 3, -5);
  context.quadraticCurveTo(-state.player.w / 2 - 14, 4, -state.player.w / 2 + 1, 10);
  context.quadraticCurveTo(-state.player.w / 2 + 10, 6, -state.player.w / 2 + 9, -1);
  context.closePath();
  context.fill();

  if (state.player.invulnerability > 0) {
    context.strokeStyle = `rgba(255,255,255,${0.22 + Math.sin(state.time * 18) * 0.1})`;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, state.player.w * 0.86, 0, Math.PI * 2);
    context.stroke();
  }

  context.restore();
  context.restore();
}

function MiniGameDialog({
  isOpen,
  onClose,
  sessionActiveCount,
  sessionCompletionSignal,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionActiveCount: number;
  sessionCompletionSignal: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const touchTargetRef = useRef<VoxelTouchTarget>({
    x: VOXEL_GAME_WIDTH / 2,
    y: VOXEL_GAME_HEIGHT / 2,
    active: false,
  });
  const stateRef = useRef<VoxelGameState>(createVoxelGameState());
  const emptyAmmoNoticeShownRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [wave, setWave] = useState(1);
  const [health, setHealth] = useState(100);
  const [ammo, setAmmo] = useState(12);
  const [combo, setCombo] = useState(0);
  const [boost, setBoost] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [topStatus, setTopStatus] = useState('Sky Ace');

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setScore(snapshot.score);
    setWave(snapshot.wave);
    setHealth(Math.max(0, Math.round(snapshot.player.health)));
    setAmmo(snapshot.player.ammo);
    setCombo(snapshot.combo);
    setBoost(Math.round(snapshot.boost));
  });

  const resetGame = useEffectEvent(() => {
    stateRef.current = createVoxelGameState();
    emptyAmmoNoticeShownRef.current = false;
    setIsGameOver(false);
    setIsPaused(false);
    setNotice(null);
    setTopStatus(sessionActiveCount > 0 ? 'הסשן רץ ברקע' : 'טיסת חופש');
    syncHud();
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    resetGame();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (sessionActiveCount > 0) {
      setTopStatus('הסשן רץ ברקע');
      return;
    }

    if (!isGameOver) {
      setTopStatus('טיסת חופש');
    }
  }, [isGameOver, isOpen, sessionActiveCount]);

  useEffect(() => {
    if (!isOpen || sessionCompletionSignal === 0) {
      return;
    }

    setNotice('הסשן הושלם, אפשר לעצור.');
    setTopStatus('הסשן הושלם');
    const timer = window.setTimeout(() => setNotice(null), 3400);
    return () => window.clearTimeout(timer);
  }, [isOpen, sessionCompletionSignal]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    let lastFrame = performance.now();

    const render = (frameTime: number) => {
      animationRef.current = window.requestAnimationFrame(render);
      if (isPaused || isGameOver) {
        drawVoxelGame(context, stateRef.current);
        return;
      }

      const delta = Math.min(0.033, (frameTime - lastFrame) / 1000);
      lastFrame = frameTime;
      updateVoxelGame(stateRef.current, touchTargetRef.current, delta);
      drawVoxelGame(context, stateRef.current);
      syncHud();

      if (stateRef.current.player.ammo === 0 && !emptyAmmoNoticeShownRef.current) {
        emptyAmmoNoticeShownRef.current = true;
        setNotice('אין תחמושת. אסוף טבעות כדי לטעון מחדש.');
        setTopStatus('אין תחמושת');
      } else if (stateRef.current.player.ammo > 0 && emptyAmmoNoticeShownRef.current) {
        emptyAmmoNoticeShownRef.current = false;
        if (sessionActiveCount > 0) {
          setTopStatus('הסשן רץ ברקע');
        } else if (!isGameOver) {
          setTopStatus('טיסת חופש');
        }
      }

      if (stateRef.current.player.health <= 0) {
        setIsGameOver(true);
        setTopStatus('נפלת. אפשר להפעיל מחדש.');
        setNotice('המשחק נעצר. הפעל מחדש כדי להמשיך.');
      }
    };

    animationRef.current = window.requestAnimationFrame(render);
    return () => {
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isGameOver, isOpen, isPaused]);

  const setTouchTargetFromPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    const scaleX = VOXEL_GAME_WIDTH / bounds.width;
    const scaleY = VOXEL_GAME_HEIGHT / bounds.height;
    const nextX = (clientX - bounds.left) * scaleX;
    const nextY = (clientY - bounds.top) * scaleY;
    const nextPlayerSize = stateRef.current.player.size;
    const flightBounds = getPlayerFlightBounds(nextPlayerSize);
    const clampedX = Math.min(
      flightBounds.maxX,
      Math.max(flightBounds.minX, nextX)
    );
    const clampedY = Math.min(
      flightBounds.maxY,
      Math.max(flightBounds.minY, nextY)
    );

    stateRef.current.player.x = clampedX;
    stateRef.current.player.y = clampedY;

    touchTargetRef.current = {
      x: clampedX,
      y: clampedY,
      active: true,
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setTouchTargetFromPoint(event.clientX, event.clientY);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!touchTargetRef.current.active) {
      return;
    }
    event.preventDefault();
    setTouchTargetFromPoint(event.clientX, event.clientY);
  };

  const handleTouchStart = (event: TouchEvent<HTMLCanvasElement>) => {
    const primaryTouch = event.touches[0];
    if (!primaryTouch) {
      return;
    }
    event.preventDefault();
    setTouchTargetFromPoint(primaryTouch.clientX, primaryTouch.clientY);
  };

  const handleTouchMove = (event: TouchEvent<HTMLCanvasElement>) => {
    const primaryTouch = event.touches[0];
    if (!primaryTouch) {
      return;
    }
    event.preventDefault();
    setTouchTargetFromPoint(primaryTouch.clientX, primaryTouch.clientY);
  };

  const releaseTouchTarget = () => {
    touchTargetRef.current = {
      ...touchTargetRef.current,
      active: false,
    };
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close mini game"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-sm flex-col overflow-y-auto rounded-[2rem] border border-sky-100 bg-white text-slate-800 shadow-[0_28px_90px_-36px_rgba(56,189,248,0.28)]">
        <div className="border-b border-sky-100 bg-gradient-to-b from-sky-50 via-cyan-50 to-white px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-sky-500 shadow-sm"
              title={topStatus}
            >
              <Gamepad2 className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPaused((current) => !current)}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => resetGame()}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-5 gap-2 text-xs">
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Score</div>
              <div className="mt-1 text-base font-semibold">{score}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Wave</div>
              <div className="mt-1 text-base font-semibold">{wave}</div>
            </div>
            <div className={cn('rounded-2xl bg-white px-3 py-2', ammo <= 3 && 'bg-rose-50 text-rose-700')}>
              <div className={cn('text-slate-400', ammo <= 3 && 'text-rose-400')}>Ammo</div>
              <div className="mt-1 text-base font-semibold">{ammo}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Combo</div>
              <div className="mt-1 text-base font-semibold">{combo}x</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">HP</div>
              <div className="mt-1 text-base font-semibold">{health}%</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Boost</div>
              <div className="mt-1 text-base font-semibold">{boost}%</div>
            </div>
          </div>
        </div>

        <div className="relative px-4 pt-4">
          <canvas
            ref={canvasRef}
            width={VOXEL_GAME_WIDTH}
            height={VOXEL_GAME_HEIGHT}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={releaseTouchTarget}
            onPointerCancel={releaseTouchTarget}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={releaseTouchTarget}
            className="aspect-[360/520] h-auto max-h-[58dvh] w-full touch-none rounded-[1.5rem] border border-white/10 bg-slate-900"
          />
          {notice && (
            <div className="pointer-events-none absolute left-8 right-8 top-8 rounded-full bg-emerald-400/90 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-lg">
              {notice}
            </div>
          )}
          {isGameOver && (
            <div className="absolute inset-8 flex items-center justify-center rounded-[1.5rem] bg-slate-950/60 backdrop-blur-sm">
              <div className="text-center">
                <div className="text-xl font-bold">Game Over</div>
                <div className="mt-2 text-sm text-slate-300">אפשר להפעיל מחדש או לחזור לצ׳אט.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GamePickerDialog({
  isOpen,
  onClose,
  onStart,
}: {
  isOpen: boolean;
  onClose: () => void;
  onStart: (game: 'sky-ace' | 'sunset-sprint' | 'sudoku-lab' | 'temple-gem-quest' | 'biome-snake' | 'rail-heist' | 'iron-desert' | 'vault-runner') => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close game picker"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-md flex-col overflow-y-auto rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.32)]">
        <div className="border-b border-slate-100 bg-gradient-to-b from-cyan-50/70 via-white to-white px-5 py-5 text-right">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cyan-50 text-cyan-600 shadow-sm">
              <Gamepad2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Mini Arcade
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">
                בחר משחק
              </div>
              <div className="mt-1 text-sm leading-6 text-slate-500">
                משחקי הכיס כאן נשארים מקוריים, חדים, ועם עוד הרפתקה חדשה של מקדש־יהלומים.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid gap-3 p-4">
          <button
            type="button"
            onClick={() => onStart('iron-desert')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-rose-100 bg-gradient-to-br from-rose-50 via-amber-50 to-orange-50 px-4 py-4 text-right shadow-[0_24px_48px_-34px_rgba(251,113,133,0.4)] transition hover:-translate-y-0.5 hover:border-rose-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-rose-200/35 via-amber-200/35 to-orange-200/35 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/90 text-rose-500 shadow-sm backdrop-blur">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Iron Desert</div>
                  <span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-rose-500 shadow-sm">
                    טנקים
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  קמפיין שריון כבד עם זירות, גלי אויבים, ירי אוטומטי ותמרון מדויק בתוך אבק, מלח ולילה בוער.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-rose-400 transition group-hover:text-rose-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('vault-runner')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-sky-100 bg-gradient-to-br from-sky-50 via-violet-50 to-cyan-50 px-4 py-4 text-right shadow-[0_24px_48px_-34px_rgba(56,189,248,0.34)] transition hover:-translate-y-0.5 hover:border-sky-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-sky-200/35 via-violet-200/35 to-cyan-200/35 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/90 text-sky-600 shadow-sm backdrop-blur">
                <Eye className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Vault Runner</div>
                  <span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-sky-600 shadow-sm">
                    חדירה
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  מבצע כספות עם מצלמות, לייזרים, כרטיסי גישה וליבות מידע שצריך לאסוף לפני היציאה.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-sky-400 transition group-hover:text-sky-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('rail-heist')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-amber-100 bg-gradient-to-br from-amber-50 via-rose-50 to-sky-50 px-4 py-4 text-right shadow-[0_24px_48px_-34px_rgba(249,115,22,0.4)] transition hover:-translate-y-0.5 hover:border-amber-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-amber-200/35 via-rose-200/35 to-sky-200/35 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/90 text-amber-600 shadow-sm backdrop-blur">
                <TrainFront className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Rail Heist</div>
                  <span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-amber-600 shadow-sm">
                    פרימיום
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  משחק רכבות בזמן אמת עם סוויצ׳ים, מסילות נפתלות, יעדים כפולים וקצב שמטפס משלב לשלב.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-amber-400 transition group-hover:text-amber-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('biome-snake')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-sky-100 bg-gradient-to-br from-sky-50 via-white to-cyan-50 px-4 py-4 text-right shadow-[0_22px_46px_-34px_rgba(59,130,246,0.34)] transition hover:-translate-y-0.5 hover:border-sky-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-sky-200/30 via-cyan-200/30 to-emerald-200/30 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/90 text-sky-600 shadow-sm backdrop-blur">
                <Zap className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Biome Snake</div>
                  <span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-sky-600 shadow-sm">
                    שלבים
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  סנייק עם רקעים שונים בכל שלב: שלג, מדבר, ג׳ונגל ואובסידיאן, עם קצב עולה ומכשולים.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-sky-400 transition group-hover:text-sky-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('temple-gem-quest')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-amber-100 bg-gradient-to-br from-amber-50 via-lime-50 to-emerald-50 px-4 py-4 text-right shadow-[0_22px_46px_-34px_rgba(234,179,8,0.34)] transition hover:-translate-y-0.5 hover:border-amber-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-amber-200/30 via-lime-200/30 to-emerald-200/30 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/90 text-amber-600 shadow-sm backdrop-blur">
                <Command className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Temple Gem Quest</div>
                  <span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-amber-600 shadow-sm">
                    חדש
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  הרפתקת מקדש מקורית עם יהלומים, סלעים נופלים, מפתחות, חיפושיות ושלבים קצרים אבל חכמים.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-amber-400 transition group-hover:text-amber-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('sky-ace')}
            className="group flex items-center gap-4 rounded-[1.6rem] border border-sky-100 bg-gradient-to-br from-sky-50 via-cyan-50 to-white px-4 py-4 text-right shadow-[0_18px_38px_-32px_rgba(14,165,233,0.3)] transition hover:-translate-y-0.5 hover:border-sky-200"
          >
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white text-sky-500 shadow-sm">
              <Gamepad2 className="h-7 w-7" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-800">Sky Ace</div>
              <div className="mt-1 text-xs leading-5 text-slate-500">
                הקרב האווירי הקיים: ירי אוטומטי, טבעות טעינה וגלי אויבים מהירים.
              </div>
            </div>
            <Play className="h-4 w-4 shrink-0 text-sky-400 transition group-hover:text-sky-600" />
          </button>

          <button
            type="button"
            onClick={() => onStart('sunset-sprint')}
            className="group relative overflow-hidden rounded-[1.75rem] border border-rose-100 bg-gradient-to-br from-rose-50 via-amber-50 to-indigo-50 px-4 py-4 text-right shadow-[0_22px_46px_-34px_rgba(244,114,182,0.42)] transition hover:-translate-y-0.5 hover:border-rose-200"
          >
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-r from-rose-200/35 via-amber-200/35 to-sky-200/35 blur-2xl" />
            <div className="relative flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white/85 text-rose-500 shadow-sm backdrop-blur">
                <Zap className="h-7 w-7" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">Sunset Sprint</div>
                  <span className="rounded-full bg-white/80 px-2.5 py-1 text-[10px] font-semibold text-rose-500 shadow-sm">
                    חדש
                  </span>
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  runner צבעוני בסגנון פלטפורמה: דאבל־ג׳אמפ, fever, קומבואים ומסלול שלא מפסיק.
                </div>
              </div>
              <Play className="h-4 w-4 shrink-0 text-rose-400 transition group-hover:text-rose-600" />
            </div>
          </button>

          <button
            type="button"
            onClick={() => onStart('sudoku-lab')}
            className="group flex items-center gap-4 rounded-[1.6rem] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50 px-4 py-4 text-right shadow-[0_18px_40px_-32px_rgba(168,85,247,0.3)] transition hover:-translate-y-0.5 hover:border-violet-200"
          >
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] bg-white text-violet-500 shadow-sm">
              <LayoutGrid className="h-7 w-7" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-800">Sudoku Lab</div>
                <span className="rounded-full bg-violet-100 px-2.5 py-1 text-[10px] font-semibold text-violet-600">
                  חידות קשות
                </span>
              </div>
              <div className="mt-1 text-xs leading-5 text-slate-500">
                סודוקו איכותי עם רמות Hard עד Code-AI, בחירת תא, פתקים, שגיאות וסשן אמיתי.
              </div>
            </div>
            <Play className="h-4 w-4 shrink-0 text-violet-400 transition group-hover:text-violet-600" />
          </button>
        </div>
      </div>
    </div>
  );
}

function RunnerGameDialog({
  isOpen,
  onClose,
  sessionActiveCount,
  sessionCompletionSignal,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionActiveCount: number;
  sessionCompletionSignal: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const stateRef = useRef<RunnerGameState>(createRunnerGameState());
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [distance, setDistance] = useState(0);
  const [combo, setCombo] = useState(0);
  const [health, setHealth] = useState(100);
  const [fever, setFever] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [topStatus, setTopStatus] = useState('Sunset Sprint');
  const feverActiveRef = useRef(false);

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setScore(snapshot.score);
    setDistance(Math.round(snapshot.distance));
    setCombo(snapshot.combo);
    setHealth(Math.max(0, Math.round(snapshot.player.health)));
    setFever(snapshot.feverTimer > 0 ? 100 : Math.round(snapshot.feverCharge));
    setSpeed(Math.round(snapshot.speed));
  });

  const resetGame = useEffectEvent(() => {
    stateRef.current = createRunnerGameState();
    feverActiveRef.current = false;
    setIsPaused(false);
    setIsGameOver(false);
    setNotice(null);
    setTopStatus(sessionActiveCount > 0 ? 'הסשן רץ ברקע' : 'ריצה חלקה');
    syncHud();
  });

  const triggerJump = useEffectEvent(() => {
    if (isPaused || isGameOver) {
      return;
    }
    const wasGrounded = stateRef.current.player.grounded;
    if (!triggerRunnerJump(stateRef.current)) {
      return;
    }
    setTopStatus(wasGrounded ? 'המריא' : 'דאבל־ג׳אמפ');
    syncHud();
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    resetGame();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
        event.preventDefault();
        triggerJump();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (sessionActiveCount > 0) {
      setTopStatus('הסשן רץ ברקע');
      return;
    }

    if (!isGameOver && !feverActiveRef.current) {
      setTopStatus('ריצה חלקה');
    }
  }, [isGameOver, isOpen, sessionActiveCount]);

  useEffect(() => {
    if (!isOpen || sessionCompletionSignal === 0) {
      return;
    }

    setNotice('הסשן הושלם, אפשר להמשיך לרוץ או לחזור לצ׳אט.');
    setTopStatus('הסשן הושלם');
    const timer = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timer);
  }, [isOpen, sessionCompletionSignal]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    let lastFrame = performance.now();
    const render = (frameTime: number) => {
      animationRef.current = window.requestAnimationFrame(render);
      if (isPaused || isGameOver) {
        drawRunnerGame(context, stateRef.current);
        return;
      }

      const delta = Math.min(0.033, (frameTime - lastFrame) / 1000);
      lastFrame = frameTime;
      const wasFeverActive = stateRef.current.feverTimer > 0;
      updateRunnerGame(stateRef.current, delta);
      drawRunnerGame(context, stateRef.current);
      syncHud();

      const isFeverActive = stateRef.current.feverTimer > 0;
      if (!wasFeverActive && isFeverActive) {
        feverActiveRef.current = true;
        setTopStatus('Fever פעיל');
        setNotice('Fever נדלק. עכשיו קופצים מהר יותר ושוברים מכשולים.');
      } else if (wasFeverActive && !isFeverActive) {
        feverActiveRef.current = false;
        if (sessionActiveCount > 0) {
          setTopStatus('הסשן רץ ברקע');
        } else {
          setTopStatus('ריצה חלקה');
        }
      }

      if (stateRef.current.player.health <= 0) {
        setIsGameOver(true);
        setTopStatus('נפלת. אפשר להפעיל מחדש.');
        setNotice('Game over. הפעל מחדש כדי לרדוף שוב אחרי הקומבו.');
      }
    };

    animationRef.current = window.requestAnimationFrame(render);
    return () => {
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isGameOver, isOpen, isPaused, sessionActiveCount]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close runner game"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-sm flex-col overflow-y-auto rounded-[2rem] border border-rose-100 bg-white text-slate-800 shadow-[0_30px_100px_-40px_rgba(244,114,182,0.38)]">
        <div className="border-b border-rose-100 bg-gradient-to-b from-rose-50 via-amber-50 to-white px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-rose-500 shadow-sm"
              title={topStatus}
            >
              <Zap className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPaused((current) => !current)}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-rose-50"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => resetGame()}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-rose-50"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-rose-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Score</div>
              <div className="mt-1 text-base font-semibold">{score}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Meters</div>
              <div className="mt-1 text-base font-semibold">{distance}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Combo</div>
              <div className="mt-1 text-base font-semibold">{combo}x</div>
            </div>
            <div className={cn('rounded-2xl bg-white px-3 py-2', fever >= 100 && 'bg-rose-50 text-rose-700')}>
              <div className={cn('text-slate-400', fever >= 100 && 'text-rose-400')}>Fever</div>
              <div className="mt-1 text-base font-semibold">{fever}%</div>
            </div>
            <div className={cn('rounded-2xl bg-white px-3 py-2', health <= 40 && 'bg-amber-50 text-amber-700')}>
              <div className={cn('text-slate-400', health <= 40 && 'text-amber-500')}>HP</div>
              <div className="mt-1 text-base font-semibold">{health}%</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Speed</div>
              <div className="mt-1 text-base font-semibold">{speed}</div>
            </div>
          </div>
        </div>

        <div className="relative px-4 pb-4 pt-4">
          <canvas
            ref={canvasRef}
            width={RUNNER_GAME_WIDTH}
            height={RUNNER_GAME_HEIGHT}
            onPointerDown={(event) => {
              event.preventDefault();
              triggerJump();
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              triggerJump();
            }}
            className="aspect-[360/520] h-auto max-h-[58dvh] w-full touch-none rounded-[1.5rem] border border-white/10 bg-slate-900"
          />
          {notice && (
            <div className="pointer-events-none absolute left-8 right-8 top-8 rounded-full bg-rose-400/90 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg">
              {notice}
            </div>
          )}
          {isGameOver && (
            <div className="absolute inset-8 flex items-center justify-center rounded-[1.5rem] bg-slate-950/60 backdrop-blur-sm">
              <div className="text-center text-white">
                <div className="text-xl font-bold">עוד סיבוב?</div>
                <div className="mt-2 text-sm text-white/75">נסה לרוץ רחוק יותר ולהדליק Fever מוקדם יותר.</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SUDOKU_DIFFICULTY_META: Record<SudokuPuzzleDifficulty, {
  label: string;
  accentClass: string;
  description: string;
}> = {
  hard: {
    label: 'Hard',
    accentClass: 'border-amber-200 bg-amber-50 text-amber-700',
    description: 'מאוזן וקשה.',
  },
  expert: {
    label: 'Expert',
    accentClass: 'border-sky-200 bg-sky-50 text-sky-700',
    description: 'חד ומדויק.',
  },
  fiendish: {
    label: 'Fiendish',
    accentClass: 'border-violet-200 bg-violet-50 text-violet-700',
    description: 'מעט רמזים.',
  },
  'code-ai': {
    label: 'Code-AI',
    accentClass: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
    description: 'הכי קיצוני.',
  },
};

function decodeSudokuGrid(serialized: string) {
  return serialized.split('').map((char) => Number(char));
}

function findFirstEditableSudokuCell(puzzle: number[]) {
  const firstEmpty = puzzle.findIndex((value) => value === 0);
  return firstEmpty >= 0 ? firstEmpty : null;
}

function getSudokuBox(index: number) {
  const row = Math.floor(index / 9);
  const col = index % 9;
  return Math.floor(row / 3) * 3 + Math.floor(col / 3);
}

function toggleSudokuNote(mask: number, digit: number) {
  const bit = 1 << digit;
  return mask & bit ? mask & ~bit : mask | bit;
}

function formatSudokuElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function SudokuDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [difficulty, setDifficulty] = useState<SudokuPuzzleDifficulty>('expert');
  const [puzzleCursorByLevel, setPuzzleCursorByLevel] = useState<Record<SudokuPuzzleDifficulty, number>>({
    hard: 0,
    expert: 0,
    fiendish: 0,
    'code-ai': 0,
  });
  const activePuzzles = SUDOKU_CATALOG[difficulty];
  const activePuzzle = activePuzzles[puzzleCursorByLevel[difficulty] % activePuzzles.length];
  const puzzleValues = useMemo(() => decodeSudokuGrid(activePuzzle.puzzle), [activePuzzle]);
  const solutionValues = useMemo(() => decodeSudokuGrid(activePuzzle.solution), [activePuzzle]);
  const [board, setBoard] = useState<number[]>(() => decodeSudokuGrid(activePuzzle.puzzle));
  const [notes, setNotes] = useState<number[]>(() => Array(81).fill(0));
  const [selectedCell, setSelectedCell] = useState<number | null>(findFirstEditableSudokuCell(decodeSudokuGrid(activePuzzle.puzzle)));
  const [noteMode, setNoteMode] = useState(false);
  const [mistakes, setMistakes] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isSolved, setIsSolved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const solvedEditableCells = useMemo(() => (
    board.reduce((count, value, index) => (
      puzzleValues[index] === 0 && value !== 0 && value === solutionValues[index] ? count + 1 : count
    ), 0)
  ), [board, puzzleValues, solutionValues]);
  const editableCells = useMemo(() => 81 - activePuzzle.clueCount, [activePuzzle]);
  const progressPercent = editableCells > 0 ? (solvedEditableCells / editableCells) * 100 : 100;
  const selectedValue = selectedCell !== null ? board[selectedCell] || puzzleValues[selectedCell] || null : null;

  const showNotice = useEffectEvent((message: string) => {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2200);
  });

  const resetPuzzle = useEffectEvent(() => {
    const nextPuzzleValues = decodeSudokuGrid(activePuzzle.puzzle);
    setBoard(nextPuzzleValues);
    setNotes(Array(81).fill(0));
    setSelectedCell(findFirstEditableSudokuCell(nextPuzzleValues));
    setNoteMode(false);
    setMistakes(0);
    setElapsedSeconds(0);
    setIsSolved(false);
    setNotice(null);
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    resetPuzzle();
  }, [isOpen, activePuzzle.id]);

  useEffect(() => {
    if (!isOpen || isSolved) {
      return;
    }

    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isOpen, isSolved]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const applyDigit = useEffectEvent((digit: number | null) => {
    if (selectedCell === null || isSolved || puzzleValues[selectedCell] !== 0) {
      return;
    }

    if (noteMode && digit !== null) {
      const nextNotes = [...notes];
      nextNotes[selectedCell] = toggleSudokuNote(nextNotes[selectedCell], digit);
      setNotes(nextNotes);
      return;
    }

    const nextBoard = [...board];
    nextBoard[selectedCell] = digit ?? 0;
    setBoard(nextBoard);

    const nextNotes = [...notes];
    nextNotes[selectedCell] = 0;
    setNotes(nextNotes);

    if (digit !== null && digit !== 0 && digit !== solutionValues[selectedCell]) {
      setMistakes((current) => current + 1);
      showNotice('זה לא המספר הנכון לתא הזה.');
      return;
    }

    if (digit !== null && digit !== 0 && nextBoard.every((value, index) => value === solutionValues[index])) {
      setIsSolved(true);
      showNotice('נפתר. זה היה חד.');
      return;
    }

    if (digit !== null && digit !== 0) {
      showNotice('מעולה. ממשיכים.');
    }
  });

  const cyclePuzzle = () => {
    setPuzzleCursorByLevel((current) => ({
      ...current,
      [difficulty]: (current[difficulty] + 1) % activePuzzles.length,
    }));
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close sudoku"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-[23rem] flex-col overflow-y-auto rounded-[1.8rem] border border-violet-100 bg-white shadow-[0_28px_90px_-36px_rgba(139,92,246,0.3)]">
        <div className="border-b border-violet-100 bg-gradient-to-b from-violet-50 via-white to-white px-4 py-3 text-right">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-violet-500 shadow-sm">
              <LayoutGrid className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Sudoku Lab
              </div>
              <div className="mt-0.5 text-base font-semibold text-slate-800">
                סודוקו בדרגות קושי אמיתיות
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {SUDOKU_DIFFICULTY_META[difficulty].description}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cyclePuzzle}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-violet-50"
                title="חידה חדשה"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-violet-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
            <div className="rounded-[1rem] bg-white px-2.5 py-2">
              <div className="text-slate-400">Progress</div>
              <div className="mt-0.5 text-sm font-semibold">{Math.round(progressPercent)}%</div>
            </div>
            <div className="rounded-[1rem] bg-white px-2.5 py-2">
              <div className="text-slate-400">Mistakes</div>
              <div className="mt-0.5 text-sm font-semibold">{mistakes}</div>
            </div>
            <div className="rounded-[1rem] bg-white px-2.5 py-2">
              <div className="text-slate-400">Time</div>
              <div className="mt-0.5 text-sm font-semibold">{formatSudokuElapsed(elapsedSeconds)}</div>
            </div>
            <div className="rounded-[1rem] bg-white px-2.5 py-2">
              <div className="text-slate-400">Clues</div>
              <div className="mt-0.5 text-sm font-semibold">{activePuzzle.clueCount}</div>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {(Object.keys(SUDOKU_CATALOG) as SudokuPuzzleDifficulty[]).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setDifficulty(level)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[10px] font-semibold transition',
                  difficulty === level
                    ? SUDOKU_DIFFICULTY_META[level].accentClass
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                )}
              >
                {SUDOKU_DIFFICULTY_META[level].label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative px-3.5 pb-3.5 pt-3.5">
          {notice && (
            <div className="pointer-events-none absolute left-7 right-7 top-4 z-10 rounded-full bg-violet-500/90 px-3 py-1.5 text-center text-xs font-semibold text-white shadow-lg">
              {notice}
            </div>
          )}

          <div className="rounded-[1.35rem] border border-violet-100 bg-violet-50/45 p-2.5">
            <div dir="ltr" className="grid grid-cols-9 overflow-hidden rounded-[1.2rem] border-2 border-slate-300 bg-slate-300">
              {board.map((value, index) => {
                const row = Math.floor(index / 9);
                const col = index % 9;
                const fixed = puzzleValues[index] !== 0;
                const wrong = value !== 0 && value !== solutionValues[index];
                const isSelected = selectedCell === index;
                const highlightBand = selectedCell !== null && (
                  Math.floor(selectedCell / 9) === row
                  || selectedCell % 9 === col
                  || getSudokuBox(selectedCell) === getSudokuBox(index)
                );
                const sameValue = selectedValue !== null && value !== 0 && value === selectedValue;
                const noteMask = notes[index];

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setSelectedCell(index)}
                    className={cn(
                      'relative aspect-square bg-white text-center text-[0.78rem] font-semibold text-slate-700 transition',
                      highlightBand && 'bg-slate-50',
                      sameValue && 'bg-sky-50',
                      fixed && 'text-slate-900',
                      !fixed && !wrong && value !== 0 && 'text-violet-600',
                      wrong && 'bg-rose-50 text-rose-600',
                      isSelected && 'bg-violet-100 text-violet-700 ring-2 ring-inset ring-violet-400'
                    )}
                    style={{
                      borderRight: col === 8 ? '0' : col % 3 === 2 ? '2px solid rgb(203 213 225)' : '1px solid rgb(226 232 240)',
                      borderBottom: row === 8 ? '0' : row % 3 === 2 ? '2px solid rgb(203 213 225)' : '1px solid rgb(226 232 240)',
                    }}
                  >
                    {value !== 0 ? (
                      <span>{value}</span>
                    ) : noteMask !== 0 ? (
                      <span className="grid h-full w-full grid-cols-3 grid-rows-3 p-[1px] text-[7px] font-medium text-slate-400">
                        {Array.from({ length: 9 }, (_, noteIndex) => {
                          const digit = noteIndex + 1;
                          const visible = Boolean(noteMask & (1 << digit));
                          return (
                            <span key={digit} className="flex items-center justify-center">
                              {visible ? digit : ''}
                            </span>
                          );
                        })}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 via-sky-400 to-fuchsia-400 transition-[width]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div className="mt-2.5 grid grid-cols-5 gap-1.5">
            {Array.from({ length: 9 }, (_, index) => {
              const digit = index + 1;
              return (
                <button
                  key={digit}
                  type="button"
                  onClick={() => applyDigit(digit)}
                  className="rounded-[0.9rem] border border-slate-200 bg-white px-0 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-violet-200 hover:bg-violet-50"
                >
                  {digit}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => applyDigit(null)}
              className="rounded-[0.9rem] border border-slate-200 bg-white px-2 py-2.5 text-[11px] font-semibold text-slate-500 transition hover:border-slate-300 hover:bg-slate-50"
            >
              מחק
            </button>
            <button
              type="button"
              onClick={() => setNoteMode((current) => !current)}
              className={cn(
                'rounded-[0.9rem] border px-2 py-2.5 text-[11px] font-semibold transition',
                noteMode
                  ? 'border-violet-200 bg-violet-50 text-violet-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:bg-slate-50'
              )}
            >
              פתקים
            </button>
            <button
              type="button"
              onClick={resetPuzzle}
              className="rounded-[0.9rem] border border-slate-200 bg-white px-2 py-2.5 text-[11px] font-semibold text-slate-500 transition hover:border-slate-300 hover:bg-slate-50"
            >
              אפס
            </button>
            <button
              type="button"
              onClick={cyclePuzzle}
              className="rounded-[0.9rem] border border-violet-200 bg-violet-50 px-2 py-2.5 text-[11px] font-semibold text-violet-700 transition hover:bg-violet-100"
            >
              חידה חדשה
            </button>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-3 text-[10px] text-slate-400">
            <span>R {activePuzzle.rating}</span>
            <span>N {activePuzzle.searchNodes}</span>
            <span>{isSolved ? 'נפתר' : `${solvedEditableCells}/${editableCells} הושלמו`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopicManagerDialog({
  session,
  topics,
  isLoading,
  error,
  customSessionTitle,
  isSavingTitle,
  newTopicName,
  newTopicIcon,
  newTopicColorKey,
  onClose,
  onAssignTopic,
  onSaveSessionTitle,
  onResetSessionTitle,
  onChangeCustomSessionTitle,
  onCreateTopic,
  onChangeName,
  onChangeIcon,
  onChangeColorKey,
}: {
  session: CodexSessionSummary;
  topics: CodexSessionTopic[];
  isLoading: boolean;
  error: string | null;
  customSessionTitle: string;
  isSavingTitle: boolean;
  newTopicName: string;
  newTopicIcon: string;
  newTopicColorKey: string;
  onClose: () => void;
  onAssignTopic: (topicId: string | null) => void;
  onSaveSessionTitle: () => void;
  onResetSessionTitle: () => void;
  onChangeCustomSessionTitle: (value: string) => void;
  onCreateTopic: () => void;
  onChangeName: (value: string) => void;
  onChangeIcon: (value: string) => void;
  onChangeColorKey: (value: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-[76] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close topic manager"
      />
      <div className="relative z-10 flex w-full max-w-2xl max-h-[82dvh] flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
              <Tag className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Topic
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">תיוג שיחה לנושא</div>
              <div className="mt-1 truncate text-sm text-slate-500">
                {session.title}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {error && (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 p-4">
            <div className="text-sm font-semibold text-slate-800">שם השיחה</div>
            <div className="mt-1 text-xs text-slate-500">
              שם ידני נשמר בשרת ונשאר גם אחרי reload.
            </div>
            <input
              value={customSessionTitle}
              onChange={(event) => onChangeCustomSessionTitle(event.target.value)}
              placeholder="כתוב כאן שם חופשי לשיחה"
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700 outline-none transition focus:border-indigo-300"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onSaveSessionTitle}
                disabled={isSavingTitle}
                className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingTitle ? 'שומר...' : 'שמור שם'}
              </button>
              <button
                type="button"
                onClick={onResetSessionTitle}
                disabled={isSavingTitle}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                חזור לשם אוטומטי
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => onAssignTopic(null)}
              className="flex w-full items-center justify-between rounded-[1.25rem] border border-slate-200 bg-white px-4 py-3 text-right transition hover:bg-slate-50"
            >
              <span className="text-sm font-medium text-slate-700">ללא נושא</span>
              <span className="text-xs text-slate-400">הסר תיוג</span>
            </button>

            {isLoading ? (
              <div className="flex items-center justify-center rounded-[1.25rem] border border-slate-100 bg-slate-50/70 px-4 py-6 text-sm text-slate-500">
                <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                טוען נושאים...
              </div>
            ) : (
              topics.map((topic) => {
                const colors = getTopicColorPreset(topic.colorKey);
                return (
                  <button
                    key={topic.id}
                    type="button"
                    onClick={() => onAssignTopic(topic.id)}
                    className="flex w-full items-center justify-between rounded-[1.25rem] border px-4 py-3 text-right transition hover:opacity-90"
                    style={{
                      backgroundColor: colors.bg,
                      color: colors.text,
                      borderColor: colors.border,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span>{topic.icon}</span>
                      <span className="text-sm font-medium">{topic.name}</span>
                    </div>
                    <span className="text-xs opacity-75">{topic.cwd === session.cwd ? 'תיקייה זו' : topic.cwd}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 p-4">
            <div className="text-sm font-semibold text-slate-800">נושא חדש</div>
            <input
              value={newTopicName}
              onChange={(event) => onChangeName(event.target.value)}
              placeholder="שם הנושא"
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700 outline-none transition focus:border-indigo-300"
            />

            <div className="mt-3">
              <div className="mb-2 text-xs font-medium text-slate-500">אייקון</div>
              <div className="flex flex-wrap gap-2">
                {TOPIC_ICON_PRESETS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    onClick={() => onChangeIcon(icon)}
                    className={cn(
                      'rounded-full border px-3 py-2 text-lg transition',
                      newTopicIcon === icon
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white'
                    )}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-2 text-xs font-medium text-slate-500">צבע פסטלי</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(TOPIC_COLOR_PRESETS).map(([colorKey, colors]) => (
                  <button
                    key={colorKey}
                    type="button"
                    onClick={() => onChangeColorKey(colorKey)}
                    className={cn(
                      'h-9 w-9 rounded-full border-2 transition',
                      newTopicColorKey === colorKey ? 'border-slate-900' : 'border-white'
                    )}
                    style={{ backgroundColor: colors.bg }}
                    title={colorKey}
                  />
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={onCreateTopic}
              className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              צור נושא ותג שיחה
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CodexMobileApp() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [profiles, setProfiles] = useState<CodexProfile[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readWorkspaceMode);
  const [profileId, setProfileId] = useState('');
  const [sessions, setSessions] = useState<CodexSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<CodexSessionDetail | null>(null);
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [devicePassword, setDevicePassword] = useState('');
  const [isUnlockingDevice, setIsUnlockingDevice] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const [isCheckingAccess, setIsCheckingAccess] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isContinuingAbortedSession, setIsContinuingAbortedSession] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isHeaderActionsOpen, setIsHeaderActionsOpen] = useState(false);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isReasoningPickerOpen, setIsReasoningPickerOpen] = useState(false);
  const [isRateLimitOpen, setIsRateLimitOpen] = useState(false);
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [isRateLimitLoading, setIsRateLimitLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [draftCwd, setDraftCwd] = useState<string | null>(null);
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [folderBrowser, setFolderBrowser] = useState<CodexFolderBrowseResult | null>(null);
  const [isFolderBrowserLoading, setIsFolderBrowserLoading] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState<string | null>(null);
  const [folderPathInput, setFolderPathInput] = useState('');
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const [fileTreeBrowser, setFileTreeBrowser] = useState<CodexFileTreeBrowseResult | null>(null);
  const [fileTreeNodes, setFileTreeNodes] = useState<Record<string, CodexFileTreeBrowseResult>>({});
  const [fileTreeExpandedPaths, setFileTreeExpandedPaths] = useState<Record<string, boolean>>({});
  const [fileTreeLoadingPaths, setFileTreeLoadingPaths] = useState<Record<string, boolean>>({});
  const [fileTreeError, setFileTreeError] = useState<string | null>(null);
  const [fileTreePathInput, setFileTreePathInput] = useState('');
  const [fileTreeFilter, setFileTreeFilter] = useState('');
  const [isGamePickerOpen, setIsGamePickerOpen] = useState(false);
  const [isGameOpen, setIsGameOpen] = useState(false);
  const [isRunnerGameOpen, setIsRunnerGameOpen] = useState(false);
  const [isSudokuOpen, setIsSudokuOpen] = useState(false);
  const [isTempleGemQuestOpen, setIsTempleGemQuestOpen] = useState(false);
  const [isBiomeSnakeOpen, setIsBiomeSnakeOpen] = useState(false);
  const [isRailHeistOpen, setIsRailHeistOpen] = useState(false);
  const [isIronDesertOpen, setIsIronDesertOpen] = useState(false);
  const [isVaultRunnerOpen, setIsVaultRunnerOpen] = useState(false);
  const [gameSessionCompletionSignal, setGameSessionCompletionSignal] = useState(0);
  const [forkDraftContext, setForkDraftContext] = useState<ForkDraftContext | null>(null);
  const [sessionInstruction, setSessionInstruction] = useState<string | null>(null);
  const [instructionDraft, setInstructionDraft] = useState('');
  const [isInstructionDialogOpen, setIsInstructionDialogOpen] = useState(false);
  const [isInstructionLoading, setIsInstructionLoading] = useState(false);
  const [isInstructionSaving, setIsInstructionSaving] = useState(false);
  const [scheduleType, setScheduleType] = useState<'once' | 'recurring'>('once');
  const [recurringFreq, setRecurringFreq] = useState<'daily' | 'weekly'>('daily');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [queueItems, setQueueItems] = useState<CodexQueueServerItem[]>([]);
  const [availableModels, setAvailableModels] = useState<CodexModelOption[]>([]);
  const [modelPermissionSnapshot, setModelPermissionSnapshot] = useState<CodexPermissionSnapshotResponse | null>(null);
  const [rateLimitSnapshot, setRateLimitSnapshot] = useState<CodexRateLimitSnapshotResponse | null>(null);
  const [selectedModelSlug, setSelectedModelSlug] = useState<string | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState('');
  const [draftConversationKey, setDraftConversationKey] = useState(createDraftConversationKey);
  const [isDraftConversation, setIsDraftConversation] = useState(true);
  const [activeToolEntry, setActiveToolEntry] = useState<CodexTimelineEntry | null>(null);
  const [isSessionChangeDialogOpen, setIsSessionChangeDialogOpen] = useState(false);
  const [activeSessionChangeRecord, setActiveSessionChangeRecord] = useState<SessionChangeRecordResponse | null>(null);
  const [activeSessionChangeEntryId, setActiveSessionChangeEntryId] = useState<string | null>(null);
  const [activeSessionChangeFileId, setActiveSessionChangeFileId] = useState<string | null>(null);
  const [isSessionChangeLoading, setIsSessionChangeLoading] = useState(false);
  const [topicSession, setTopicSession] = useState<CodexSessionSummary | null>(null);
  const [folderTopics, setFolderTopics] = useState<CodexSessionTopic[]>([]);
  const [isTopicLoading, setIsTopicLoading] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [customSessionTitle, setCustomSessionTitle] = useState('');
  const [isSavingSessionTitle, setIsSavingSessionTitle] = useState(false);
  const [transferringEntryId, setTransferringEntryId] = useState<string | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const [pendingDeleteTurn, setPendingDeleteTurn] = useState<{
    entryId: string;
    shouldStopRunningTurn: boolean;
  } | null>(null);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicIcon, setNewTopicIcon] = useState(TOPIC_ICON_PRESETS[0]);
  const [newTopicColorKey, setNewTopicColorKey] = useState<keyof typeof TOPIC_COLOR_PRESETS>('sky');
  const [activeFilePreview, setActiveFilePreview] = useState<CodexFilePreview | null>(null);
  const [activeFileMatches, setActiveFileMatches] = useState<CodexFileMatch[]>([]);
  const [activeFileMatchesQuery, setActiveFileMatchesQuery] = useState('');
  const [activeFileMatchesLineNumber, setActiveFileMatchesLineNumber] = useState<number | null>(null);
  const [isFilePreviewLoading, setIsFilePreviewLoading] = useState(false);
  const [isFileDownloadLoading, setIsFileDownloadLoading] = useState(false);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [isDocumentVisible, setIsDocumentVisible] = useState(isDocumentCurrentlyVisible);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallHelpOpen, setIsInstallHelpOpen] = useState(false);
  const [isStandaloneMode, setIsStandaloneMode] = useState(isStandaloneDisplayMode);
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');
  const [sessionWindowSize, setSessionWindowSize] = useState(INITIAL_TIMELINE_WINDOW_SIZE);
  const [isFullTimelineLoaded, setIsFullTimelineLoaded] = useState(false);
  const [isFullTimelineLoading, setIsFullTimelineLoading] = useState(false);
  const [fullTimelineLoadPercent, setFullTimelineLoadPercent] = useState(0);
  const [isTranscriptCollapsed, setIsTranscriptCollapsed] = useState(false);
  const [isPendingQueueSectionCollapsed, setIsPendingQueueSectionCollapsed] = useState(true);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});
  const [thinkingPulseIndex, setThinkingPulseIndex] = useState(0);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const pollInFlightRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const sendDedupRef = useRef<{ fingerprint: string; requestId: string; expiresAt: number } | null>(null);
  const lastSessionsPollAtRef = useRef(0);
  const lastSessionDetailPollAtRef = useRef(0);
  const latestSessionLoadTokenRef = useRef(0);
  const latestFullTimelineLoadTokenRef = useRef(0);
  const latestInstructionLoadTokenRef = useRef(0);
  const latestModelCatalogLoadTokenRef = useRef(0);
  const latestRateLimitLoadTokenRef = useRef(0);
  const currentSessionActiveCountRef = useRef(0);
  const currentSessionActivityKeyRef = useRef('');
  const activeProfileRef = useRef(profileId);
  const activeSelectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const isTranscriptNearBottomRef = useRef(true);
  const lastTranscriptSignatureRef = useRef('');
  const transcriptViewportSnapshotRef = useRef({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const deferredSearch = useDeferredValue(search);
  const draftSessionMapRef = useRef<Record<string, string>>({});
  const draftQueueItemIdsRef = useRef<Record<string, string[]>>({});
  const folderBackStackRef = useRef<string[]>([]);
  const folderForwardStackRef = useRef<string[]>([]);
  const browserTimeZone = getBrowserTimeZone();
  const isIosInstallFlow = isIosInstallableDevice() && !isStandaloneMode;
  const visibleProfiles = useMemo(
    () => filterProfilesForMode(profiles, workspaceMode),
    [profiles, workspaceMode]
  );
  const currentQueueKey = selectedSessionId || draftConversationKey;
  const draftSidebarSessionId = forkDraftContext ? toDraftSessionId(draftConversationKey) : null;
  const activeQueueCount = queueItems.filter(isQueueItemActive).length;
  const effectiveDraftCwd = draftCwd || null;
  const activeSessionCwd = selectedSession?.cwd || null;
  const currentProfile = visibleProfiles.find((profile) => profile.id === profileId) || null;
  const selectedProfileWorkspaceCwd = currentProfile?.workspaceCwd || null;
  const activeComposerCwd = selectedSessionId ? activeSessionCwd : (effectiveDraftCwd || selectedProfileWorkspaceCwd);
  const selectedConversationId = selectedSessionId || (isDraftConversation ? draftSidebarSessionId : null);
  const isMobileEnterBehavior = shouldUseMobileEnterBehavior();
  const activeSessionIds = useMemo(() => new Set(
    queueItems
      .filter(isQueueItemActive)
      .flatMap((item) => [item.sessionId, item.queueKey])
      .filter((value): value is string => Boolean(value))
  ), [queueItems]);
  const currentSessionActiveQueueCount = useMemo(() => queueItems.filter((item) => {
    if (!isQueueItemActive(item)) {
      return false;
    }

    if (selectedSessionId) {
      return item.sessionId === selectedSessionId || item.queueKey === selectedSessionId;
    }

    return item.queueKey === currentQueueKey;
  }).length, [currentQueueKey, queueItems, selectedSessionId]);
  const shouldPausePolling = isSidebarOpen
    || (isDraftConversation && currentSessionActiveQueueCount === 0)
    || isFolderPickerOpen
    || isFileTreeOpen
    || isFullTimelineLoading
    || !isDocumentVisible;
  const visibleQueueItems = useMemo(() => sortQueueItemsForDisplay(queueItems.filter((item) => {
    if (!shouldDisplayQueueItem(item)) {
      return false;
    }

    if (selectedSessionId) {
      return item.sessionId === selectedSessionId || item.queueKey === selectedSessionId;
    }

    return item.queueKey === currentQueueKey;
  })), [currentQueueKey, queueItems, selectedSessionId]);
  const collapsedQueueItems = visibleQueueItems;
  const collapsedQueueStatusSummary = useMemo(() => {
    const statusOrder: CodexQueueServerItem['status'][] = [
      'queued',
      'scheduled',
      'running',
      'cancelling',
      'failed',
      'cancelled',
    ];

    return statusOrder
      .map((status) => ({
        status,
        count: collapsedQueueItems.filter((item) => item.status === status).length,
        label: getQueueStatusSummaryLabel(status),
      }))
      .filter((entry) => entry.count > 0);
  }, [collapsedQueueItems]);
  const totalTimelineLength = selectedSession?.totalTimelineEntries
    || selectedSession?.timeline.length
    || forkDraftContext?.timeline.length
    || 0;
  const renderedTimeline = selectedSession?.timeline || forkDraftContext?.timeline || [];
  const displayTimeline = useMemo(
    () => (isTranscriptCollapsed ? collapseTimelineForDisplay(renderedTimeline) : renderedTimeline),
    [isTranscriptCollapsed, renderedTimeline]
  );
  const hiddenTimelineCount = Math.max(0, totalTimelineLength - renderedTimeline.length);
  const timelineBlocks = useMemo(
    () => buildTimelineRenderBlocks(displayTimeline),
    [displayTimeline]
  );
  const transcriptSignature = useMemo(() => {
    const timelineTail = renderedTimeline
      .slice(-8)
      .map((entry) => `${entry.id}:${entry.entryType}:${entry.timestamp}`)
      .join('|');

    return [
      selectedSessionId || draftConversationKey,
      forkDraftContext?.sourceSessionId || '',
      forkDraftContext?.forkEntryId || '',
      totalTimelineLength,
      timelineTail,
      isSending ? 'sending' : 'idle',
    ].join('::');
  }, [draftConversationKey, forkDraftContext?.forkEntryId, forkDraftContext?.sourceSessionId, isSending, renderedTimeline, selectedSessionId, totalTimelineLength]);

  useEffect(() => {
    setIsPendingQueueSectionCollapsed(true);
    setExpandedToolGroups({});
  }, [currentQueueKey, selectedSessionId]);
  useEffect(() => {
    if (currentSessionActiveQueueCount <= 0) {
      setThinkingPulseIndex(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setThinkingPulseIndex((current) => (current + 1) % 6);
    }, 700);

    return () => window.clearInterval(intervalId);
  }, [currentSessionActiveQueueCount]);
  const pollUpdatesEvent = useEffectEvent(() => {
    void pollUpdates();
  });

  const filteredSessions = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return sessions.filter((session) => {
      if (Boolean(session.hidden) !== showArchived) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = `${session.title}\n${session.preview}\n${session.id}\n${session.cwd || ''}\n${session.topic?.name || ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [
    deferredSearch,
    sessions,
    showArchived,
  ]);
  const groupedSessions = useMemo(
    () => buildSessionFolderGroups(filteredSessions, selectedProfileWorkspaceCwd),
    [filteredSessions, selectedProfileWorkspaceCwd]
  );

  useEffect(() => {
    const previousTitle = document.title;
    const providerTitle = currentProfile ? getProviderDisplayLabel(currentProfile.provider) : APP_DISPLAY_NAME;
    document.title = providerTitle === APP_DISPLAY_NAME
      ? APP_DISPLAY_NAME
      : `${providerTitle} • ${APP_DISPLAY_NAME}`;
    return () => {
      document.title = previousTitle;
    };
  }, [currentProfile]);

  useEffect(() => {
    recordCodexBreadcrumb('codex-ui-mounted');
    return installCodexGlobalCrashHandlers();
  }, []);

  useEffect(() => {
    if (currentSessionActivityKeyRef.current !== currentQueueKey) {
      currentSessionActivityKeyRef.current = currentQueueKey;
      currentSessionActiveCountRef.current = currentSessionActiveQueueCount;
      return;
    }

    const previousCount = currentSessionActiveCountRef.current;
    if (previousCount > 0 && currentSessionActiveQueueCount === 0) {
      setGameSessionCompletionSignal((current) => current + 1);
    }
    currentSessionActiveCountRef.current = currentSessionActiveQueueCount;
  }, [currentQueueKey, currentSessionActiveQueueCount]);

  useEffect(() => {
    const installMedia = window.matchMedia('(display-mode: standalone)');
    const updateStandaloneMode = () => {
      setIsStandaloneMode(isStandaloneDisplayMode());
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
      recordCodexBreadcrumb('pwa-install-ready');
    };
    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setIsInstallHelpOpen(false);
      updateStandaloneMode();
      recordCodexBreadcrumb('pwa-installed');
    };

    updateStandaloneMode();
    installMedia.addEventListener('change', updateStandaloneMode);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      installMedia.removeEventListener('change', updateStandaloneMode);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    activeProfileRef.current = profileId;
  }, [profileId]);

  useEffect(() => {
    activeSelectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    setCodexRuntimeContext({
      profileId,
      selectedSessionId,
      queueKey: currentQueueKey,
      isDraftConversation,
      isSidebarOpen,
      isScheduleOpen,
      sessionCount: sessions.length,
      visibleQueueCount: visibleQueueItems.length,
      activeQueueCount,
      timelineLength: totalTimelineLength,
      renderedTimelineLength: renderedTimeline.length,
      searchQuery: search,
    });
  }, [
    activeQueueCount,
    currentQueueKey,
    effectiveDraftCwd,
    isDraftConversation,
    isScheduleOpen,
    isSidebarOpen,
    profileId,
    renderedTimeline.length,
    search,
    selectedSessionId,
    sessions.length,
    totalTimelineLength,
    visibleQueueItems.length,
  ]);

  useEffect(() => {
    setSessionWindowSize(INITIAL_TIMELINE_WINDOW_SIZE);
    setIsFullTimelineLoaded(false);
  }, [selectedSessionId]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsDocumentVisible(isDocumentCurrentlyVisible());
    };

    handleVisibilityChange();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    window.addEventListener('blur', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
      window.removeEventListener('blur', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const viewport = mainScrollRef.current;
    if (!viewport) {
      return;
    }

    const updateViewportScrollState = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      isTranscriptNearBottomRef.current = distanceFromBottom < 180;
      transcriptViewportSnapshotRef.current = {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
    };

    updateViewportScrollState();
    viewport.addEventListener('scroll', updateViewportScrollState, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', updateViewportScrollState);
    };
  }, []);

  useEffect(() => {
    const viewport = mainScrollRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (isTranscriptNearBottomRef.current) {
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      }

      transcriptViewportSnapshotRef.current = {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
    });

    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    isTranscriptNearBottomRef.current = true;
    lastTranscriptSignatureRef.current = '';
    transcriptViewportSnapshotRef.current = {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    };
  }, [draftConversationKey, selectedSessionId]);

  function scrollTranscriptViewportToBottom(behavior: ScrollBehavior = 'auto') {
    const viewport = mainScrollRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }

  useLayoutEffect(() => {
    const viewport = mainScrollRef.current;
    if (!viewport || lastTranscriptSignatureRef.current === transcriptSignature) {
      return;
    }

    const shouldAutoScroll = (
      !lastTranscriptSignatureRef.current
      || isTranscriptNearBottomRef.current
    );

    lastTranscriptSignatureRef.current = transcriptSignature;

    if (!shouldAutoScroll) {
      transcriptViewportSnapshotRef.current = {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
      };
      return;
    }

    scrollTranscriptViewportToBottom('auto');
    transcriptViewportSnapshotRef.current = {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    };
  }, [transcriptSignature]);

  function scrollTranscriptToTop() {
    isTranscriptNearBottomRef.current = false;
    mainScrollRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }

  function scrollTranscriptToBottom() {
    isTranscriptNearBottomRef.current = true;
    scrollTranscriptViewportToBottom('smooth');
  }

  useEffect(() => {
    if (!isSidebarOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isSidebarOpen]);

  useEffect(() => {
    void loadAuthStatus();
  }, []);

  useEffect(() => {
    if (!authStatus?.authenticated || authStatus.deviceUnlocked === false) {
      return;
    }

    void loadProfiles();
  }, [authStatus?.authenticated, authStatus?.deviceUnlocked]);

  useEffect(() => {
    if (!profileId) {
      return;
    }

    void bootstrapProfile(profileId);
  }, [profileId]);

  useEffect(() => {
    if (!profileId || shouldPausePolling) {
      return;
    }

    const interval = window.setInterval(() => {
      pollUpdatesEvent();
    }, 4000);

    return () => window.clearInterval(interval);
  }, [profileId, pollUpdatesEvent, shouldPausePolling]);

  useEffect(() => {
    if (!profileId || shouldPausePolling) {
      return;
    }

    pollUpdatesEvent();
  }, [profileId, pollUpdatesEvent, shouldPausePolling]);

  async function loadAuthStatus(options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;

    if (!silent) {
      setError(null);
    }

    if (!isBooting) {
      setIsCheckingAccess(true);
    }

    try {
      const data = await fetchJson<AuthStatus>('/api/codex/auth/status');
      setAuthStatus(data);
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'auth-status-load-failed',
        message: loadError.message || 'Failed to load Codex access state',
      });
      if (!silent) {
        setError(loadError.message || 'Failed to load Codex access state');
      }
    } finally {
      setIsBooting(false);
      setIsCheckingAccess(false);
    }
  }

  async function handleDeviceUnlock() {
    if (!devicePassword.trim()) {
      setError('הכנס את סיסמת הניהול.');
      return;
    }

    setIsUnlockingDevice(true);
    setError(null);

    try {
      await fetchJson('/api/codex/device-unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: devicePassword,
        }),
      });
      setDevicePassword('');
      await loadAuthStatus({ silent: true });
    } catch (unlockError: any) {
      setError(unlockError.message || 'Failed to unlock this device');
    } finally {
      setIsUnlockingDevice(false);
    }
  }

  async function handleLogout() {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setError(null);

    try {
      await fetchJson('/api/codex/logout', {
        method: 'POST',
      });
      setIsSidebarOpen(false);
      setIsHeaderActionsOpen(false);
      setDevicePassword('');
      await loadAuthStatus({ silent: true });
    } catch (logoutError: any) {
      setError(logoutError.message || 'Failed to log out of Codex');
    } finally {
      setIsLoggingOut(false);
    }
  }

  async function loadProfiles() {
    try {
      const data = await fetchJson<{ profiles: CodexProfile[] }>('/api/codex/profiles');
      setProfiles(data.profiles);
      const modeProfiles = filterProfilesForMode(data.profiles, workspaceMode);
      const currentStillAvailable = profileId
        ? modeProfiles.find((profile) => profile.id === profileId) || null
        : null;
      const preferred = currentStillAvailable
        || resolveDefaultProfileForWorkspaceMode(data.profiles, workspaceMode)
        || modeProfiles[0];
      if (preferred) {
        setProfileId(preferred.id);
        setDraftCwd((current) => currentStillAvailable && current ? current : preferred.workspaceCwd);
      }
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'profiles-load-failed',
        message: loadError.message || 'Failed to load Codex profiles',
      });
      setError(loadError.message || 'Failed to load Codex profiles');
    }
  }

  async function loadFolderPicker(targetPath?: string | null, options?: { pushHistory?: boolean; resetHistory?: boolean }) {
    if (!profileId) {
      return;
    }

    const nextTargetPath = targetPath || effectiveDraftCwd || selectedSession?.cwd || currentProfile?.workspaceCwd || null;
    setIsFolderBrowserLoading(true);
    setFolderBrowserError(null);

    try {
      const data = await fetchFolderBrowser(profileId, nextTargetPath);
      setFolderPathInput(data.currentPath);
      setFolderBrowser((current) => {
        if (options?.resetHistory) {
          folderBackStackRef.current = [];
          folderForwardStackRef.current = [];
        } else if (options?.pushHistory && current?.currentPath && current.currentPath !== data.currentPath) {
          folderBackStackRef.current = [...folderBackStackRef.current, current.currentPath];
          folderForwardStackRef.current = [];
        }

        return data;
      });
    } catch (folderError: any) {
      setFolderBrowserError(folderError.message || 'Failed to browse folders');
    } finally {
      setIsFolderBrowserLoading(false);
    }
  }

  function openFolderPicker() {
    setIsFolderPickerOpen(true);
    setFolderPathInput(effectiveDraftCwd || selectedSession?.cwd || currentProfile?.workspaceCwd || '');
    void loadFolderPicker(undefined, { resetHistory: true });
  }

  function handleChooseFolderFromSidebar() {
    handleNewConversation(currentProfile?.workspaceCwd || selectedProfileWorkspaceCwd || null);
    setTimeout(() => {
      openFolderPicker();
    }, 0);
  }

  function navigateFolderPickerBack() {
    const previousPath = folderBackStackRef.current.at(-1);
    if (!previousPath) {
      return;
    }

    if (folderBrowser?.currentPath) {
      folderForwardStackRef.current = [...folderForwardStackRef.current, folderBrowser.currentPath];
    }
    folderBackStackRef.current = folderBackStackRef.current.slice(0, -1);
    void loadFolderPicker(previousPath);
  }

  function navigateFolderPickerForward() {
    const nextPath = folderForwardStackRef.current.at(-1);
    if (!nextPath) {
      return;
    }

    if (folderBrowser?.currentPath) {
      folderBackStackRef.current = [...folderBackStackRef.current, folderBrowser.currentPath];
    }
    folderForwardStackRef.current = folderForwardStackRef.current.slice(0, -1);
    void loadFolderPicker(nextPath);
  }

  function selectFolderForDraft(folderPath: string) {
    setDraftCwd(folderPath);
    setIsFolderPickerOpen(false);
  }

  function openFolderPathFromInput() {
    const nextPath = folderPathInput.trim();
    if (!nextPath) {
      setFolderBrowserError('הכנס נתיב לפתיחה.');
      return;
    }

    void loadFolderPicker(nextPath, { pushHistory: true });
  }

  async function loadFileTree(targetPath?: string | null, options?: { replaceRoot?: boolean; expandRoot?: boolean }) {
    if (!profileId) {
      return;
    }

    const nextTargetPath = targetPath || activeComposerCwd || currentProfile?.workspaceCwd || null;
    if (!nextTargetPath) {
      setFileTreeError('לא נמצאה תיקייה פעילה לעץ הקבצים.');
      return;
    }

    setFileTreeLoadingPaths((current) => ({
      ...current,
      [nextTargetPath]: true,
    }));
    setFileTreeError(null);

    try {
      const data = await fetchFileTreeBrowser(profileId, nextTargetPath);
      setFileTreePathInput(data.currentPath);
      setFileTreeNodes((current) => ({
        ...current,
        [data.currentPath]: data,
      }));
      if (options?.replaceRoot ?? true) {
        setFileTreeBrowser(data);
      }
      if (options?.expandRoot) {
        setFileTreeExpandedPaths((current) => ({
          ...current,
          [data.currentPath]: true,
        }));
      }
    } catch (treeError: any) {
      setFileTreeError(treeError.message || 'Failed to load file tree');
    } finally {
      setFileTreeLoadingPaths((current) => {
        const next = { ...current };
        delete next[nextTargetPath];
        return next;
      });
    }
  }

  function openFileTree() {
    setIsHeaderActionsOpen(false);
    setIsSidebarOpen(false);
    setIsFileTreeOpen(true);
    setFileTreeFilter('');
    setFileTreePathInput(activeComposerCwd || currentProfile?.workspaceCwd || '');
    setFileTreeNodes({});
    setFileTreeExpandedPaths({});
    void loadFileTree(undefined, { replaceRoot: true, expandRoot: true });
  }

  function openMiniGame() {
    setIsHeaderActionsOpen(false);
    setIsSidebarOpen(false);
    setIsGamePickerOpen(true);
  }

  const closeRailHeistDialog = useEffectEvent(() => {
    setIsRailHeistOpen(false);
  });

  const closeIronDesertDialog = useEffectEvent(() => {
    setIsIronDesertOpen(false);
  });

  const closeVaultRunnerDialog = useEffectEvent(() => {
    setIsVaultRunnerOpen(false);
  });

  function startMiniGame(game: 'sky-ace' | 'sunset-sprint' | 'sudoku-lab' | 'temple-gem-quest' | 'biome-snake' | 'rail-heist' | 'iron-desert' | 'vault-runner') {
    setIsGamePickerOpen(false);
    setIsGameOpen(false);
    setIsRunnerGameOpen(false);
    setIsSudokuOpen(false);
    setIsTempleGemQuestOpen(false);
    setIsBiomeSnakeOpen(false);
    setIsRailHeistOpen(false);
    setIsIronDesertOpen(false);
    setIsVaultRunnerOpen(false);
    if (game === 'sunset-sprint') {
      setIsRunnerGameOpen(true);
      return;
    }
    if (game === 'sudoku-lab') {
      setIsSudokuOpen(true);
      return;
    }
    if (game === 'temple-gem-quest') {
      setIsTempleGemQuestOpen(true);
      return;
    }
    if (game === 'biome-snake') {
      setIsBiomeSnakeOpen(true);
      return;
    }
    if (game === 'rail-heist') {
      setIsRailHeistOpen(true);
      return;
    }
    if (game === 'iron-desert') {
      setIsIronDesertOpen(true);
      return;
    }
    if (game === 'vault-runner') {
      setIsVaultRunnerOpen(true);
      return;
    }

    setIsGameOpen(true);
  }

  function openFileTreePathFromInput() {
    const nextPath = fileTreePathInput.trim();
    if (!nextPath) {
      setFileTreeError('הכנס נתיב לפתיחה.');
      return;
    }

    setFileTreeNodes({});
    setFileTreeExpandedPaths({});
    void loadFileTree(nextPath, { replaceRoot: true, expandRoot: true });
  }

  function toggleFileTreeDirectory(directoryPath: string) {
    if (fileTreeExpandedPaths[directoryPath]) {
      setFileTreeExpandedPaths((current) => ({
        ...current,
        [directoryPath]: false,
      }));
      return;
    }

    if (!fileTreeNodes[directoryPath]) {
      void loadFileTree(directoryPath, { replaceRoot: false, expandRoot: false }).then(() => {
        setFileTreeExpandedPaths((current) => ({
          ...current,
          [directoryPath]: true,
        }));
      });
      return;
    }

    setFileTreeExpandedPaths((current) => ({
      ...current,
      [directoryPath]: true,
    }));
  }

  async function loadSessionsOnly(nextProfileId = profileId, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;

    if (!silent) {
      setIsRefreshing(true);
      setError(null);
    }

    try {
      const data = await fetchJson<{ sessions: CodexSessionSummary[] }>(
        `/api/codex/sessions?profile=${encodeURIComponent(nextProfileId)}`
      );
      if (nextProfileId !== activeProfileRef.current) {
        return data.sessions;
      }
      startTransition(() => {
        setSessions(data.sessions);
      });
      setLastSyncedAt(new Date().toISOString());
      lastSessionsPollAtRef.current = Date.now();
      return data.sessions;
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'sessions-load-failed',
        message: loadError.message || 'Failed to refresh sessions',
        details: {
          profileId: nextProfileId,
          silent,
        },
      });
      if (!silent) {
        setError(loadError.message || 'Failed to refresh sessions');
      }
      return null;
    } finally {
      if (!silent) {
        setIsRefreshing(false);
      }
    }
  }

  async function loadSessionDetail(
    sessionId: string,
    nextProfileId = profileId,
    options?: { silent?: boolean; tail?: number; full?: boolean }
  ) {
    const silent = options?.silent ?? false;
    const requestToken = ++latestSessionLoadTokenRef.current;
    const full = options?.full ?? false;
    const tail = Math.max(INITIAL_TIMELINE_WINDOW_SIZE, options?.tail || sessionWindowSize);

    if (!silent) {
      setError(null);
    }

    try {
      const data = await fetchJson<{ session: CodexSessionDetail }>(
        `/api/codex/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(nextProfileId)}&tail=${tail}${full ? '&full=1' : ''}`
      );
      if (requestToken !== latestSessionLoadTokenRef.current || nextProfileId !== activeProfileRef.current) {
        return data.session;
      }

      if (data.session.isDraft && data.session.forkDraftContext) {
        const nextForkDraftContext = mapForkDraftServerContext(
          data.session.forkDraftContext,
          data.session.updatedAt
        );

        startTransition(() => {
          setSelectedSessionId(null);
          setSelectedSession(null);
          setIsDraftConversation(true);
          setDraftConversationKey(data.session.id);
          setForkDraftContext(nextForkDraftContext);
          setDraftCwd(data.session.cwd || nextForkDraftContext.sourceCwd || selectedProfileWorkspaceCwd || null);
          if (!silent) {
            setIsSidebarOpen(false);
          }
        });
        setLastSyncedAt(new Date().toISOString());
        lastSessionDetailPollAtRef.current = Date.now();
        return data.session;
      }

      startTransition(() => {
        setSelectedSessionId(sessionId);
        setSelectedSession(data.session);
        setIsDraftConversation(false);
        setForkDraftContext(null);
        if (!silent) {
          setIsSidebarOpen(false);
        }
      });
      if (full) {
        setSessionWindowSize(data.session.totalTimelineEntries);
      }
      setLastSyncedAt(new Date().toISOString());
      lastSessionDetailPollAtRef.current = Date.now();
      return data.session;
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'session-detail-load-failed',
        message: loadError.message || 'Failed to load Codex session',
        details: {
          sessionId,
          profileId: nextProfileId,
          silent,
        },
      });
      if (!silent) {
        setError(loadError.message || 'Failed to load Codex session');
      }
      return null;
    }
  }

  function cancelFullTimelineLoading() {
    latestFullTimelineLoadTokenRef.current += 1;
    setIsFullTimelineLoading(false);
    setFullTimelineLoadPercent(0);
  }

  async function loadFullSessionTimeline(sessionId: string, nextProfileId = profileId) {
    if (!selectedSession || selectedSession.id !== sessionId) {
      return null;
    }

    const totalEntries = Math.max(
      selectedSession.totalTimelineEntries || 0,
      selectedSession.timeline.length
    );
    const initiallyLoaded = selectedSession.timeline.length;

    if (totalEntries <= initiallyLoaded) {
      setIsFullTimelineLoaded(true);
      setSessionWindowSize(totalEntries);
      setIsFullTimelineLoading(false);
      setFullTimelineLoadPercent(100);
      return selectedSession.timeline;
    }

    const requestToken = ++latestFullTimelineLoadTokenRef.current;
    let assembledTimeline = selectedSession.timeline.slice();
    let timelineWindowStart = selectedSession.timelineWindowStart;
    let finalChunk = selectedSession;

    recordCodexBreadcrumb('timeline-expanded-full-progressive', {
      sessionId,
      totalEntries,
      initiallyLoaded,
    });

    setError(null);
    setIsFullTimelineLoading(true);
    setFullTimelineLoadPercent(Math.max(1, Math.round((initiallyLoaded / totalEntries) * 100)));

    try {
      while (timelineWindowStart > 0) {
        const chunkTail = Math.min(TIMELINE_FULL_LOAD_CHUNK_SIZE, timelineWindowStart);
        const chunkData = await fetchJson<{ session: CodexSessionDetail }>(
          `/api/codex/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(nextProfileId)}&tail=${chunkTail}&before=${timelineWindowStart}`
        );

        if (requestToken !== latestFullTimelineLoadTokenRef.current || nextProfileId !== activeProfileRef.current) {
          return null;
        }

        finalChunk = chunkData.session;
        assembledTimeline = [...chunkData.session.timeline, ...assembledTimeline];
        timelineWindowStart = chunkData.session.timelineWindowStart;
        setFullTimelineLoadPercent(Math.min(99, Math.round((assembledTimeline.length / totalEntries) * 100)));
      }

      if (requestToken !== latestFullTimelineLoadTokenRef.current || nextProfileId !== activeProfileRef.current) {
        return null;
      }

      startTransition(() => {
        setSelectedSession((current) => {
          if (!current || current.id !== sessionId) {
            return current;
          }

          return {
            ...current,
            ...finalChunk,
            timeline: assembledTimeline,
            totalTimelineEntries: Math.max(totalEntries, assembledTimeline.length),
            timelineWindowStart: 0,
            timelineWindowEnd: assembledTimeline.length,
            hasEarlierTimeline: false,
          };
        });
      });
      setSessionWindowSize(Math.max(totalEntries, assembledTimeline.length));
      setIsFullTimelineLoaded(true);
      setFullTimelineLoadPercent(100);
      setLastSyncedAt(new Date().toISOString());
      lastSessionDetailPollAtRef.current = Date.now();
      return assembledTimeline;
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'session-full-timeline-load-failed',
        message: loadError.message || 'Failed to load full Codex timeline',
        details: {
          sessionId,
          profileId: nextProfileId,
          totalEntries,
          initiallyLoaded,
        },
      });
      setError(loadError.message || 'Failed to load full chat');
      return null;
    } finally {
      if (requestToken === latestFullTimelineLoadTokenRef.current) {
        setIsFullTimelineLoading(false);
        if (assembledTimeline.length < totalEntries) {
          setFullTimelineLoadPercent(0);
        }
      }
    }
  }

  async function syncDraftSessionFromQueue(
    items: CodexQueueServerItem[],
    nextProfileId = profileId,
    candidateSessions: CodexSessionSummary[] = sessions
  ) {
    if (selectedSessionId || !isDraftConversation) {
      return;
    }

    const trackedDraftItemIds = draftQueueItemIdsRef.current[draftConversationKey] || [];
    const matchingItem = items.find((item) => {
      if (!item.sessionId) {
        return false;
      }

      if (trackedDraftItemIds.includes(item.id)) {
        return true;
      }

      if (item.queueKey === draftConversationKey) {
        return true;
      }

      if (!forkDraftContext || !item.forkContext) {
        return false;
      }

      return (
        item.forkContext.sourceSessionId === forkDraftContext.sourceSessionId
        && item.forkContext.forkEntryId === forkDraftContext.forkEntryId
      );
    });
    if (matchingItem?.sessionId) {
      draftSessionMapRef.current[draftConversationKey] = matchingItem.sessionId;
      delete draftQueueItemIdsRef.current[draftConversationKey];
      setForkDraftContext(null);
      setDraftConversationKey(createDraftConversationKey());
      await loadSessionDetail(matchingItem.sessionId, nextProfileId, { silent: true });
      return;
    }

    if (!forkDraftContext) {
      return;
    }

    const matchingSession = candidateSessions.find((session) => (
      !session.isDraft
      && session.forkSourceSessionId === forkDraftContext.sourceSessionId
      && session.forkEntryId === forkDraftContext.forkEntryId
    ));

    if (!matchingSession) {
      return;
    }

    draftSessionMapRef.current[draftConversationKey] = matchingSession.id;
    delete draftQueueItemIdsRef.current[draftConversationKey];
    setForkDraftContext(null);
    setDraftConversationKey(createDraftConversationKey());
    await loadSessionDetail(matchingSession.id, nextProfileId, { silent: true });
  }

  async function loadQueueItems(nextProfileId = profileId, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;

    try {
      const data = await fetchJson<CodexQueueItemsResponse>(
        `/api/codex/queue/items?profile=${encodeURIComponent(nextProfileId)}`
      );
      if (nextProfileId !== activeProfileRef.current) {
        return data.items;
      }
      startTransition(() => {
        setQueueItems(data.items);
      });
      await syncDraftSessionFromQueue(data.items, nextProfileId);
      return data.items;
    } catch (loadError: any) {
      reportCodexClientLog({
        type: 'queue-load-failed',
        message: loadError.message || 'Failed to load Codex queue',
        details: {
          profileId: nextProfileId,
          silent,
        },
      });
      if (!silent) {
        setError(loadError.message || 'Failed to load Codex queue');
      }
      return null;
    }
  }

  async function bootstrapProfile(nextProfileId: string) {
    const nextProfile = profiles.find((profile) => profile.id === nextProfileId) || null;
    if (nextProfile) {
      setDraftCwd((current) => current || nextProfile.workspaceCwd);
    }

    const [sessionRows] = await Promise.all([
      loadSessionsOnly(nextProfileId),
      loadQueueItems(nextProfileId, { silent: true }),
    ]);
    if (!sessionRows) {
      return;
    }

    if (isDraftConversation) {
      setSelectedSessionId(null);
      setSelectedSession(null);
      return;
    }

    setSelectedSessionId(null);
    setSelectedSession(null);
    setIsDraftConversation(true);
  }

  async function pollUpdates() {
    if (!profileId) {
      return;
    }

    if (shouldPausePolling) {
      return;
    }

    if (pollInFlightRef.current) {
      return;
    }

    pollInFlightRef.current = true;

    try {
      const now = Date.now();
      const shouldRefreshSessions = (
        !selectedSessionId
        || activeQueueCount > 0
        || now - lastSessionsPollAtRef.current > 15000
      );

      const [sessionRows, queueRows] = await Promise.all([
        shouldRefreshSessions
          ? loadSessionsOnly(profileId, { silent: true })
          : Promise.resolve(sessions),
        loadQueueItems(profileId, { silent: true }),
      ]);

      if (!sessionRows) {
        return;
      }

      if (queueRows) {
        await syncDraftSessionFromQueue(queueRows, profileId, sessionRows);
      }

      const currentQueueHasLiveItems = (queueRows || []).some((item) => (
        item.queueKey === currentQueueKey && isQueueItemActive(item)
      ));

      if (
        selectedSessionId
        && (currentQueueHasLiveItems || now - lastSessionDetailPollAtRef.current > 12000)
      ) {
        await loadSessionDetail(selectedSessionId, profileId, { silent: true, full: isFullTimelineLoaded });
        return;
      }

    } finally {
      pollInFlightRef.current = false;
    }
  }

  function clearDraftAttachments() {
    setDraftAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      return [];
    });
  }

  function handleNewConversation(nextCwd?: string | null) {
    const fallbackCwd = nextCwd || selectedSession?.cwd || currentProfile?.workspaceCwd || selectedProfileWorkspaceCwd;
    recordCodexBreadcrumb('new-conversation-opened', {
      previousSessionId: selectedSessionId,
      cwd: fallbackCwd,
    });
    latestSessionLoadTokenRef.current += 1;
    cancelFullTimelineLoading();
    setSelectedSessionId(null);
    setSelectedSession(null);
    setIsDraftConversation(true);
    setForkDraftContext(null);
    setPrompt('');
    setSearch('');
    setError(null);
    clearDraftAttachments();
    setScheduledFor('');
    setIsScheduleOpen(false);
    setScheduleType('once');
    setDraftCwd(fallbackCwd || null);
    setSessionWindowSize(INITIAL_TIMELINE_WINDOW_SIZE);
    setIsFullTimelineLoaded(false);
    setActiveToolEntry(null);
    closeFilePreview();
    setDraftConversationKey(createDraftConversationKey());
    setIsHeaderActionsOpen(false);
    setIsSidebarOpen(false);
  }

  async function handleOpenSession(sessionId: string) {
    recordCodexBreadcrumb('session-opened', { sessionId });
    cancelFullTimelineLoading();
    setActiveToolEntry(null);
    closeFilePreview();
    setIsDraftConversation(true);
    setSessionWindowSize(INITIAL_TIMELINE_WINDOW_SIZE);
    setIsFullTimelineLoaded(false);
    if (selectedSessionId !== sessionId) {
      setSelectedSessionId(sessionId);
      setSelectedSession(null);
    }
    await loadSessionDetail(sessionId);
  }

  function handleProfileChange(nextProfileId: string) {
    if (!nextProfileId || nextProfileId === profileId) {
      return;
    }

    recordCodexBreadcrumb('profile-switched', {
      from: profileId,
      to: nextProfileId,
    });

    latestSessionLoadTokenRef.current += 1;
    cancelFullTimelineLoading();
    setError(null);
    setSearch('');
    setPrompt('');
    setActiveToolEntry(null);
    closeFilePreview();
    setIsDraftConversation(false);
    setForkDraftContext(null);
    setSelectedSessionId(null);
    setSelectedSession(null);
    setSessions([]);
    setQueueItems([]);
    setScheduledFor('');
    setIsScheduleOpen(false);
    setScheduleType('once');
    setSessionWindowSize(INITIAL_TIMELINE_WINDOW_SIZE);
    setIsFullTimelineLoaded(false);
    setDraftCwd(profiles.find((profile) => profile.id === nextProfileId)?.workspaceCwd || null);
    setFolderBrowser(null);
    setFolderBrowserError(null);
    setFileTreeBrowser(null);
    setFileTreeNodes({});
    setFileTreeExpandedPaths({});
    setFileTreeLoadingPaths({});
    setFileTreeError(null);
    setIsFileTreeOpen(false);
    setIsGamePickerOpen(false);
    setIsGameOpen(false);
    setIsRunnerGameOpen(false);
    setIsSudokuOpen(false);
    setIsTempleGemQuestOpen(false);
    setIsBiomeSnakeOpen(false);
    setThemeMode(readThemeModeForProfile(nextProfileId));
    folderBackStackRef.current = [];
    folderForwardStackRef.current = [];
    clearDraftAttachments();
    setDraftConversationKey(createDraftConversationKey());
    setProfileId(nextProfileId);
  }

  function handleToggleWorkspaceMode() {
    const nextMode: WorkspaceMode = workspaceMode === 'support' ? 'standard' : 'support';
    const nextProfile = resolveDefaultProfileForWorkspaceMode(
      profiles,
      nextMode,
      currentProfile?.provider
    ) || resolveDefaultProfileForWorkspaceMode(profiles, nextMode);

    if (!nextProfile) {
      setError(nextMode === 'support' ? 'אין פרופיל תמיכה זמין.' : 'אין פרופיל רגיל זמין.');
      return;
    }

    writeWorkspaceMode(nextMode);
    setWorkspaceMode(nextMode);
    handleProfileChange(nextProfile.id);
  }

  function handleProviderChange(nextProvider: CodexProfile['provider']) {
    const providerProfiles = visibleProfiles.filter((profile) => profile.provider === nextProvider);
    if (providerProfiles.length === 0) {
      return;
    }

    const preferred = providerProfiles.find((profile) => profile.defaultProfile) || providerProfiles[0];
    handleProfileChange(preferred.id);
  }

  function handleSelectConversation(sessionId: string) {
    if (sessionId.startsWith('draft:')) {
      void loadSessionDetail(sessionId);
      return;
    }

    void handleOpenSession(sessionId);
  }

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length === 0) {
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const uploadedFiles = await uploadFiles(selectedFiles);
      recordCodexBreadcrumb('attachments-uploaded', {
        count: uploadedFiles.length,
      });
      setDraftAttachments((current) => [...current, ...uploadedFiles]);
    } catch (uploadError: any) {
      reportCodexClientLog({
        type: 'upload-failed',
        message: uploadError.message || 'Failed to upload files',
      });
      setError(uploadError.message || 'Failed to upload files');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function removeAttachment(attachmentId: string) {
    setDraftAttachments((current) => {
      const next = current.filter((attachment) => {
        if (attachment.id === attachmentId && attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
        return attachment.id !== attachmentId;
      });
      return next;
    });
  }

  function replaceDraftAttachments(nextAttachments: DraftAttachment[]) {
    setDraftAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });

      return nextAttachments;
    });
  }

  async function editQueueItem(item: CodexQueueServerItem) {
    const restoredAttachments = buildEditableDraftAttachments(item.attachments);
    const shouldRestoreSchedule = item.scheduleMode === 'recurring'
      || new Date(item.scheduledAt).getTime() > Date.now();
    const nextScheduleType = item.scheduleMode === 'recurring' ? 'recurring' : 'once';
    const nextScheduledFor = shouldRestoreSchedule ? toLocalDateTimeInputValue(item.scheduledAt) : '';

    recordCodexBreadcrumb('queue-item-edit-opened', {
      itemId: item.id,
      sessionId: item.sessionId,
      queueKey: item.queueKey,
    });

    setError(null);
    setPrompt(item.prompt || '');
    replaceDraftAttachments(restoredAttachments);
    setScheduleType(nextScheduleType);
    setScheduledFor(nextScheduledFor);
    setRecurringFreq(item.recurringFrequency || 'daily');
    setIsScheduleOpen(Boolean(nextScheduledFor));
    setActiveToolEntry(null);
    closeFilePreview();
    setIsSidebarOpen(false);

    if (item.sessionId) {
      await handleOpenSession(item.sessionId);
      return;
    }

    latestSessionLoadTokenRef.current += 1;
    setSelectedSessionId(null);
    setSelectedSession(null);
    setIsDraftConversation(true);
    setForkDraftContext(null);
    setDraftCwd(item.cwd || currentProfile?.workspaceCwd || selectedProfileWorkspaceCwd || null);
    setDraftConversationKey(item.queueKey || createDraftConversationKey());
  }

  async function forkFromTimelineEntry(entryId: string) {
    if (!selectedSession) {
      setError('לא נמצאה שיחה פעילה ליצירת מזלוג.');
      return;
    }

    try {
      setError(null);
      const data = await fetchJson<CodexForkCreateResponse>(
        `/api/codex/sessions/${encodeURIComponent(selectedSession.id)}/fork`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profileId,
            forkEntryId: entryId,
          }),
        }
      );
      startTransition(() => {
        setSessions((current) => [
          data.session,
          ...current.filter((session) => session.id !== data.session.id),
        ]);
        setSelectedSessionId(data.sessionId);
        setSelectedSession(null);
        setIsDraftConversation(false);
        setIsSidebarOpen(false);
      });
      setForkDraftContext(null);
      setDraftConversationKey(createDraftConversationKey());
      await loadSessionDetail(data.sessionId);
      recordCodexBreadcrumb('session-fork-created', {
        sourceSessionId: selectedSession.id,
        forkEntryId: entryId,
        sessionId: data.sessionId,
      });
    } catch (forkError: any) {
      setError(forkError.message || 'לא ניתן ליצור מזלוג מההודעה שנבחרה.');
    }
  }

  async function openSessionChangesForEntry(entryId: string) {
    if (!selectedSessionId) {
      setError('לא נמצאה שיחה פעילה להצגת שינויי קבצים.');
      return;
    }

    try {
      setError(null);
      setIsSessionChangeDialogOpen(true);
      setIsSessionChangeLoading(true);
      setActiveSessionChangeEntryId(entryId);
      const activeProfileId = currentProfile?.id || selectedSession?.profileId || profileId || null;
      const record = await fetchSessionChangeRecord(selectedSessionId, entryId, activeProfileId);
      setActiveSessionChangeRecord(record);
      setActiveSessionChangeFileId(record?.files[0]?.id || null);
    } catch (changesError: any) {
      setError(changesError.message || 'לא ניתן היה לטעון את שינויי הקבצים של ההודעה הזאת.');
      setActiveSessionChangeRecord(null);
      setActiveSessionChangeFileId(null);
    } finally {
      setIsSessionChangeLoading(false);
    }
  }

  function deleteTurnFromTimelineEntry(entryId: string) {
    const activeProfileId = currentProfile?.id || selectedSession?.profileId || profileId || null;
    const activeSessionKey = selectedSessionId || (isDraftConversation ? draftConversationKey : null);

    if (!activeProfileId || !activeSessionKey) {
      setError('לא נמצאה שיחה פעילה למחיקה.');
      return;
    }

    setPendingDeleteTurn({
      entryId,
      shouldStopRunningTurn: currentSessionActiveQueueCount > 0,
    });
  }

  async function confirmDeletePendingTurn() {
    if (!pendingDeleteTurn) {
      return;
    }

    const activeProfileId = currentProfile?.id || selectedSession?.profileId || profileId || null;
    const activeSessionKey = selectedSessionId || (isDraftConversation ? draftConversationKey : null);

    if (!activeProfileId || !activeSessionKey) {
      setPendingDeleteTurn(null);
      setError('לא נמצאה שיחה פעילה למחיקה.');
      return;
    }

    try {
      setDeletingEntryId(pendingDeleteTurn.entryId);
      setPendingDeleteTurn(null);
      setError(null);
      const data = await fetchJson<CodexDeleteTurnResponse>(
        `/api/codex/sessions/${encodeURIComponent(activeSessionKey)}/delete-turn`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profileId: activeProfileId,
            entryId: pendingDeleteTurn.entryId,
          }),
        }
      );

      if (!data.session.forkDraftContext) {
        throw new Error('השיחה הנקייה לא נוצרה כראוי.');
      }

      const nextForkDraftContext = mapForkDraftServerContext(
        data.session.forkDraftContext,
        data.session.updatedAt
      );

      latestSessionLoadTokenRef.current += 1;
      cancelFullTimelineLoading();
      activeProfileRef.current = activeProfileId;
      activeSelectedSessionIdRef.current = null;
      closeFilePreview();
      setActiveToolEntry(null);
      setActiveSessionChangeRecord(null);
      setActiveSessionChangeEntryId(null);
      setActiveSessionChangeFileId(null);
      setIsSessionChangeDialogOpen(false);

      startTransition(() => {
        setSelectedSessionId(null);
        setSelectedSession(null);
        setIsDraftConversation(true);
        setDraftConversationKey(data.session.id);
        setForkDraftContext(nextForkDraftContext);
        setDraftCwd(data.session.cwd || nextForkDraftContext.sourceCwd || currentProfile?.workspaceCwd || selectedProfileWorkspaceCwd || null);
        setSessions((current) => [
          data.session,
          ...current
            .filter((session) => session.id !== data.session.id && session.id !== activeSessionKey)
            .map((session) => (
              session.id === activeSessionKey
                ? { ...session, hidden: true }
                : session
            )),
        ]);
        setQueueItems((current) => current.filter((item) => !data.cancelledQueueItemIds.includes(item.id)));
        setPrompt('');
        setIsSidebarOpen(false);
        setIsHeaderActionsOpen(false);
        setSessionWindowSize(Math.max(INITIAL_TIMELINE_WINDOW_SIZE, data.session.timeline.length));
        setIsFullTimelineLoaded(true);
      });

      recordCodexBreadcrumb('session-turn-deleted', {
        sessionId: activeSessionKey,
        nextSessionId: data.sessionId,
        entryId: pendingDeleteTurn.entryId,
        deletedUserEntryId: data.deletedUserEntryId,
        deletedAssistantEntryId: data.deletedAssistantEntryId,
        cancelledQueueItemIds: data.cancelledQueueItemIds,
      });

      void loadSessionsOnly(activeProfileId, { silent: true });
      void loadQueueItems(activeProfileId, { silent: true });
      void loadCurrentSessionInstruction(activeProfileId, data.session.id);
    } catch (deleteError: any) {
      setError(deleteError.message || 'לא ניתן היה למחוק את זוג ההודעות שנבחר.');
    } finally {
      setDeletingEntryId(null);
    }
  }

  async function transferFromTimelineEntry(entryId: string, targetProfileId: string) {
    if (!selectedSession || !currentProfile) {
      setError('לא נמצאה שיחה פעילה להעברה.');
      return;
    }

    const targetProfile = profiles.find((profile) => profile.id === targetProfileId) || null;
    if (!targetProfile) {
      setError('לא נמצא פרופיל יעד תואם להעברה.');
      return;
    }

    try {
      setTransferringEntryId(entryId);
      setError(null);
      const data = await fetchJson<CodexTransferCreateResponse>(
        `/api/codex/sessions/${encodeURIComponent(selectedSession.id)}/transfer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profileId,
            targetProfileId,
            transferEntryId: entryId,
            clientRequestId: buildQueueId(),
          }),
        }
      );

      if (!data.session.forkDraftContext) {
        throw new Error('טיוטת ההעברה לא נוצרה כראוי.');
      }

      const nextForkDraftContext = mapForkDraftServerContext(
        data.session.forkDraftContext,
        data.session.updatedAt
      );

      recordCodexBreadcrumb('session-transfer-created', {
        sourceSessionId: selectedSession.id,
        transferEntryId: entryId,
        targetProfileId,
        targetSessionId: data.sessionId,
      });

      latestSessionLoadTokenRef.current += 1;
      cancelFullTimelineLoading();
      activeProfileRef.current = data.targetProfileId;
      activeSelectedSessionIdRef.current = null;
      draftQueueItemIdsRef.current[data.sessionId] = Array.from(new Set([
        ...(draftQueueItemIdsRef.current[data.sessionId] || []),
        data.item.id,
      ]));

      clearDraftAttachments();
      closeFilePreview();
      setActiveToolEntry(null);
      setThemeMode(readThemeModeForProfile(data.targetProfileId));

      startTransition(() => {
        setProfileId(data.targetProfileId);
        setSelectedSessionId(null);
        setSelectedSession(null);
        setIsDraftConversation(true);
        setDraftConversationKey(data.session.id);
        setForkDraftContext(nextForkDraftContext);
        setDraftCwd(data.session.cwd || nextForkDraftContext.sourceCwd || targetProfile.workspaceCwd || null);
        setSessions([data.session]);
        setQueueItems([data.item]);
        setPrompt('');
        setSearch('');
        setScheduledFor('');
        setIsScheduleOpen(false);
        setScheduleType('once');
        setIsSidebarOpen(false);
        setIsHeaderActionsOpen(false);
        setFolderBrowser(null);
        setFolderBrowserError(null);
        setFileTreeBrowser(null);
        setFileTreeNodes({});
        setFileTreeExpandedPaths({});
        setFileTreeLoadingPaths({});
        setFileTreeError(null);
        setIsFileTreeOpen(false);
        setIsGamePickerOpen(false);
        setIsGameOpen(false);
        setIsRunnerGameOpen(false);
        setIsSudokuOpen(false);
        setIsTempleGemQuestOpen(false);
        setIsBiomeSnakeOpen(false);
        setRateLimitSnapshot(null);
        setAvailableModels([]);
        setModelPermissionSnapshot(null);
        setSelectedModelSlug(null);
        setSelectedReasoningEffort(null);
        setSessionInstruction(null);
        setInstructionDraft('');
        setSessionWindowSize(Math.max(INITIAL_TIMELINE_WINDOW_SIZE, data.session.timeline.length));
        setIsFullTimelineLoaded(data.session.totalTimelineEntries <= data.session.timeline.length);
      });

      void loadSessionsOnly(data.targetProfileId, { silent: true });
      void loadQueueItems(data.targetProfileId, { silent: true });
      void loadModelCatalog(data.targetProfileId);
      void loadRateLimitSnapshot(data.targetProfileId, null);
      void loadCurrentSessionInstruction(data.targetProfileId, data.session.id);
    } catch (transferError: any) {
      setError(transferError.message || 'לא ניתן היה להעביר את השיחה למודל השני.');
    } finally {
      setTransferringEntryId(null);
    }
  }

  async function enqueueCurrentPrompt() {
    const trimmedPrompt = prompt.trim();
    if (!profileId || (!trimmedPrompt && draftAttachments.length === 0) || sendInFlightRef.current) {
      return;
    }

    if (draftAttachments.length === 0 && await handleSupportedSlashCommand(trimmedPrompt)) {
      return;
    }

    if (scheduleType === 'recurring' && !scheduledFor) {
      setError('בחר שעה לתיזמון הקבוע לפני השליחה.');
      return;
    }

    const payloadFingerprint = JSON.stringify({
      profileId,
      queueKey: currentQueueKey,
      sessionId: selectedSessionId,
      cwd: !selectedSessionId ? activeComposerCwd : null,
      model: selectedModelSlug,
      reasoningEffort: selectedReasoningEffort,
      forkSourceSessionId: forkDraftContext?.sourceSessionId || null,
      forkEntryId: forkDraftContext?.forkEntryId || null,
      prompt: trimmedPrompt,
      scheduledFor,
      scheduleType,
      recurringFreq,
      sessionInstruction: sessionInstruction || null,
      attachments: draftAttachments.map((attachment) => attachment.id),
    });
    const now = Date.now();
    const previousDedup = sendDedupRef.current;
    const clientRequestId = previousDedup
      && previousDedup.fingerprint === payloadFingerprint
      && previousDedup.expiresAt > now
      ? previousDedup.requestId
      : buildQueueId();

    sendDedupRef.current = {
      fingerprint: payloadFingerprint,
      requestId: clientRequestId,
      expiresAt: now + 15000,
    };
    recordCodexBreadcrumb('queue-enqueue-requested', {
      profileId,
      selectedSessionId,
      queueKey: currentQueueKey,
      model: selectedModelSlug,
      reasoningEffort: selectedReasoningEffort,
      attachments: draftAttachments.length,
      hasPrompt: Boolean(trimmedPrompt),
      scheduleType,
    });
    sendInFlightRef.current = true;
    setIsSending(true);
    setError(null);

    try {
      const data = await fetchJson<{ item: CodexQueueServerItem }>('/api/codex/queue/items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientRequestId,
          prompt: trimmedPrompt,
          promptPreview: trimmedPrompt,
          sessionInstruction: sessionInstruction || undefined,
          sessionId: selectedSessionId,
          queueKey: currentQueueKey,
          profileId,
          cwd: !selectedSessionId ? activeComposerCwd : undefined,
          model: selectedModelSlug || undefined,
          reasoningEffort: selectedReasoningEffort || undefined,
          scheduledAt: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
          recurrence: scheduleType === 'recurring'
            ? {
              frequency: recurringFreq,
              timeZone: browserTimeZone,
            }
            : undefined,
          attachments: draftAttachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            path: attachment.path,
            isImage: attachment.isImage,
          })),
        }),
      });

      startTransition(() => {
        setQueueItems((current) => [data.item, ...current.filter((item) => item.id !== data.item.id)]);
      });
      if (!selectedSessionId) {
        draftQueueItemIdsRef.current[currentQueueKey] = Array.from(new Set([
          ...(draftQueueItemIdsRef.current[currentQueueKey] || []),
          data.item.id,
        ]));
      }
      setPrompt('');
      setScheduledFor('');
      setIsScheduleOpen(false);
      setScheduleType('once');
      clearDraftAttachments();
      sendDedupRef.current = null;
      recordCodexBreadcrumb('queue-enqueue-succeeded', {
        itemId: data.item.id,
        status: data.item.status,
      });
      await loadQueueItems(profileId, { silent: true });
    } catch (sendError: any) {
      reportCodexClientLog({
        type: 'queue-enqueue-failed',
        message: sendError.message || 'Failed to enqueue Codex task',
        details: {
          profileId,
          selectedSessionId,
          queueKey: currentQueueKey,
        },
      });
      setError(sendError.message || 'Failed to enqueue Codex task');
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  }

  async function continueAbortedSession() {
    if (!profileId || !selectedSessionId || sendInFlightRef.current) {
      return;
    }

    const continuationPrompt = 'Continue from the exact point where the previous turn was aborted. Continue the same task without restarting, do not repeat completed work, and finish the response fully until the task is complete.';
    const clientRequestId = buildQueueId();

    recordCodexBreadcrumb('session-aborted-continue-requested', {
      profileId,
      sessionId: selectedSessionId,
      queueKey: currentQueueKey,
    });
    sendInFlightRef.current = true;
    setIsSending(true);
    setIsContinuingAbortedSession(true);
    setError(null);

    try {
      const data = await fetchJson<{ item: CodexQueueServerItem }>('/api/codex/queue/items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientRequestId,
          prompt: continuationPrompt,
          promptPreview: 'המשך את הסבב שנקטע עד הסוף',
          sessionInstruction: sessionInstruction || undefined,
          sessionId: selectedSessionId,
          queueKey: currentQueueKey,
          profileId,
          model: selectedModelSlug || undefined,
          reasoningEffort: selectedReasoningEffort || undefined,
        }),
      });

      startTransition(() => {
        setQueueItems((current) => [data.item, ...current.filter((item) => item.id !== data.item.id)]);
      });
      recordCodexBreadcrumb('session-aborted-continue-succeeded', {
        itemId: data.item.id,
        status: data.item.status,
      });
      await loadQueueItems(profileId, { silent: true });
    } catch (continueError: any) {
      reportCodexClientLog({
        type: 'session-aborted-continue-failed',
        message: continueError.message || 'Failed to continue aborted Codex turn',
        details: {
          profileId,
          sessionId: selectedSessionId,
          queueKey: currentQueueKey,
        },
      });
      setError(continueError.message || 'Failed to continue aborted Codex turn');
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
      setIsContinuingAbortedSession(false);
    }
  }

  async function cancelQueueItem(itemId: string) {
    try {
      recordCodexBreadcrumb('queue-cancel-requested', { itemId });
      const data = await fetchJson<CodexQueueItemResponse>(`/api/codex/queue/items/${encodeURIComponent(itemId)}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      startTransition(() => {
        setQueueItems((current) => current.map((item) => (item.id === itemId ? data.item : item)));
      });
    } catch (queueError: any) {
      reportCodexClientLog({
        type: 'queue-cancel-failed',
        message: queueError.message || 'Failed to cancel queue item',
        details: { itemId },
      });
      setError(queueError.message || 'Failed to cancel queue item');
    }
  }

  async function retryQueueItem(itemId: string) {
    try {
      recordCodexBreadcrumb('queue-retry-requested', { itemId });
      const data = await fetchJson<CodexQueueItemResponse>(`/api/codex/queue/items/${encodeURIComponent(itemId)}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      startTransition(() => {
        setQueueItems((current) => current.map((item) => (item.id === itemId ? data.item : item)));
      });
      await loadQueueItems(profileId, { silent: true });
    } catch (queueError: any) {
      reportCodexClientLog({
        type: 'queue-retry-failed',
        message: queueError.message || 'Failed to retry queue item',
        details: { itemId },
      });
      setError(queueError.message || 'Failed to retry queue item');
    }
  }

  async function deleteQueueItem(itemId: string) {
    try {
      recordCodexBreadcrumb('queue-delete-requested', { itemId });
      const response = await fetch(`/api/codex/queue/items/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete queue item');
      }

      startTransition(() => {
        setQueueItems((current) => current.filter((item) => item.id !== itemId));
      });
    } catch (queueError: any) {
      reportCodexClientLog({
        type: 'queue-delete-failed',
        message: queueError.message || 'Failed to delete queue item',
        details: { itemId },
      });
      setError(queueError.message || 'Failed to delete queue item');
    }
  }

  async function handleToggleSessionHidden(sessionId: string, hidden: boolean) {
    try {
      await fetchJson(`/api/codex/sessions/${encodeURIComponent(sessionId)}/hide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profileId,
          hidden,
        }),
      });

      startTransition(() => {
        setSessions((current) => current.map((session) => (
          session.id === sessionId
            ? { ...session, hidden }
            : session
        )));
      });
    } catch (visibilityError: any) {
      reportCodexClientLog({
        type: 'session-hide-toggle-failed',
        message: visibilityError.message || 'Failed to update session visibility',
        details: {
          sessionId,
          hidden,
          profileId,
        },
      });
      setError(visibilityError.message || 'Failed to update session visibility');
    }
  }

  async function openTopicManager(session: CodexSessionSummary) {
    setTopicSession(session);
    setTopicError(null);
    setFolderTopics([]);
    setCustomSessionTitle(session.title);
    setIsSavingSessionTitle(false);
    setNewTopicName('');
    setNewTopicIcon(session.topic?.icon || TOPIC_ICON_PRESETS[0]);
    setNewTopicColorKey((session.topic?.colorKey as keyof typeof TOPIC_COLOR_PRESETS) || 'sky');

    if (!session.cwd) {
      setTopicError('לשיחה הזו אין תיקייה מזוהה ולכן אי אפשר להגדיר לה נושא.');
      return;
    }

    setIsTopicLoading(true);
    try {
      const topics = await fetchTopics(profileId, session.cwd);
      setFolderTopics(topics);
    } catch (topicLoadError: any) {
      setTopicError(topicLoadError.message || 'Failed to load topics');
    } finally {
      setIsTopicLoading(false);
    }
  }

  async function saveSessionTitle(session: CodexSessionSummary, nextTitle: string | null) {
    try {
      setIsSavingSessionTitle(true);
      const response = await updateSessionTitleRequest(profileId, session.id, nextTitle);
      const resolvedTitle = response.displayTitle;

      startTransition(() => {
        setSessions((current) => current.map((candidate) => (
          candidate.id === session.id
            ? { ...candidate, title: resolvedTitle }
            : candidate
        )));
        setSelectedSession((current) => current?.id === session.id ? { ...current, title: resolvedTitle } : current);
        setTopicSession((current) => current?.id === session.id ? { ...current, title: resolvedTitle } : current);
      });
      setCustomSessionTitle(resolvedTitle);
      setTopicError(null);
    } catch (titleError: any) {
      setTopicError(titleError.message || 'Failed to update session title');
    } finally {
      setIsSavingSessionTitle(false);
    }
  }

  async function assignTopicToSession(session: CodexSessionSummary, topicId: string | null) {
    try {
      const topic = await assignSessionTopicRequest(profileId, session.id, topicId, session.cwd);
      startTransition(() => {
        setSessions((current) => current.map((candidate) => (
          candidate.id === session.id
            ? { ...candidate, topic }
            : candidate
        )));
        setSelectedSession((current) => current?.id === session.id ? { ...current, topic } : current);
      });
      setTopicError(null);
      setTopicSession(null);
    } catch (assignError: any) {
      setTopicError(assignError.message || 'Failed to assign topic');
    }
  }

  async function createAndAssignTopic() {
    if (!topicSession?.cwd) {
      setTopicError('אין תיקייה זמינה לנושא הזה.');
      return;
    }

    try {
      const topic = await createTopic(profileId, topicSession.cwd, {
        name: newTopicName,
        icon: newTopicIcon,
        colorKey: newTopicColorKey,
      });
      setFolderTopics((current) => [...current, topic].sort((left, right) => left.name.localeCompare(right.name, 'he')));
      await assignTopicToSession(topicSession, topic.id);
      setNewTopicName('');
    } catch (createError: any) {
      setTopicError(createError.message || 'Failed to create topic');
    }
  }

  async function handleInstallApp() {
    if (isStandaloneMode) {
      return;
    }

    if (deferredInstallPrompt) {
      try {
        await deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        recordCodexBreadcrumb('pwa-install-choice', {
          outcome: choice.outcome,
          platform: choice.platform,
        });
        if (choice.outcome === 'accepted') {
          setDeferredInstallPrompt(null);
        }
      } catch (installError: any) {
        reportCodexClientLog({
          type: 'pwa-install-failed',
          message: installError.message || 'Failed to prompt install',
        });
        setError(installError.message || 'Failed to start install flow');
      }
      return;
    }

    setIsInstallHelpOpen(true);
    recordCodexBreadcrumb('pwa-install-help-opened', {
      platform: isIosInstallFlow ? 'ios' : 'generic',
    });
  }

  async function handleOpenFilePreview(rawPath: string) {
    setActiveToolEntry(null);
    setIsFilePreviewLoading(true);
    setActiveFilePreview(null);
    setActiveFileMatches([]);
    setActiveFileMatchesQuery('');
    setActiveFileMatchesLineNumber(null);
    setFilePreviewError(null);

    try {
      recordCodexBreadcrumb('file-preview-opened', {
        rawPath,
        selectedSessionId,
      });
      const result = await fetchFilePreview(rawPath);
      if (result.kind === 'matches') {
        setActiveFileMatches(result.matches);
        setActiveFileMatchesQuery(result.query);
        setActiveFileMatchesLineNumber(result.lineNumber);
        return;
      }

      setActiveFilePreview(result.file);
    } catch (previewError: any) {
      reportCodexClientLog({
        type: 'file-preview-failed',
        message: previewError.message || 'Failed to preview file',
        details: {
          rawPath,
          selectedSessionId,
          profileId,
        },
      });
      setFilePreviewError(previewError.message || 'Failed to preview file');
    } finally {
      setIsFilePreviewLoading(false);
    }
  }

  function closeFilePreview() {
    setIsFilePreviewLoading(false);
    setIsFileDownloadLoading(false);
    setActiveFilePreview(null);
    setActiveFileMatches([]);
    setActiveFileMatchesQuery('');
    setActiveFileMatchesLineNumber(null);
    setFilePreviewError(null);
  }

  async function handleDownloadActiveFile() {
    if (!activeFilePreview) {
      return;
    }

    setIsFileDownloadLoading(true);
    setFilePreviewError(null);

    try {
      const response = await fetch(activeFilePreview.downloadUrl, {
        credentials: 'same-origin',
      });

      if (!response.ok) {
        let errorMessage = `Failed to download file (${response.status})`;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          if (payload?.error) {
            errorMessage = payload.error;
          }
        } else {
          const text = await response.text().catch(() => '');
          if (text.trim()) {
            errorMessage = text.trim();
          }
        }
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = activeFilePreview.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1500);
    } catch (downloadError: any) {
      reportCodexClientLog({
        type: 'file-download-failed',
        message: downloadError.message || 'Failed to download file',
        details: {
          path: activeFilePreview.path,
          downloadUrl: activeFilePreview.downloadUrl,
          profileId,
          selectedSessionId,
        },
      });
      setFilePreviewError(downloadError.message || 'Failed to download file');
    } finally {
      setIsFileDownloadLoading(false);
    }
  }

  async function loadModelCatalog(nextProfileId = profileId) {
    if (!nextProfileId) {
      setAvailableModels([]);
      setModelPermissionSnapshot(null);
      setSelectedModelSlug(null);
      setSelectedReasoningEffort(null);
      return;
    }

    const requestToken = ++latestModelCatalogLoadTokenRef.current;
    setIsModelCatalogLoading(true);

    try {
      const data = await fetchCodexModelCatalog(nextProfileId);
      if (requestToken !== latestModelCatalogLoadTokenRef.current || nextProfileId !== activeProfileRef.current) {
        return;
      }

      const nextModelSlug = data.selectedModel || data.models[0]?.slug || null;
      const nextModelOption = nextModelSlug
        ? data.models.find((model) => model.slug === nextModelSlug) || null
        : null;
      const nextReasoningEffort = data.selectedReasoningEffort
        && nextModelOption?.supportedReasoningLevels.some((level) => level.effort === data.selectedReasoningEffort)
          ? data.selectedReasoningEffort
          : nextModelOption?.defaultReasoningLevel
            || nextModelOption?.supportedReasoningLevels[0]?.effort
            || null;

      setAvailableModels(data.models);
      setModelPermissionSnapshot(data.permissions || null);
      setSelectedModelSlug(nextModelSlug);
      setSelectedReasoningEffort(nextReasoningEffort);
    } catch (modelCatalogError: any) {
      if (requestToken === latestModelCatalogLoadTokenRef.current) {
        setAvailableModels([]);
        setModelPermissionSnapshot(null);
        setSelectedModelSlug(null);
        setSelectedReasoningEffort(null);
        setError(modelCatalogError.message || 'Failed to load models');
      }
    } finally {
      if (requestToken === latestModelCatalogLoadTokenRef.current) {
        setIsModelCatalogLoading(false);
      }
    }
  }

  async function loadRateLimitSnapshot(nextProfileId = profileId, nextSessionId = selectedSessionId) {
    if (!nextProfileId) {
      setRateLimitSnapshot(null);
      return;
    }

    const requestToken = ++latestRateLimitLoadTokenRef.current;
    setIsRateLimitLoading(true);

    try {
      const data = await fetchCodexRateLimits(nextProfileId, nextSessionId);
      if (
        requestToken !== latestRateLimitLoadTokenRef.current
        || nextProfileId !== activeProfileRef.current
        || nextSessionId !== activeSelectedSessionIdRef.current
      ) {
        return;
      }

      setRateLimitSnapshot(data);
    } catch (_rateLimitError: any) {
      if (requestToken === latestRateLimitLoadTokenRef.current) {
        setRateLimitSnapshot(null);
      }
    } finally {
      if (requestToken === latestRateLimitLoadTokenRef.current) {
        setIsRateLimitLoading(false);
      }
    }
  }

  async function loadCurrentSessionInstruction(nextProfileId = profileId, nextSessionKey = currentQueueKey) {
    if (!nextProfileId || !nextSessionKey) {
      setSessionInstruction(null);
      setInstructionDraft('');
      return;
    }

    const requestToken = ++latestInstructionLoadTokenRef.current;
    setSessionInstruction(null);
    setInstructionDraft('');
    setIsInstructionLoading(true);
    try {
      const instruction = await fetchSessionInstruction(nextProfileId, nextSessionKey);
      if (requestToken !== latestInstructionLoadTokenRef.current) {
        return;
      }
      setSessionInstruction(instruction);
      setInstructionDraft(instruction || '');
    } catch (instructionError: any) {
      setError(instructionError.message || 'Failed to load session instruction');
    } finally {
      if (requestToken === latestInstructionLoadTokenRef.current) {
        setIsInstructionLoading(false);
      }
    }
  }

  async function saveCurrentSessionInstruction() {
    if (!profileId || !currentQueueKey) {
      return;
    }

    setIsInstructionSaving(true);
    try {
      const instruction = await saveSessionInstruction(profileId, currentQueueKey, instructionDraft);
      setSessionInstruction(instruction);
      setInstructionDraft(instruction || '');
      setIsInstructionDialogOpen(false);
    } catch (instructionError: any) {
      setError(instructionError.message || 'Failed to save session instruction');
    } finally {
      setIsInstructionSaving(false);
    }
  }

  async function handleSupportedSlashCommand(rawPrompt: string): Promise<boolean> {
    const command = parseSlashCommand(rawPrompt);
    if (!command) {
      return false;
    }

    const isGoalCommand = command.name === '/goal';
    const shouldClearGoal = isGoalClearCommand(command);
    if (!isGoalCommand && !shouldClearGoal) {
      return false;
    }

    if (!profileId || !currentQueueKey) {
      setError('אין יעד פעיל לשמירת /goal.');
      return true;
    }

    if (isGoalCommand && !command.args) {
      setInstructionDraft(sessionInstruction || '');
      setIsInstructionDialogOpen(true);
      setPrompt('');
      return true;
    }

    setIsInstructionSaving(true);
    setError(null);
    try {
      const nextInstruction = await saveSessionInstruction(
        profileId,
        currentQueueKey,
        shouldClearGoal ? null : command.args
      );
      setSessionInstruction(nextInstruction);
      setInstructionDraft(nextInstruction || '');
      setPrompt('');
    } catch (instructionError: any) {
      setError(instructionError.message || 'Failed to handle /goal');
    } finally {
      setIsInstructionSaving(false);
    }

    return true;
  }

  const selectedProvider = currentProfile?.provider
    || visibleProfiles.find((profile) => profile.defaultProfile)?.provider
    || visibleProfiles[0]?.provider
    || 'codex';
  const selectedProviderLabel = getProviderDisplayLabel(selectedProvider);
  const thinkingDots = '.'.repeat((thinkingPulseIndex % 3) + 1);
  const thinkingToneClass = [
    'from-sky-400 via-cyan-300 to-emerald-300',
    'from-fuchsia-400 via-rose-300 to-orange-300',
    'from-indigo-400 via-violet-300 to-sky-300',
  ][thinkingPulseIndex % 3];
  const isCurrentConversationRunning = currentSessionActiveQueueCount > 0;
  const transferTargetProfiles = useMemo(
    () => resolveTransferTargetProfiles(visibleProfiles, currentProfile),
    [currentProfile, visibleProfiles]
  );
  const transferTargetOptions = useMemo<TransferTargetOption[]>(
    () => transferTargetProfiles.map((profile) => ({
      profileId: profile.id,
      provider: profile.provider,
      label: getProviderDisplayLabel(profile.provider),
    })),
    [transferTargetProfiles]
  );
  const assistantMessageLabel = selectedProviderLabel;
  const commentaryMessageLabel = `${selectedProviderLabel} עובד`;
  const selectedModelOption = useMemo(
    () => availableModels.find((model) => model.slug === selectedModelSlug) || null,
    [availableModels, selectedModelSlug]
  );
  const supportedReasoningLevels = selectedModelOption?.supportedReasoningLevels || [];
  const selectedReasoningOption = useMemo(
    () => supportedReasoningLevels.find((level) => level.effort === selectedReasoningEffort) || null,
    [selectedReasoningEffort, supportedReasoningLevels]
  );
  const modelPermissionTone = useMemo(
    () => getPermissionTone(modelPermissionSnapshot),
    [modelPermissionSnapshot]
  );
  const installMode = isStandaloneMode
    ? 'installed'
    : deferredInstallPrompt
      ? 'ready'
      : 'manual';
  const isFilePreviewOpen = isFilePreviewLoading
    || Boolean(activeFilePreview)
    || activeFileMatches.length > 0
    || Boolean(filePreviewError);
  const { date: scheduleDateValue, time: scheduleTimeValue } = splitScheduledDateTime(scheduledFor);

  useEffect(() => {
    if (!draftCwd && currentProfile?.workspaceCwd) {
      setDraftCwd(currentProfile.workspaceCwd);
    }
  }, [currentProfile?.workspaceCwd, draftCwd]);

  useEffect(() => {
    if (!profileId || !currentQueueKey) {
      return;
    }

    void loadCurrentSessionInstruction(profileId, currentQueueKey);
  }, [currentQueueKey, profileId]);

  useEffect(() => {
    if (!profileId) {
      setAvailableModels([]);
      setModelPermissionSnapshot(null);
      setRateLimitSnapshot(null);
      setSelectedModelSlug(null);
      setSelectedReasoningEffort(null);
      return;
    }

    void loadModelCatalog(profileId);
    void loadRateLimitSnapshot(profileId, selectedSessionId);
  }, [profileId, selectedSessionId]);

  useEffect(() => {
    writeWorkspaceMode(workspaceMode);
    if (visibleProfiles.length === 0) {
      return;
    }

    if (currentProfile) {
      return;
    }

    const fallbackProfile = resolveDefaultProfileForWorkspaceMode(profiles, workspaceMode);
    if (fallbackProfile && fallbackProfile.id !== profileId) {
      handleProfileChange(fallbackProfile.id);
    }
  }, [currentProfile, profileId, profiles, visibleProfiles.length, workspaceMode]);

  useEffect(() => {
    if (!profileId || !isRateLimitOpen) {
      return;
    }

    void loadRateLimitSnapshot(profileId, selectedSessionId);
  }, [isRateLimitOpen, profileId, selectedSessionId]);

  useEffect(() => {
    if (!selectedModelOption) {
      if (selectedReasoningEffort) {
        setSelectedReasoningEffort(null);
      }
      return;
    }

    if (supportedReasoningLevels.length === 0) {
      if (selectedReasoningEffort) {
        setSelectedReasoningEffort(null);
      }
      return;
    }

    if (selectedReasoningEffort && supportedReasoningLevels.some((level) => level.effort === selectedReasoningEffort)) {
      return;
    }

    setSelectedReasoningEffort(
      selectedModelOption.defaultReasoningLevel
      || supportedReasoningLevels[0]?.effort
      || null
    );
  }, [selectedModelOption, selectedReasoningEffort, supportedReasoningLevels]);

  useEffect(() => {
    if (!isModelPickerOpen && !isReasoningPickerOpen && !isRateLimitOpen) {
      return;
    }

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || composerControlsRef.current?.contains(target)) {
        return;
      }

      setIsModelPickerOpen(false);
      setIsReasoningPickerOpen(false);
      setIsRateLimitOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isModelPickerOpen, isRateLimitOpen, isReasoningPickerOpen]);

  useEffect(() => {
    if (!profileId) {
      return;
    }

    setThemeMode(readThemeModeForProfile(profileId));
  }, [profileId]);

  useEffect(() => {
    if (!profileId) {
      return;
    }

    writeThemeModeForProfile(profileId, themeMode);
  }, [profileId, themeMode]);

  const themeClassName = themeMode === 'dark' ? 'code-ai-theme-dark' : 'code-ai-theme-light';

  if (isBooting) {
    return (
      <div className={cn('code-ai-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
        <div className="w-full max-w-sm rounded-[28px] border border-slate-100 bg-white px-8 py-10 text-center shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)]">
          <img
            src={APP_ICON_PATH}
            alt={APP_DISPLAY_NAME}
            className="mx-auto mb-4 h-14 w-14 rounded-2xl object-cover shadow-sm"
          />
          <div className="flex items-center justify-center gap-3 text-slate-600">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{`טוען את ${APP_DISPLAY_NAME}...`}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!authStatus?.authenticated) {
    return (
      <div className={cn('code-ai-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
        <div className="w-full max-w-lg rounded-[28px] border border-slate-100 bg-white p-8 text-center shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)]">
          <img
            src={APP_ICON_PATH}
            alt={APP_DISPLAY_NAME}
            className="mx-auto mb-5 h-14 w-14 rounded-2xl object-cover shadow-sm"
          />
          <Badge className="mb-4 rounded-full bg-cyan-100 px-3 py-1 text-cyan-800">{APP_DISPLAY_NAME}</Badge>
          <h1 className="text-2xl font-black text-slate-950">{`פתח את ${APP_DISPLAY_NAME} דרך הדומיין הייעודי`}</h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            הממשק הזה זמין דרך הכתובת שעליה ההתקנה הנוכחית מוגדרת.
            {CODE_AI_PUBLIC_ORIGIN && (
              <>
                {' '}כתובת הבסיס שזוהתה כרגע היא
                <span className="mx-1 font-semibold text-slate-900" dir="ltr">{CODE_AI_PUBLIC_ORIGIN}</span>
              </>
            )}
            . אם פתחת אותו דרך host אחר, עבור לכתובת הבסיס של ההתקנה שלך.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => window.location.assign(CODE_AI_PUBLIC_ORIGIN || '/')}
              className="flex h-12 items-center justify-center rounded-[18px] bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              {`פתח את ${APP_DISPLAY_NAME}`}
            </button>
            <Button
              variant="outline"
              onClick={() => void loadAuthStatus()}
              disabled={isCheckingAccess}
              className="h-12 rounded-[18px] border-slate-300 bg-white text-sm font-semibold text-slate-800"
            >
              {isCheckingAccess ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  בודק גישה
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  נסה שוב
                </>
              )}
            </Button>
          </div>
          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (authStatus.deviceUnlocked === false) {
    return (
      <div className={cn('code-ai-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
        <div className="w-full max-w-md rounded-[28px] border border-slate-100 bg-white p-8 text-center shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)]">
          <img
            src={APPLE_TOUCH_ICON_PATH}
            alt={APP_DISPLAY_NAME}
            className="mx-auto mb-5 h-20 w-20 rounded-[22px] shadow-sm"
          />
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Device Unlock
          </div>
          <h1 className="mt-2 text-2xl font-black text-slate-950">פתיחת המכשיר</h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            {`כדי להיכנס ל־${APP_DISPLAY_NAME} מהמכשיר הזה צריך להזין פעם אחת את סיסמת הניהול.`}
          </p>

          <input
            dir="ltr"
            type="password"
            value={devicePassword}
            onChange={(event) => setDevicePassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleDeviceUnlock();
              }
            }}
            placeholder="Management password"
            className="mt-6 w-full rounded-[18px] border border-slate-200 bg-white px-4 py-3 text-center text-sm text-slate-800 outline-none transition focus:border-indigo-300"
          />

          <button
            type="button"
            onClick={() => void handleDeviceUnlock()}
            disabled={isUnlockingDevice}
            className="mt-4 flex h-12 w-full items-center justify-center rounded-[18px] bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {isUnlockingDevice ? (
              <>
                <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                פותח מכשיר...
              </>
            ) : (
              'פתח מכשיר זה'
            )}
          </button>

          {error && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const sidebar = (onClose?: () => void) => (
    <SidebarPanel
      profiles={visibleProfiles}
      profileId={profileId}
      selectedProvider={selectedProvider}
      selectedProfile={currentProfile}
      workspaceMode={workspaceMode}
      search={search}
      sessions={sessions}
      groupedSessions={groupedSessions}
      activeSessionIds={activeSessionIds}
      installMode={installMode}
      showArchived={showArchived}
      selectedSessionId={selectedConversationId}
      isRefreshing={isRefreshing}
      onClose={onClose}
      onProviderChange={handleProviderChange}
      onProfileChange={handleProfileChange}
      onSearchChange={setSearch}
      onRefresh={() => void loadSessionsOnly()}
      onInstallApp={() => void handleInstallApp()}
      isLoggingOut={isLoggingOut}
      onLogout={() => void handleLogout()}
      onNewConversation={handleNewConversation}
      onChooseFolder={handleChooseFolderFromSidebar}
      onToggleWorkspaceMode={handleToggleWorkspaceMode}
      onManageTopic={(session) => void openTopicManager(session)}
      onToggleArchived={() => setShowArchived((current) => !current)}
      onToggleSessionHidden={(sessionId, hidden) => void handleToggleSessionHidden(sessionId, hidden)}
      onSelectSession={handleSelectConversation}
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
    />
  );

  return (
    <div className={cn('code-ai-theme h-dvh w-full overflow-hidden font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.md,.csv,.json,.doc,.docx,.xls,.xlsx"
        className="hidden"
        onChange={handleFilesSelected}
      />

      <div className="flex h-full flex-col">
        <header className="relative flex-none border-b border-slate-100 bg-white/80 px-4 py-2 shadow-[0_10px_22px_-24px_rgba(15,23,42,0.35)] backdrop-blur-xl">
          <button
            onClick={() => {
              setIsHeaderActionsOpen(false);
              setIsSidebarOpen(true);
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-800 active:scale-95"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div dir="rtl" className="mx-auto flex min-h-[66px] max-w-[70vw] flex-col items-center justify-center text-center">
            <h1 className="text-lg font-semibold tracking-tight text-slate-800">
              <span className="inline-flex flex-row-reverse items-center gap-2">
                {currentProfile && (
                  <img
                    src={getProviderLogoSrc(currentProfile.provider)}
                    alt=""
                    className="h-[1.05em] w-[1.05em] shrink-0 object-contain"
                  />
                )}
                <span>{currentProfile ? getProviderDisplayLabel(currentProfile.provider) : APP_DISPLAY_NAME}</span>
              </span>
            </h1>
            <div className="mt-1 flex items-center gap-1.5 opacity-60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-medium">
                {workspaceMode === 'support'
                  ? (isRefreshing ? 'מסנכרן תמיכה' : 'מצב תמיכה פעיל')
                  : (isRefreshing ? 'מסנכרן שיחות' : 'מחובר ומוכן')}
              </span>
            </div>
            {workspaceMode === 'support' && (
              <div className="mt-1 rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-700">
                Support workspace
              </div>
            )}
            {sessionInstruction && (
              <div className="mt-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                הוראה קבועה פעילה
              </div>
            )}
            {selectedSession?.isCompactClone && (
              <div className="mt-1 rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-700">
                Compact handoff
              </div>
            )}
            {activeComposerCwd && (
              <div className="mt-1 max-w-full truncate text-[11px] text-slate-400" dir="ltr" title={activeComposerCwd}>
                {activeComposerCwd}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIsHeaderActionsOpen((current) => !current)}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-800 active:scale-95"
            title="פעולות"
            aria-label="פעולות"
          >
            <LayoutGrid className="h-5 w-5" />
          </button>
        </header>

        {isHeaderActionsOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-[54] cursor-default"
              onClick={() => setIsHeaderActionsOpen(false)}
              aria-label="Close actions menu"
            />
            <div className="fixed left-1/2 top-[4.75rem] z-[55] w-[15.5rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-[1.75rem] border border-slate-200 bg-white p-3 shadow-[0_24px_90px_-32px_rgba(15,23,42,0.35)]">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsHeaderActionsOpen(false);
                    handleNewConversation();
                  }}
                  className="flex flex-col items-center justify-center gap-2 rounded-[1.25rem] bg-indigo-50 px-3 py-4 text-center text-indigo-700 transition hover:bg-indigo-100"
                >
                  <SquarePen className="h-5 w-5" />
                  <span className="text-xs font-semibold">שיחה חדשה</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsHeaderActionsOpen(false);
                    setInstructionDraft(sessionInstruction || '');
                    setIsInstructionDialogOpen(true);
                  }}
                  className="flex flex-col items-center justify-center gap-2 rounded-[1.25rem] bg-amber-50 px-3 py-4 text-center text-amber-700 transition hover:bg-amber-100"
                >
                  <ListPlus className="h-5 w-5" />
                  <span className="text-xs font-semibold">הוראה קבועה</span>
                </button>
                <button
                  type="button"
                  onClick={openMiniGame}
                  className="flex flex-col items-center justify-center gap-2 rounded-[1.25rem] bg-cyan-50 px-3 py-4 text-center text-cyan-700 transition hover:bg-cyan-100"
                >
                  <Gamepad2 className="h-5 w-5" />
                  <span className="text-xs font-semibold">משחקים</span>
                </button>
                <button
                  type="button"
                  onClick={openFileTree}
                  className="flex flex-col items-center justify-center gap-2 rounded-[1.25rem] bg-slate-100 px-3 py-4 text-center text-slate-700 transition hover:bg-slate-200"
                >
                  <FolderTree className="h-5 w-5" />
                  <span className="text-xs font-semibold">עץ קבצים</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsTranscriptCollapsed((current) => !current);
                    setIsHeaderActionsOpen(false);
                  }}
                  className={cn(
                    'col-span-2 flex items-center justify-center gap-2 rounded-[1.25rem] px-3 py-3 text-center transition',
                    isTranscriptCollapsed
                      ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                      : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                  )}
                >
                  <Filter className="h-4 w-4" />
                  <span className="text-xs font-semibold">
                    {isTranscriptCollapsed ? 'בטל כיווץ ציר' : 'כיווץ ציר'}
                  </span>
                </button>
              </div>
              {activeComposerCwd && (
                <div className="mt-3 rounded-[1.25rem] border border-slate-200 bg-slate-50/70 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                        <FolderOpen className="h-4 w-4 text-slate-400" />
                        <span>{getPathBaseName(activeComposerCwd)}</span>
                      </div>
                      <div className="mt-1 truncate text-[11px] text-slate-400" dir="ltr" title={activeComposerCwd}>
                        {activeComposerCwd}
                      </div>
                    </div>
                    {selectedSessionId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setIsHeaderActionsOpen(false);
                          handleNewConversation(activeSessionCwd || currentProfile?.workspaceCwd || null);
                        }}
                        className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                      >
                        שיחה חדשה כאן
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setIsHeaderActionsOpen(false);
                          openFolderPicker();
                        }}
                        className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                      >
                        בחר תיקייה
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        <main ref={mainScrollRef} dir="ltr" className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
          {hiddenTimelineCount > 0 && (
            <div className="flex justify-center">
              <div className="flex w-full max-w-xl flex-col items-center justify-center gap-3">
                {isFullTimelineLoading && (
                  <div className="w-full rounded-3xl border border-indigo-100 bg-white/95 px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/95">
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                          <span>טוען את כל הצ&apos;אט</span>
                          <span>{fullTimelineLoadPercent}%</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-[width] duration-200 ease-out"
                            style={{ width: `${fullTimelineLoadPercent}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  disabled={isFullTimelineLoading}
                  onClick={() => {
                    if (!selectedSessionId || isFullTimelineLoading) {
                      return;
                    }

                    const nextWindowSize = Math.min(
                      totalTimelineLength,
                      renderedTimeline.length + TIMELINE_WINDOW_INCREMENT
                    );
                    recordCodexBreadcrumb('timeline-expanded', {
                      hiddenBefore: hiddenTimelineCount,
                      nextWindowSize,
                    });
                    setIsFullTimelineLoaded(false);
                    setSessionWindowSize(nextWindowSize);
                    void loadSessionDetail(selectedSessionId, profileId, {
                      silent: true,
                      tail: nextWindowSize,
                    });
                  }}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  טען עוד {Math.min(hiddenTimelineCount, TIMELINE_WINDOW_INCREMENT)} אירועים ישנים
                </button>
                <button
                  type="button"
                  disabled={isFullTimelineLoading}
                  onClick={() => {
                    if (!selectedSessionId || isFullTimelineLoading) {
                      return;
                    }

                    recordCodexBreadcrumb('timeline-expanded-full', {
                      hiddenBefore: hiddenTimelineCount,
                      totalTimelineLength,
                    });
                    void loadFullSessionTimeline(selectedSessionId, profileId);
                  }}
                  className="rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-medium text-indigo-700 shadow-sm transition-colors hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200 dark:hover:bg-indigo-900/60"
                >
                  טען צ&apos;אט מלא
                </button>
                </div>
              </div>
            </div>
          )}

          {!selectedSession && visibleQueueItems.length === 0 && !isSending && (
            <div className="flex min-h-[46vh] w-full items-center justify-center">
              {selectedProvider === 'claude' ? (
                <img
                  src={CLAUDE_EMPTY_STATE_ICON_PATH}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none h-24 w-24 select-none object-contain opacity-80 [image-rendering:pixelated] sm:h-28 sm:w-28"
                />
              ) : selectedProvider === 'gemini' ? (
                <img
                  src={GEMINI_EMPTY_STATE_ICON_PATH}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none h-28 w-28 select-none object-contain opacity-90 drop-shadow-[0_10px_24px_rgba(59,130,246,0.08)] sm:h-32 sm:w-32"
                />
              ) : (
                <img
                  src={CODEX_EMPTY_STATE_ICON_PATH}
                  alt=""
                  aria-hidden="true"
                  className="pointer-events-none h-36 w-36 select-none object-contain opacity-95 drop-shadow-[0_12px_30px_rgba(15,23,42,0.08)] sm:h-44 sm:w-44"
                />
              )}
            </div>
          )}

          {timelineBlocks.map((block) => {
            if (block.type === 'tool-row') {
              return (
                <ToolGroupCard
                  key={block.id}
                  blockId={block.id}
                  entries={block.entries}
                  expanded={Boolean(expandedToolGroups[block.id])}
                  onToggle={(blockId) => setExpandedToolGroups((current) => ({
                    ...current,
                    [blockId]: !current[blockId],
                  }))}
                  onOpen={setActiveToolEntry}
                />
              );
            }

            if (block.entry.entryType === 'status') {
              return (
                <StatusRow
                  key={block.entry.id}
                  entry={block.entry}
                  onContinue={block.entry.status === 'aborted' && selectedSessionId
                    ? () => void continueAbortedSession()
                    : undefined}
                  isContinueLoading={isContinuingAbortedSession}
                />
              );
            }

            return (
              <MessageBubble
                key={block.entry.id}
                entry={block.entry}
                onOpenFilePreview={(rawPath) => void handleOpenFilePreview(rawPath)}
                onOpenChanges={selectedSession ? (entryId) => void openSessionChangesForEntry(entryId) : undefined}
                onFork={selectedSession ? (entryId) => forkFromTimelineEntry(entryId) : undefined}
                onDelete={selectedConversationId ? (entryId) => void deleteTurnFromTimelineEntry(entryId) : undefined}
                onTransfer={selectedSession && transferTargetOptions.length > 0
                  ? (entryId, targetProfileId) => void transferFromTimelineEntry(entryId, targetProfileId)
                  : undefined}
                transferOptions={selectedSession ? transferTargetOptions : undefined}
                isTransfering={transferringEntryId === block.entry.id}
                isChangeLoading={isSessionChangeLoading && activeSessionChangeEntryId === block.entry.id}
                isDeleting={deletingEntryId === block.entry.id}
                assistantLabel={assistantMessageLabel}
                commentaryLabel={commentaryMessageLabel}
              />
            );
          })}

          {isCurrentConversationRunning && !isSending && (
            <div className="flex w-full justify-end px-1 py-1">
              <div dir="rtl" className="flex items-center">
                <span className={cn(
                  'animate-pulse bg-gradient-to-r bg-[length:200%_100%] bg-clip-text text-sm font-semibold text-transparent transition-colors duration-500',
                  thinkingToneClass
                )}>
                  {`Thinking${thinkingDots}`}
                </span>
              </div>
            </div>
          )}

          {isSending && (
            <div className="flex w-full justify-end">
              <div className="flex w-full items-end gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 shadow-sm">
                  <Bot className="h-4 w-4" />
                </div>
                <div dir="rtl" className="flex-1 rounded-[1.25rem] rounded-tr-sm border border-slate-100/80 bg-white px-4 py-3 text-[15px] leading-relaxed text-slate-700 shadow-sm">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>שומר את המשימה לשרת...</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={transcriptEndRef} className="h-2" />
        </main>

        <div
          className="flex-none border-t border-slate-100/50 bg-gradient-to-t from-white via-white to-transparent pt-4"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.25rem)' }}
        >
          <div className="px-4 pb-4">
            {error && (
              <div className="mb-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {draftAttachments.length > 0 && (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                {draftAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex min-w-[180px] max-w-[220px] shrink-0 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3"
                  >
                    {attachment.previewUrl ? (
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        className="h-12 w-12 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-50 text-slate-500">
                        {getAttachmentIcon(attachment)}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-700">{attachment.name}</div>
                      <div className="text-xs text-slate-400">{formatBytes(attachment.size)}</div>
                    </div>

                    <button
                      onClick={() => removeAttachment(attachment.id)}
                      className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {isScheduleOpen && (
              <div dir="rtl" className="mb-3 flex flex-col gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setScheduleType('once')}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors',
                      scheduleType === 'once' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                    )}
                  >
                    <CalendarClock className="h-4 w-4" />
                    חד-פעמי
                  </button>
                  <button
                    onClick={() => {
                      setScheduleType('recurring');
                      if (!scheduledFor) {
                        setScheduledFor(mergeScheduledDateTime(getTodayLocalDate(), getCurrentLocalTime()));
                      }
                    }}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium transition-colors',
                      scheduleType === 'recurring' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                    )}
                  >
                    <Repeat className="h-4 w-4" />
                    משימה קבועה
                  </button>
                </div>

                {scheduleType === 'once' ? (
                  <div className="flex gap-2">
                    <input
                      type="date"
                      className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none transition-colors focus:border-indigo-300"
                      value={scheduleDateValue}
                      onChange={(event) => setScheduledFor(mergeScheduledDateTime(event.target.value, scheduleTimeValue))}
                    />
                    <input
                      type="time"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none transition-colors focus:border-indigo-300"
                      value={scheduleTimeValue}
                      onChange={(event) => setScheduledFor(mergeScheduledDateTime(scheduleDateValue, event.target.value))}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <select
                        className="flex-1 appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none transition-colors focus:border-indigo-300"
                        value={recurringFreq}
                        onChange={(event) => setRecurringFreq(event.target.value as 'daily' | 'weekly')}
                      >
                        <option value="daily">כל יום</option>
                        <option value="weekly">כל שבוע (ביום זה)</option>
                      </select>
                      <input
                        type="time"
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 outline-none transition-colors focus:border-indigo-300"
                        value={scheduleTimeValue}
                        onChange={(event) => setScheduledFor(mergeScheduledDateTime(scheduleDateValue, event.target.value))}
                      />
                    </div>
                    <div className="rounded-xl border border-indigo-100 bg-white/80 px-3 py-2 text-xs leading-6 text-indigo-700">
                      {recurringFreq === 'daily'
                        ? 'המשימה תישלח כל יום בשעה שבחרת, ישירות מהשרת.'
                        : `המשימה תישלח כל שבוע ביום ${getWeekdayLabel(scheduledFor) || 'שנבחר'} בשעה שבחרת, ישירות מהשרת.`}
                    </div>
                  </div>
                )}

                <div className="mt-1 flex items-center justify-between px-1 text-xs font-medium text-indigo-500/80">
                  {scheduledFor
                    ? scheduleType === 'recurring'
                      ? recurringFreq === 'daily'
                        ? `המשימה תישלח כל יום החל מ-${formatTimestamp(scheduledFor)}`
                        : `המשימה תישלח כל שבוע ביום ${getWeekdayLabel(scheduledFor)} החל מ-${formatTimestamp(scheduledFor)}`
                      : `ההודעה תישלח אוטומטית ב-${formatTimestamp(scheduledFor)}`
                    : 'ההודעה תתוזמן לשליחה אוטומטית לפי המועד שנבחר.'}
                  <button
                    onClick={() => {
                      setIsScheduleOpen(false);
                      setScheduledFor('');
                      setScheduleType('once');
                    }}
                    className="underline hover:text-indigo-600"
                  >
                    בטל
                  </button>
                </div>
              </div>
            )}

            {forkDraftContext && !selectedSessionId && (
              <div dir="rtl" className="mb-3 rounded-2xl border border-amber-100 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold">
                      <GitBranch className="h-4 w-4" />
                      <span>מזלוג פעיל</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-amber-800/80">
                      {forkDraftContext.sourceTitle}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setForkDraftContext(null)}
                    className="shrink-0 rounded-full border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
                  >
                    בטל מזלוג
                  </button>
                </div>
              </div>
            )}

            <div ref={composerControlsRef} className="relative">
              {!isPendingQueueSectionCollapsed && collapsedQueueItems.length > 0 && (
                <div className="absolute bottom-full -left-1.5 -right-1.5 z-20 mb-3 flex max-h-[40vh] flex-col gap-3 overflow-y-auto px-1.5 pb-2 pt-1.5">
                  {collapsedQueueItems.map((item) => (
                    <QueueItemCard
                      key={item.id}
                      item={item}
                      onCancel={(itemId) => void cancelQueueItem(itemId)}
                      onDelete={(itemId) => void deleteQueueItem(itemId)}
                      onEdit={(queueItem) => void editQueueItem(queueItem)}
                      onRetry={(itemId) => void retryQueueItem(itemId)}
                    />
                  ))}
                </div>
              )}

              <div className="pointer-events-none absolute bottom-full left-2 z-10 mb-2 flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={scrollTranscriptToTop}
                  className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-slate-200/80 bg-white/95 text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-800"
                  aria-label="גלול לראש השיחה"
                  title="למעלה"
                >
                  <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                </button>
                <button
                  type="button"
                  onClick={scrollTranscriptToBottom}
                  className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-slate-200/80 bg-white/95 text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-800"
                  aria-label="גלול לסוף השיחה"
                  title="למטה"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              {collapsedQueueItems.length > 0 && (
                <QueueSummaryButton
                  count={collapsedQueueItems.length}
                  statusSummary={collapsedQueueStatusSummary}
                  collapsed={isPendingQueueSectionCollapsed}
                  onToggle={() => setIsPendingQueueSectionCollapsed((current) => !current)}
                  attached
                />
              )}

              <div
                dir="rtl"
                className={cn(
                  'flex items-end border border-slate-200/80 bg-white p-1.5 shadow-[0_2px_15px_rgba(0,0,0,0.02)] transition-all duration-300 focus-within:border-indigo-200 focus-within:ring-4 focus-within:ring-indigo-50/50',
                  collapsedQueueItems.length > 0 ? 'rounded-[2rem] rounded-t-none border-t-0' : 'rounded-[2rem]'
                )}
              >
                <div className="relative mr-1 flex shrink-0 flex-col items-center justify-end gap-1 self-stretch">
                  <button
                    type="button"
                    onClick={() => {
                      setIsScheduleOpen(false);
                      setIsRateLimitOpen(false);
                      setIsModelPickerOpen((current) => !current);
                      setIsReasoningPickerOpen(false);
                    }}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center text-slate-400 transition-all active:scale-95',
                      isModelPickerOpen
                        ? 'text-violet-600'
                        : 'hover:text-violet-600'
                    )}
                    aria-label="מודל ורמת חשיבה"
                    title={selectedModelOption
                      ? `${selectedModelOption.displayName}${selectedReasoningOption ? ` • ${getReasoningEffortLabel(selectedReasoningOption.effort)}` : ''}`
                      : 'מודל ורמת חשיבה'}
                  >
                    {isModelCatalogLoading ? <Loader2 className="h-[1.05rem] w-[1.05rem] animate-spin" /> : <Brain className="h-[1.05rem] w-[1.05rem]" />}
                  </button>

                  {isModelPickerOpen && (
                    <div className="absolute bottom-full right-0 z-20 mb-2 w-[min(13rem,74vw)] overflow-hidden rounded-[1rem] border border-slate-200/80 bg-white/96 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.2)] backdrop-blur-xl">
                      <div className="border-b border-slate-100/90 bg-gradient-to-b from-violet-50/45 via-white to-white px-2.5 py-2 text-right">
                        <div className="flex items-center justify-between gap-2">
                          <Brain className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-semibold text-slate-700">מודל וחשיבה</div>
                            <div className="truncate text-[9px] text-slate-400">
                              {selectedProviderLabel} המקומי
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="max-h-[58vh] space-y-2 overflow-y-auto p-2">
                        <div className="rounded-[0.85rem] border border-slate-100 bg-slate-50/75 px-2.5 py-2 text-right">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-semibold text-slate-600">פעיל עכשיו</span>
                            {selectedReasoningOption && (
                              <span className="rounded-full border border-violet-100/80 bg-violet-50 px-1.5 py-0.5 text-[9px] text-violet-600">
                                {getReasoningEffortLabel(selectedReasoningOption.effort)}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[10px] font-medium text-slate-700">
                            {selectedModelOption?.displayName || 'אין מודל פעיל'}
                          </div>
                          <div className="mt-0.5 truncate text-[8px] text-slate-400">
                            {selectedModelOption?.description || 'הרשימה נשלפת ישירות מה־CLI הפעיל.'}
                          </div>
                        </div>

                        {modelPermissionSnapshot && (
                          <div className="rounded-[0.85rem] border border-slate-100 bg-white/85 px-2.5 py-2 text-right">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold text-slate-600">הרשאות</span>
                              <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-medium', modelPermissionTone.badgeClassName)}>
                                {modelPermissionSnapshot.accessLabel}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/70">
                              <div
                                className={cn('h-full w-full rounded-full bg-gradient-to-l', modelPermissionTone.barClassName)}
                              />
                            </div>
                            <div className="mt-1 text-[9px] leading-4 text-slate-500">
                              {modelPermissionSnapshot.summary}
                            </div>
                            <div className="mt-1.5 space-y-1 text-[8px] leading-4 text-slate-400">
                              <div className="flex items-center justify-between gap-2">
                                <ShieldCheck className="h-3 w-3 shrink-0 text-slate-300" />
                                <span className="truncate">{modelPermissionSnapshot.modeLabel}</span>
                              </div>
                              {modelPermissionSnapshot.approvalLabel && (
                                <div className="truncate">{modelPermissionSnapshot.approvalLabel}</div>
                              )}
                              {modelPermissionSnapshot.sandboxLabel && (
                                <div className="truncate">{modelPermissionSnapshot.sandboxLabel}</div>
                              )}
                              {modelPermissionSnapshot.toolsLabel && (
                                <div className="truncate">{modelPermissionSnapshot.toolsLabel}</div>
                              )}
                              {modelPermissionSnapshot.trustLabel && (
                                <div className="truncate">{modelPermissionSnapshot.trustLabel}</div>
                              )}
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="mb-1 px-1 text-right text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                            מודלים
                          </div>
                          {availableModels.length === 0 ? (
                            <div className="rounded-[0.85rem] border border-slate-100 bg-slate-50/75 px-2.5 py-3 text-right text-[11px] text-slate-500">
                              {isModelCatalogLoading ? 'טוען מודלים...' : 'לא נמצאו מודלים זמינים לפרופיל הזה.'}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {availableModels.map((model) => (
                                <button
                                  key={model.slug}
                                  type="button"
                                  onClick={() => {
                                    setSelectedModelSlug(model.slug);
                                    setSelectedReasoningEffort(
                                      model.defaultReasoningLevel
                                      || model.supportedReasoningLevels[0]?.effort
                                      || null
                                    );
                                    setIsReasoningPickerOpen(false);
                                  }}
                                  className={cn(
                                    'flex w-full items-start justify-between gap-2 rounded-[0.85rem] border px-2.5 py-2 text-right transition',
                                    selectedModelSlug === model.slug
                                      ? 'border-violet-200/80 bg-violet-50/80 text-violet-800'
                                      : 'border-slate-100 bg-slate-50/75 text-slate-700 hover:border-slate-200/80 hover:bg-white'
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center justify-end gap-1.5">
                                      {model.isConfiguredDefault && (
                                        <span className={cn(
                                          'rounded-full px-1.5 py-0.5 text-[8px] font-semibold',
                                          selectedModelSlug === model.slug
                                            ? 'bg-white/90 text-violet-500'
                                            : 'bg-white/90 text-slate-400'
                                        )}>
                                          ברירת מחדל
                                        </span>
                                      )}
                                      <span className="text-[11px] font-semibold">{model.displayName}</span>
                                    </div>
                                    <div className={cn(
                                      'mt-0.5 line-clamp-2 text-[8px] leading-4',
                                      selectedModelSlug === model.slug ? 'text-violet-600/80' : 'text-slate-500'
                                    )}>
                                      {model.description || model.slug}
                                    </div>
                                  </div>
                                  {selectedModelSlug === model.slug && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div>
                          <div className="mb-1 px-1 text-right text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                            רמת חשיבה
                          </div>
                          {!selectedModelOption || supportedReasoningLevels.length === 0 ? (
                            <div className="rounded-[0.85rem] border border-slate-100 bg-slate-50/75 px-2.5 py-3 text-right text-[11px] text-slate-500">
                              בחר מודל עם רמות חשיבה נתמכות כדי לבחור effort.
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {supportedReasoningLevels.map((level) => (
                                <button
                                  key={level.effort}
                                  type="button"
                                  onClick={() => {
                                    setSelectedReasoningEffort(level.effort);
                                    setIsReasoningPickerOpen(false);
                                    setIsModelPickerOpen(false);
                                  }}
                                  className={cn(
                                    'flex w-full items-start justify-between gap-2 rounded-[0.85rem] border px-2.5 py-2 text-right transition',
                                    selectedReasoningEffort === level.effort
                                      ? 'border-sky-200/80 bg-sky-50/80 text-sky-800'
                                      : 'border-slate-100 bg-slate-50/75 text-slate-700 hover:border-slate-200/80 hover:bg-white'
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="text-[11px] font-semibold">{getReasoningEffortLabel(level.effort)}</div>
                                    {level.description && (
                                      <div className={cn(
                                        'mt-0.5 text-[8px] leading-4',
                                        selectedReasoningEffort === level.effort ? 'text-sky-700/80' : 'text-slate-500'
                                      )}>
                                        {level.description}
                                      </div>
                                    )}
                                  </div>
                                  {selectedReasoningEffort === level.effort && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => {
                      setIsRateLimitOpen(false);
                      setIsModelPickerOpen(false);
                      setIsReasoningPickerOpen(false);
                      setIsScheduleOpen((current) => !current);
                    }}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center text-slate-400 transition-all active:scale-95',
                      isScheduleOpen
                        ? 'text-indigo-600'
                        : 'hover:text-indigo-500'
                    )}
                  >
                    <CalendarClock className="h-4.5 w-4.5" />
                  </button>
                </div>

                <Textarea
                  dir="rtl"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="הודעה חדשה, בקשה או תזמון..."
                  className="max-h-32 flex-1 resize-none border-0 bg-transparent px-2 py-3 text-right text-[15px] text-slate-800 shadow-none placeholder:text-slate-300 focus-visible:ring-0"
                  rows={1}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      if (isMobileEnterBehavior) {
                        return;
                      }

                      event.preventDefault();
                      void enqueueCurrentPrompt();
                    }
                  }}
                />

                <div className="relative ml-1 flex shrink-0 flex-col items-center justify-end gap-1 self-stretch">
                  <button
                    type="button"
                    onClick={() => {
                      setIsScheduleOpen(false);
                      setIsModelPickerOpen(false);
                      setIsReasoningPickerOpen(false);
                      setIsRateLimitOpen((current) => !current);
                    }}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center text-slate-300 transition-colors active:scale-95',
                      isRateLimitOpen
                        ? 'text-sky-500'
                        : 'hover:text-sky-500'
                    )}
                    aria-label="מגבלות שימוש"
                    title="מגבלות שימוש"
                  >
                    {isRateLimitLoading
                      ? <Loader2 className="h-[1.05rem] w-[1.05rem] animate-spin" />
                      : <Gauge className="h-[1.05rem] w-[1.05rem]" />}
                  </button>

                  {isRateLimitOpen && (
                    <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(11.5rem,68vw)] overflow-hidden rounded-[1rem] border border-slate-200/80 bg-white/96 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.2)] backdrop-blur-xl">
                      <div className="border-b border-slate-100/90 bg-gradient-to-b from-sky-50/45 via-white to-white px-2.5 py-2 text-right">
                        <div className="flex items-center justify-between gap-2">
                          <Gauge className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-semibold text-slate-700">מגבלות שימוש</div>
                            <div className="truncate text-[9px] text-slate-400">
                              {rateLimitSnapshot?.planType ? `תוכנית ${rateLimitSnapshot.planType}` : 'נתונים חיים מה־CLI'}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 p-2">
                        {[
                          { key: 'primary', label: '5 שעות', window: rateLimitSnapshot?.primary || null },
                          { key: 'secondary', label: 'שבוע', window: rateLimitSnapshot?.secondary || null },
                        ].map(({ key, label, window }) => {
                          const usedPercent = clampPercent(window?.usedPercent ?? null);
                          const toneClass = key === 'primary'
                            ? 'from-sky-300 via-cyan-200 to-emerald-200'
                            : 'from-violet-300 via-fuchsia-200 to-rose-200';
                          return (
                            <div key={key} className="rounded-[0.85rem] border border-slate-100 bg-slate-50/75 px-2.5 py-2 text-right">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] font-semibold text-slate-600">
                                  {getRateLimitWindowLabel(window?.windowMinutes ?? null, label)}
                                </span>
                                <span className="text-[10px] text-slate-400">
                                  {window?.usedPercent !== null && window?.usedPercent !== undefined
                                    ? `${Math.round(usedPercent)}%`
                                    : 'ללא נתון'}
                                </span>
                              </div>
                              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/70">
                                <div
                                  className={cn('h-full rounded-full bg-gradient-to-l transition-[width]', toneClass)}
                                  style={{ width: `${usedPercent}%` }}
                                />
                              </div>
                              <div className="mt-1 text-[9px] text-slate-400">
                                מתאפס {formatCompactTimestamp(window?.resetsAtIso ?? null)}
                              </div>
                            </div>
                          );
                        })}

                        {selectedSessionId && rateLimitSnapshot?.context && (
                          <div className="rounded-[0.8rem] border border-slate-100 bg-white/85 px-2.5 py-2 text-right">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold text-slate-600">
                                קונטקסט
                              </span>
                              <span className="text-[10px] text-slate-400">
                                {rateLimitSnapshot.context.usagePercent !== null && rateLimitSnapshot.context.usagePercent !== undefined
                                  ? `${Math.round(clampPercent(rateLimitSnapshot.context.usagePercent))}%`
                                  : 'ללא נתון'}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/70">
                              <div
                                className="h-full rounded-full bg-gradient-to-l from-amber-300 via-sky-200 to-cyan-200 transition-[width]"
                                style={{ width: `${clampPercent(rateLimitSnapshot.context.usagePercent ?? null)}%` }}
                              />
                            </div>
                            <div className="mt-1 text-[9px] text-slate-400">
                              {formatCompactTokenCount(getContextUsageDisplayTokens(rateLimitSnapshot.context))} / {formatCompactTokenCount(rateLimitSnapshot.context.modelContextWindow)}
                            </div>
                            {rateLimitSnapshot.context.cachedInputTokens !== null && rateLimitSnapshot.context.cachedInputTokens !== undefined && (
                              <div className="mt-0.5 text-[8px] text-slate-300">
                                cache {formatCompactTokenCount(rateLimitSnapshot.context.cachedInputTokens)}
                              </div>
                            )}
                          </div>
                        )}

                        {!selectedSessionId && (
                          <div className="rounded-[0.8rem] border border-dashed border-slate-200 bg-white/85 px-2.5 py-2 text-right">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-semibold text-slate-600">
                                קונטקסט
                              </span>
                              <span className="text-[10px] text-slate-400">0%</span>
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200/70">
                              <div
                                className="h-full rounded-full bg-gradient-to-l from-amber-300 via-sky-200 to-cyan-200 transition-[width]"
                                style={{ width: '0%' }}
                              />
                            </div>
                            <div className="mt-1 text-[9px] text-slate-400">
                              0 / —
                            </div>
                            <div className="mt-0.5 text-[8px] text-slate-300">
                              טרם נשלחה הודעה, לכן עדיין אין session snapshot.
                            </div>
                          </div>
                        )}

                        {!isRateLimitLoading && !rateLimitSnapshot?.primary && !rateLimitSnapshot?.secondary && !selectedSessionId && (
                          <div className="rounded-[0.85rem] border border-dashed border-slate-200 bg-white/75 px-2.5 py-2 text-right text-[10px] text-slate-400">
                            אין עדיין נתוני שימוש זמינים לפרופיל הזה.
                          </div>
                        )}

                        {!isRateLimitLoading && !rateLimitSnapshot?.primary && !rateLimitSnapshot?.secondary && selectedSessionId && !rateLimitSnapshot?.context && (
                          <div className="rounded-[0.85rem] border border-dashed border-slate-200 bg-white/75 px-2.5 py-2 text-right text-[10px] text-slate-400">
                            עדיין אין snapshot קונטקסט לשיחה הזאת.
                          </div>
                        )}

                        {rateLimitSnapshot?.rateLimitReachedType && (
                          <div className="rounded-[0.85rem] border border-rose-100/90 bg-rose-50/70 px-2.5 py-2 text-right text-[9px] text-rose-600">
                            הושגה מגבלה: {rateLimitSnapshot.rateLimitReachedType}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className={cn(
                      'shrink-0 p-2.5 text-slate-400 transition-all active:scale-95',
                      isUploading
                        ? 'text-slate-300'
                        : 'hover:text-indigo-500'
                    )}
                  >
                    {isUploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
                  </button>
                </div>

                <button
                  onClick={() => void enqueueCurrentPrompt()}
                  disabled={isUploading || isSending || (!prompt.trim() && draftAttachments.length === 0)}
                  className={cn(
                    'mb-[3px] ml-[3px] shrink-0 rounded-full border border-white/80 bg-gradient-to-br from-rose-200 via-amber-100 to-sky-200 p-[0.56rem] text-slate-700 shadow-[0_12px_26px_-16px_rgba(99,102,241,0.5)] transition-all active:scale-95',
                    'hover:from-rose-200 hover:via-amber-100 hover:to-sky-200 hover:text-slate-800',
                    'disabled:border-slate-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none disabled:opacity-35'
                  )}
                >
                  <Send className="h-4 w-4 -ml-0.5" />
                </button>
              </div>
            </div>

            <div dir="rtl" className="mt-3 flex items-center justify-between gap-3 px-1 text-xs text-slate-400">
              <span>
                {selectedSessionId
                  ? 'כל הודעה תמשיך לתור השרת עבור השיחה הפתוחה.'
                  : activeComposerCwd
                    ? `שיחה חדשה תתחיל מתוך ${getPathBaseName(activeComposerCwd)} בשרת.`
                    : 'גם בלי שיחה פתוחה, השרת ייצור session חדש וימשיך לבד.'}
              </span>
              {(activeQueueCount > 0 || currentProfile) && (
                <span className="shrink-0">
                  {activeQueueCount > 0 ? `${activeQueueCount} משימות פעילות` : currentProfile?.label}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {isSidebarOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/10 backdrop-blur-sm transition-opacity"
            onClick={() => setIsSidebarOpen(false)}
          />
          <div className="relative ml-auto h-full w-full max-w-full animate-in slide-in-from-right bg-white shadow-2xl duration-300 sm:w-[26rem] sm:max-w-[94vw]">
            {sidebar(() => setIsSidebarOpen(false))}
          </div>
        </div>
      )}

      {isInstructionDialogOpen && (
        <div className="fixed inset-0 z-[72] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setIsInstructionDialogOpen(false)}
            aria-label="Close instruction dialog"
          />
          <div className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700">
                  <ListPlus className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Session Instruction
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-800">
                    הוראה קבועה לסשן
                  </div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">
                    הטקסט כאן יתווסף אוטומטית לכל הודעה חדשה שתישלח מהשיחה הפעילה.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsInstructionDialogOpen(false)}
                className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-5">
              <Textarea
                value={instructionDraft}
                onChange={(event) => setInstructionDraft(event.target.value)}
                placeholder="למשל: תמיד ענה בקצרה, בדוק קודם קבצים רלוונטיים, ואל תיצור קבצים בלי צורך."
                rows={5}
                className="min-h-[140px] resize-none rounded-[1.5rem] border border-slate-200 bg-white px-4 py-4 text-[15px] leading-7 text-slate-800 shadow-none placeholder:text-slate-300 focus-visible:ring-0"
              />

              <div className="mt-4 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={async () => {
                    if (!profileId || !currentQueueKey) {
                      return;
                    }

                    setIsInstructionSaving(true);
                    try {
                      const nextInstruction = await saveSessionInstruction(profileId, currentQueueKey, null);
                      setSessionInstruction(nextInstruction);
                      setInstructionDraft('');
                      setIsInstructionDialogOpen(false);
                    } catch (instructionError: any) {
                      setError(instructionError.message || 'Failed to delete session instruction');
                    } finally {
                      setIsInstructionSaving(false);
                    }
                  }}
                  disabled={isInstructionSaving || (!sessionInstruction && !instructionDraft.trim())}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  מחק
                </button>
                <div className="flex items-center gap-2">
                  {isInstructionLoading && <span className="text-xs text-slate-400">טוען...</span>}
                  <button
                    type="button"
                    onClick={() => void saveCurrentSessionInstruction()}
                    disabled={isInstructionSaving}
                    className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
                  >
                    {isInstructionSaving ? 'שומר...' : 'שמור'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <GamePickerDialog
        isOpen={isGamePickerOpen}
        onClose={() => setIsGamePickerOpen(false)}
        onStart={startMiniGame}
      />

      <MiniGameDialog
        isOpen={isGameOpen}
        onClose={() => setIsGameOpen(false)}
        sessionActiveCount={currentSessionActiveQueueCount}
        sessionCompletionSignal={gameSessionCompletionSignal}
      />

      <RunnerGameDialog
        isOpen={isRunnerGameOpen}
        onClose={() => setIsRunnerGameOpen(false)}
        sessionActiveCount={currentSessionActiveQueueCount}
        sessionCompletionSignal={gameSessionCompletionSignal}
      />

      <SudokuDialog
        isOpen={isSudokuOpen}
        onClose={() => setIsSudokuOpen(false)}
      />

      <TempleGemQuestDialog
        isOpen={isTempleGemQuestOpen}
        onClose={() => setIsTempleGemQuestOpen(false)}
        sessionActiveCount={currentSessionActiveQueueCount}
        sessionCompletionSignal={gameSessionCompletionSignal}
      />

      <BiomeSnakeDialog
        isOpen={isBiomeSnakeOpen}
        onClose={() => setIsBiomeSnakeOpen(false)}
        sessionActiveCount={currentSessionActiveQueueCount}
        sessionCompletionSignal={gameSessionCompletionSignal}
      />

      <RailHeistDialog
        isOpen={isRailHeistOpen}
        onClose={closeRailHeistDialog}
      />

      <IronDesertDialog
        isOpen={isIronDesertOpen}
        onClose={closeIronDesertDialog}
      />

      <VaultRunnerDialog
        isOpen={isVaultRunnerOpen}
        onClose={closeVaultRunnerDialog}
      />

      {isFileTreeOpen && (
        <FileTreeDialog
          browser={fileTreeBrowser}
          loadedNodes={fileTreeNodes}
          expandedPaths={fileTreeExpandedPaths}
          loadingPaths={fileTreeLoadingPaths}
          error={fileTreeError}
          pathValue={fileTreePathInput}
          filterValue={fileTreeFilter}
          onClose={() => setIsFileTreeOpen(false)}
          onPathChange={setFileTreePathInput}
          onFilterChange={setFileTreeFilter}
          onOpenPath={openFileTreePathFromInput}
          onNavigateTo={(path) => {
            setFileTreeNodes({});
            setFileTreeExpandedPaths({});
            void loadFileTree(path, { replaceRoot: true, expandRoot: true });
          }}
          onToggleDirectory={toggleFileTreeDirectory}
          onPreviewFile={(path) => {
            setIsFileTreeOpen(false);
            void handleOpenFilePreview(path);
          }}
        />
      )}

      {isFolderPickerOpen && (
        <FolderPickerDialog
          browser={folderBrowser}
          isLoading={isFolderBrowserLoading}
          error={folderBrowserError}
          pathValue={folderPathInput}
          canGoBack={folderBackStackRef.current.length > 0}
          canGoForward={folderForwardStackRef.current.length > 0}
          onClose={() => setIsFolderPickerOpen(false)}
          onPathChange={setFolderPathInput}
          onOpenPath={openFolderPathFromInput}
          onNavigateBack={navigateFolderPickerBack}
          onNavigateForward={navigateFolderPickerForward}
          onNavigateTo={(path) => void loadFolderPicker(path, { pushHistory: true })}
          onSelectCurrent={() => {
            if (folderBrowser?.currentPath) {
              selectFolderForDraft(folderBrowser.currentPath);
            }
          }}
        />
      )}

      {topicSession && (
        <TopicManagerDialog
          session={topicSession}
          topics={folderTopics}
          isLoading={isTopicLoading}
          error={topicError}
          customSessionTitle={customSessionTitle}
          isSavingTitle={isSavingSessionTitle}
          newTopicName={newTopicName}
          newTopicIcon={newTopicIcon}
          newTopicColorKey={newTopicColorKey}
          onClose={() => setTopicSession(null)}
          onAssignTopic={(topicId) => void assignTopicToSession(topicSession, topicId)}
          onSaveSessionTitle={() => void saveSessionTitle(topicSession, customSessionTitle)}
          onResetSessionTitle={() => void saveSessionTitle(topicSession, null)}
          onChangeCustomSessionTitle={setCustomSessionTitle}
          onCreateTopic={() => void createAndAssignTopic()}
          onChangeName={setNewTopicName}
          onChangeIcon={setNewTopicIcon}
          onChangeColorKey={(value) => setNewTopicColorKey(value as keyof typeof TOPIC_COLOR_PRESETS)}
        />
      )}

      {pendingDeleteTurn && (
        <div className="fixed inset-0 z-[61] flex items-end justify-center bg-slate-950/18 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setPendingDeleteTurn(null)}
            aria-label="Close delete confirmation dialog"
          />
          <div className="relative z-10 w-full max-w-[20rem] overflow-hidden rounded-[1.6rem] border border-slate-100/90 bg-white px-4 py-4 text-right shadow-[0_26px_70px_-34px_rgba(15,23,42,0.28)]">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-500">
                <Trash2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">
                  למחוק את הסבב הזה?
                </div>
                <div className="mt-1 text-[12px] leading-6 text-slate-500">
                  {pendingDeleteTurn.shouldStopRunningTurn
                    ? 'הסבב הפעיל ייעצר, והודעת המשתמש יחד עם תשובת ה-AI יוסרו מהמשך השיחה.'
                    : 'הודעת המשתמש יחד עם תשובת ה-AI יוסרו מהמשך השיחה.'}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteTurn(null)}
                className="h-11 flex-1 rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
              >
                בטל
              </button>
              <button
                type="button"
                onClick={() => void confirmDeletePendingTurn()}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-rose-100 bg-rose-50 text-rose-600 transition hover:border-rose-200 hover:bg-rose-100"
                aria-label="אשר מחיקה"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {isSessionChangeDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => {
              setIsSessionChangeDialogOpen(false);
              setActiveSessionChangeRecord(null);
              setActiveSessionChangeEntryId(null);
              setActiveSessionChangeFileId(null);
            }}
            aria-label="Close session changes dialog"
          />
          <div className="relative z-10 flex max-h-[84dvh] w-full max-w-5xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-50 text-sky-600">
                  <FileDiff className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    שינויי קבצים
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-800">
                    הקבצים שהשיחה האחרונה שינתה
                  </div>
                  {activeSessionChangeRecord && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                        {getProviderDisplayLabel(activeSessionChangeRecord.provider)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1">
                        {activeSessionChangeRecord.summary.totalFiles} קבצים
                      </span>
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">
                        +{activeSessionChangeRecord.summary.additions.toLocaleString('en-US')}
                      </span>
                      <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-rose-700">
                        -{activeSessionChangeRecord.summary.deletions.toLocaleString('en-US')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeSessionChangeRecord && activeSessionChangeFileId && (
                  <CopyButton
                    text={activeSessionChangeRecord.files.find((file) => file.id === activeSessionChangeFileId)?.diffText || ''}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setIsSessionChangeDialogOpen(false);
                    setActiveSessionChangeRecord(null);
                    setActiveSessionChangeEntryId(null);
                    setActiveSessionChangeFileId(null);
                  }}
                  className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {isSessionChangeLoading ? (
                <div className="flex min-h-[18rem] items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50/80">
                  <div className="flex items-center gap-3 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>טוען את שינויי הקבצים של השיחה...</span>
                  </div>
                </div>
              ) : (
                <SessionChangeDetailViewer
                  record={activeSessionChangeRecord}
                  activeFileId={activeSessionChangeFileId}
                  onSelectFile={setActiveSessionChangeFileId}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {activeToolEntry && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setActiveToolEntry(null)}
            aria-label="Close tool dialog"
          />
          {(() => {
            const dialogSubtitle = resolveToolDialogSubtitle(activeToolEntry);

            return (
              <div className="relative z-10 flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
              <div className="flex items-start gap-3">
                <div className={cn(
                  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
                  getToolEntryTone(activeToolEntry).icon
                )}>
                  {(() => {
                    const Icon = getToolEntryIcon(activeToolEntry);
                    return <Icon className="h-5 w-5" />;
                  })()}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    כלי עזר
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-800">
                    {activeToolEntry.title || activeToolEntry.toolName || 'Tool'}
                  </div>
                  {dialogSubtitle && (
                    <div className="mt-1 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">
                      {dialogSubtitle}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CopyButton
                  text={[activeToolEntry.title, activeToolEntry.subtitle, activeToolEntry.text].filter(Boolean).join('\n\n')}
                />
                <button
                  type="button"
                  onClick={() => setActiveToolEntry(null)}
                  className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <ToolDetailViewer entry={activeToolEntry} />
            </div>
          </div>
            );
          })()}
        </div>
      )}

      {isFilePreviewOpen && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={closeFilePreview}
            aria-label="Close file preview dialog"
          />
          <div className="relative z-10 flex w-full max-w-3xl max-h-[82dvh] flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {activeFileMatches.length > 0 ? 'File Matches' : 'File Preview'}
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-800">
                    {activeFilePreview?.name
                      || (activeFileMatches.length > 0 ? `נמצאו ${activeFileMatches.length} קבצים` : 'טוען קובץ...')}
                  </div>
                  {activeFilePreview && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span>{formatBytes(activeFilePreview.size)}</span>
                      <span>•</span>
                      <span dir="ltr">{activeFilePreview.path}</span>
                      {activeFilePreview.lineNumber && (
                        <>
                          <span>•</span>
                          <span>שורה {activeFilePreview.lineNumber}</span>
                        </>
                      )}
                    </div>
                  )}
                  {!activeFilePreview && activeFileMatches.length > 0 && (
                    <div className="mt-1 text-xs text-slate-500">
                      בחר קובץ אחד עבור "{activeFileMatchesQuery}"
                    </div>
                  )}
                  {!activeFilePreview && filePreviewError && (
                    <div className="mt-1 text-xs text-red-600">{filePreviewError}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeFilePreview && (
                  <>
                    <CopyButton text={activeFilePreview.content || activeFilePreview.path} />
                    <button
                      type="button"
                      onClick={() => void handleDownloadActiveFile()}
                      disabled={isFileDownloadLoading}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                      aria-label="הורד קובץ"
                      title="הורד קובץ"
                    >
                      {isFileDownloadLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={closeFilePreview}
                  className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              {isFilePreviewLoading && !activeFilePreview ? (
                <div className="flex min-h-[240px] items-center justify-center rounded-[1.5rem] border border-slate-100 bg-slate-50/70 text-sm text-slate-500">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>טוען את הקובץ מהשרת...</span>
                  </div>
                </div>
              ) : activeFileMatches.length > 0 ? (
                <div className="space-y-3">
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-sm text-slate-600">
                    הנתיב שסופק לא היה חד משמעי. בחר קובץ אחד להמשך.
                  </div>
                  <div className="space-y-3">
                    {activeFileMatches.map((match) => (
                      <button
                        key={match.path}
                        type="button"
                        onClick={() => void handleOpenFilePreview(
                          activeFileMatchesLineNumber ? `${match.path}:${activeFileMatchesLineNumber}` : match.path
                        )}
                        className="flex w-full flex-col items-start gap-2 rounded-[1.25rem] border border-slate-100 bg-white px-4 py-4 text-right shadow-sm transition-colors hover:bg-slate-50"
                      >
                        <div className="flex w-full items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-800" dir="ltr" title={match.path}>
                              {match.relativePath}
                            </div>
                            <div className="mt-1 truncate text-xs text-slate-500" dir="ltr" title={match.path}>
                              {match.path}
                            </div>
                          </div>
                          <div className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-500">
                            {formatBytes(match.size)}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          <span>עודכן {formatTimestamp(match.updatedAt)}</span>
                          <span>•</span>
                          <span dir="ltr">{match.rootPath}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : filePreviewError ? (
                <div className="rounded-[1.5rem] border border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                  {filePreviewError}
                </div>
              ) : activeFilePreview?.previewKind === 'image' ? (
                <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 p-3">
                  <img
                    src={activeFilePreview.contentUrl}
                    alt={activeFilePreview.name}
                    className="mx-auto max-h-[68dvh] w-auto max-w-full rounded-[1.25rem] object-contain"
                  />
                </div>
              ) : activeFilePreview?.previewKind === 'pdf' ? (
                <iframe
                  src={activeFilePreview.contentUrl}
                  title={activeFilePreview.name}
                  className="h-[68dvh] w-full rounded-[1.5rem] border border-slate-100 bg-white"
                />
              ) : activeFilePreview?.previewKind === 'video' ? (
                <div className="rounded-[1.5rem] border border-slate-100 bg-slate-950 p-3">
                  <video
                    src={activeFilePreview.contentUrl}
                    controls
                    className="max-h-[68dvh] w-full rounded-[1.25rem]"
                  />
                </div>
              ) : activeFilePreview?.previewKind === 'audio' ? (
                <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 px-4 py-6">
                  <audio src={activeFilePreview.contentUrl} controls className="w-full" />
                </div>
              ) : activeFilePreview?.previewKind === 'embed' ? (
                <object
                  data={activeFilePreview.contentUrl}
                  type={activeFilePreview.mimeType}
                  className="h-[68dvh] w-full rounded-[1.5rem] border border-slate-100 bg-white"
                >
                  <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 px-4 py-4 text-sm text-slate-500">
                    הדפדפן לא הצליח להציג את הקובץ ישירות. אפשר להוריד אותו מהכפתור למעלה.
                  </div>
                </object>
              ) : activeFilePreview?.content ? (
                <div className="space-y-3">
                  {activeFilePreview.truncated && (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      מוצגת תצוגה חלקית של הקובץ. להורדה מלאה השתמש בכפתור "הורד".
                    </div>
                  )}
                  {activeFilePreview.previewKind === 'markdown' ? (
                    <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 px-4 py-4">
                      <MessageMarkdown
                        text={activeFilePreview.content}
                        isUser={false}
                        onOpenFilePreview={(rawPath) => void handleOpenFilePreview(rawPath)}
                      />
                    </div>
                  ) : activeFilePreview.previewKind === 'code' ? (
                    <CodexCodeBlock
                      code={activeFilePreview.content}
                      language={activeFilePreview.codeLanguage}
                    />
                  ) : (
                    <pre
                      dir="ltr"
                      className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 px-4 py-4 text-[13px] leading-6 text-slate-700 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                    >
                      {activeFilePreview.content}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 px-4 py-4 text-sm text-slate-500">
                  {activeFilePreview?.previewKind === 'binary'
                    ? 'הקובץ זוהה כבינארי ואינו מתאים לתצוגת טקסט. אפשר להוריד אותו ישירות.'
                    : 'אין תצוגה מקדימה לקובץ הזה. אפשר להוריד אותו ישירות.'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isInstallHelpOpen && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setIsInstallHelpOpen(false)}
            aria-label="Close install help dialog"
          />
          <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_28px_90px_-36px_rgba(15,23,42,0.38)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <Download className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Install App
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-800">
                    התקנה למסך הבית
                  </div>
                  <div className="mt-1 text-sm leading-6 text-slate-500">
                    {isIosInstallFlow
                      ? 'באייפון אין prompt אוטומטי, לכן ההתקנה נעשית דרך Safari.'
                      : 'אם הדפדפן לא הציג prompt, אפשר להתקין ידנית דרך תפריט הדפדפן.'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsInstallHelpOpen(false)}
                className="rounded-full bg-slate-50 p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div dir="rtl" className="space-y-3 px-5 py-5 text-sm leading-7 text-slate-700">
              {isIosInstallFlow ? (
                <>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    1. פתח את האתר ב־Safari.
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    2. לחץ על כפתור השיתוף של Safari.
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    3. בחר <span className="font-semibold">הוסף למסך הבית</span>.
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    4. אשר, והאפליקציה תיפתח מהאייקון החדש עם הלוגו שסיפקת.
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    1. פתח את תפריט הדפדפן בטלפון.
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    2. בחר <span className="font-semibold">Install app</span> או <span className="font-semibold">Add to Home screen</span>.
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3">
                    3. אשר את ההתקנה, והאפליקציה תופיע כאפליקציה נפרדת עם האייקון החדש.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CodexMobileApp;
