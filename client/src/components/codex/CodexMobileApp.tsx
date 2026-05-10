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
  SquarePen,
  Tag,
  Sun,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CodexCodeBlock } from '@/components/codex/CodexCodeBlock';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
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
  codexHome: string;
  workspaceCwd: string;
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

const INITIAL_TIMELINE_WINDOW_SIZE = 120;
const TIMELINE_WINDOW_INCREMENT = 120;
const TIMELINE_FULL_LOAD_CHUNK_SIZE = 400;
const APP_DISPLAY_NAME = 'code-ai';
const APP_ICON_PATH = '/icons/code-ai-512.png';
const APPLE_TOUCH_ICON_PATH = '/icons/apple-touch-icon.png';
const CODEX_EMPTY_STATE_ICON_PATH = '/icons/codex-empty-state.png';
const CLAUDE_EMPTY_STATE_ICON_PATH = '/icons/claude-agent.png';
const GEMINI_EMPTY_STATE_ICON_PATH = '/icons/gemini-agent.png';
const PROVIDER_DISPLAY_ORDER: CodexProfile['provider'][] = ['codex', 'claude', 'gemini'];

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
  onFork,
  onTransfer,
  transferOptions,
  isTransfering = false,
  assistantLabel = 'Codex',
  commentaryLabel = 'Codex עובד',
}: {
  entry: CodexTimelineEntry;
  onOpenFilePreview: (rawPath: string) => void;
  onFork?: (entryId: string) => void;
  onTransfer?: (entryId: string, targetProfileId: string) => void;
  transferOptions?: TransferTargetOption[];
  isTransfering?: boolean;
  assistantLabel?: string;
  commentaryLabel?: string;
}) {
  const [isTransferMenuOpen, setIsTransferMenuOpen] = useState(false);
  const isUser = entry.role === 'user';
  const isCommentary = entry.kind === 'commentary';
  const isTransfer = entry.kind === 'transfer';
  const senderLabel = isTransfer ? 'העברה' : isUser ? 'אתה' : isCommentary ? commentaryLabel : assistantLabel;
  const messageText = entry.text || '';
  const showForkAction = Boolean(onFork) && !isTransfer;
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
                  <div className="absolute bottom-full left-0 z-10 mb-2 min-w-[10rem] rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_16px_35px_-24px_rgba(15,23,42,0.24)]">
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
                          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-right text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                        >
                          <Repeat className="h-3.5 w-3.5 text-slate-400" />
                          <span>{option.label}</span>
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
          <div className="grid grid-cols-3 gap-2">
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
              placeholder="/root/projects/bina-cshera"
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
      <div className="relative z-10 flex w-full max-w-sm flex-col overflow-hidden rounded-[2rem] border border-sky-100 bg-white text-slate-800 shadow-[0_28px_90px_-36px_rgba(56,189,248,0.28)]">
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
  const [isGameOpen, setIsGameOpen] = useState(false);
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
  const [rateLimitSnapshot, setRateLimitSnapshot] = useState<CodexRateLimitSnapshotResponse | null>(null);
  const [selectedModelSlug, setSelectedModelSlug] = useState<string | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);
  const [scheduledFor, setScheduledFor] = useState('');
  const [draftConversationKey, setDraftConversationKey] = useState(createDraftConversationKey);
  const [isDraftConversation, setIsDraftConversation] = useState(true);
  const [activeToolEntry, setActiveToolEntry] = useState<CodexTimelineEntry | null>(null);
  const [topicSession, setTopicSession] = useState<CodexSessionSummary | null>(null);
  const [folderTopics, setFolderTopics] = useState<CodexSessionTopic[]>([]);
  const [isTopicLoading, setIsTopicLoading] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [customSessionTitle, setCustomSessionTitle] = useState('');
  const [isSavingSessionTitle, setIsSavingSessionTitle] = useState(false);
  const [transferringEntryId, setTransferringEntryId] = useState<string | null>(null);
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
  const currentQueueKey = selectedSessionId || draftConversationKey;
  const draftSidebarSessionId = forkDraftContext ? toDraftSessionId(draftConversationKey) : null;
  const activeQueueCount = queueItems.filter(isQueueItemActive).length;
  const effectiveDraftCwd = draftCwd || null;
  const activeSessionCwd = selectedSession?.cwd || null;
  const currentProfile = profiles.find((profile) => profile.id === profileId) || null;
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
      const currentStillAvailable = profileId
        ? data.profiles.find((profile) => profile.id === profileId) || null
        : null;
      const preferred = currentStillAvailable
        || data.profiles.find((profile) => profile.defaultProfile)
        || data.profiles[0];
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
    setIsGameOpen(false);
    setThemeMode(readThemeModeForProfile(nextProfileId));
    folderBackStackRef.current = [];
    folderForwardStackRef.current = [];
    clearDraftAttachments();
    setDraftConversationKey(createDraftConversationKey());
    setProfileId(nextProfileId);
  }

  function handleProviderChange(nextProvider: CodexProfile['provider']) {
    const providerProfiles = profiles.filter((profile) => profile.provider === nextProvider);
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
        setIsGameOpen(false);
        setRateLimitSnapshot(null);
        setAvailableModels([]);
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
      setSelectedModelSlug(nextModelSlug);
      setSelectedReasoningEffort(nextReasoningEffort);
    } catch (modelCatalogError: any) {
      if (requestToken === latestModelCatalogLoadTokenRef.current) {
        setAvailableModels([]);
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
    || profiles.find((profile) => profile.defaultProfile)?.provider
    || profiles[0]?.provider
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
    () => resolveTransferTargetProfiles(profiles, currentProfile),
    [currentProfile, profiles]
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
      setRateLimitSnapshot(null);
      setSelectedModelSlug(null);
      setSelectedReasoningEffort(null);
      return;
    }

    void loadModelCatalog(profileId);
    void loadRateLimitSnapshot(profileId, selectedSessionId);
  }, [profileId, selectedSessionId]);

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

  const themeClassName = themeMode === 'dark' ? 'codex-theme-dark' : 'codex-theme-light';

  if (isBooting) {
    return (
      <div className={cn('codex-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
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
      <div className={cn('codex-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
        <div className="w-full max-w-lg rounded-[28px] border border-slate-100 bg-white p-8 text-center shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)]">
          <img
            src={APP_ICON_PATH}
            alt={APP_DISPLAY_NAME}
            className="mx-auto mb-5 h-14 w-14 rounded-2xl object-cover shadow-sm"
          />
          <Badge className="mb-4 rounded-full bg-cyan-100 px-3 py-1 text-cyan-800">{APP_DISPLAY_NAME}</Badge>
          <h1 className="text-2xl font-black text-slate-950">{`פתח את ${APP_DISPLAY_NAME} דרך הדומיין הייעודי`}</h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            הממשק הזה מוגדר ל-open access על
            <span className="mx-1 font-semibold text-slate-900">app-codex.bina-cshera.co.il</span>
            . אם פתחת אותו דרך host אחר, עבור לשם.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => window.location.assign('https://app-codex.bina-cshera.co.il/')}
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
      <div className={cn('codex-theme flex h-dvh items-center justify-center px-6 font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
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
      profiles={profiles}
      profileId={profileId}
      selectedProvider={selectedProvider}
      selectedProfile={currentProfile}
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
      onManageTopic={(session) => void openTopicManager(session)}
      onToggleArchived={() => setShowArchived((current) => !current)}
      onToggleSessionHidden={(sessionId, hidden) => void handleToggleSessionHidden(sessionId, hidden)}
      onSelectSession={handleSelectConversation}
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
    />
  );

  return (
    <div className={cn('codex-theme h-dvh w-full overflow-hidden font-sans', themeClassName, themeMode === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-[#FAFAFA] text-slate-800')}>
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
              {currentProfile ? getProviderDisplayLabel(currentProfile.provider) : APP_DISPLAY_NAME}
            </h1>
            <div className="mt-1 flex items-center gap-1.5 opacity-60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-medium">{isRefreshing ? 'מסנכרן שיחות' : 'מחובר ומוכן'}</span>
            </div>
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
                  <span className="text-xs font-semibold">משחק</span>
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
                onFork={selectedSession ? (entryId) => forkFromTimelineEntry(entryId) : undefined}
                onTransfer={selectedSession && transferTargetOptions.length > 0
                  ? (entryId, targetProfileId) => void transferFromTimelineEntry(entryId, targetProfileId)
                  : undefined}
                transferOptions={selectedSession ? transferTargetOptions : undefined}
                isTransfering={transferringEntryId === block.entry.id}
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
                <div className="absolute bottom-full left-0 right-0 z-20 mb-3 flex max-h-[40vh] flex-col gap-3 overflow-y-auto">
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

              <div className="pointer-events-none absolute bottom-full -left-9 z-10 mb-2 flex flex-col gap-1.5">
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
                    <div className="absolute bottom-full right-0 z-20 mb-2 w-[min(17.5rem,80vw)] overflow-hidden rounded-[1.2rem] border border-slate-200/70 bg-white/98 shadow-[0_16px_42px_-34px_rgba(15,23,42,0.18)] backdrop-blur-xl">
                      <div className="border-b border-slate-100/90 bg-gradient-to-b from-violet-50/55 via-white to-white px-3 py-2.5 text-right">
                        <div className="flex items-center justify-between gap-3">
                          <Brain className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-semibold text-slate-700">מודל ורמת חשיבה</div>
                            <div className="mt-1 flex flex-wrap justify-end gap-1.5 text-[10px]">
                              {selectedModelOption && (
                                <span className="rounded-full border border-slate-200/80 bg-slate-50/80 px-2 py-0.5 text-slate-500">
                                  {selectedModelOption.displayName}
                                </span>
                              )}
                              {selectedReasoningOption && (
                                <span className="rounded-full border border-violet-100/80 bg-violet-50/70 px-2 py-0.5 text-violet-600">
                                  {getReasoningEffortLabel(selectedReasoningOption.effort)}
                                </span>
                              )}
                              {!selectedModelOption && (
                                <span className="text-slate-400">הרשימה נשלפת מה־{selectedProviderLabel} המקומי.</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="max-h-[58vh] overflow-y-auto p-1.5">
                        <div className="mb-1 px-2 text-right text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                          מודלים
                        </div>
                        {availableModels.length === 0 ? (
                          <div className="rounded-[0.95rem] bg-slate-50/70 px-3 py-3.5 text-right text-[13px] text-slate-500">
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
                                  'flex w-full items-start justify-between gap-2.5 rounded-[0.95rem] border px-3 py-2.25 text-right transition',
                                  selectedModelSlug === model.slug
                                    ? 'border-violet-200/80 bg-violet-50/80 text-violet-800'
                                    : 'border-transparent bg-slate-50/55 text-slate-700 hover:border-slate-200/80 hover:bg-white'
                                )}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center justify-end gap-2">
                                    {model.isConfiguredDefault && (
                                      <span className={cn(
                                        'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                        selectedModelSlug === model.slug
                                          ? 'bg-white/90 text-violet-500'
                                          : 'bg-white/90 text-slate-400'
                                      )}>
                                        ברירת מחדל
                                      </span>
                                    )}
                                    <span className="text-[13px] font-semibold">{model.displayName}</span>
                                  </div>
                                  <div className={cn(
                                    'mt-1 truncate text-[10px]',
                                    selectedModelSlug === model.slug ? 'text-violet-600/80' : 'text-slate-500'
                                  )}>
                                    {model.description || model.slug}
                                  </div>
                                </div>
                                {selectedModelSlug === model.slug && <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />}
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="mt-2.5 border-t border-slate-100/90 pt-2.5">
                          <div className="mb-1 px-2 text-right text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                            רמת חשיבה
                          </div>
                          {!selectedModelOption || supportedReasoningLevels.length === 0 ? (
                            <div className="rounded-[0.95rem] bg-slate-50/70 px-3 py-3.5 text-right text-[13px] text-slate-500">
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
                                    'flex w-full items-start justify-between gap-2.5 rounded-[0.95rem] border px-3 py-2.25 text-right transition',
                                    selectedReasoningEffort === level.effort
                                      ? 'border-sky-200/80 bg-sky-50/80 text-sky-800'
                                      : 'border-transparent bg-slate-50/55 text-slate-700 hover:border-slate-200/80 hover:bg-white'
                                  )}
                                >
                                  <div className="min-w-0">
                                    <div className="text-[13px] font-semibold">{getReasoningEffortLabel(level.effort)}</div>
                                    {level.description && (
                                      <div className={cn(
                                        'mt-1 text-[10px] leading-4.5',
                                        selectedReasoningEffort === level.effort ? 'text-sky-700/80' : 'text-slate-500'
                                      )}>
                                        {level.description}
                                      </div>
                                    )}
                                  </div>
                                  {selectedReasoningEffort === level.effort && <Check className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />}
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
                              {formatCompactTokenCount(rateLimitSnapshot.context.inputTokens)} / {formatCompactTokenCount(rateLimitSnapshot.context.modelContextWindow)}
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
                  className="shrink-0 rounded-full bg-slate-900 p-3 text-slate-50 transition-all active:scale-95 disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-30"
                >
                  <Send className="h-5 w-5 -ml-0.5" />
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

      <MiniGameDialog
        isOpen={isGameOpen}
        onClose={() => setIsGameOpen(false)}
        sessionActiveCount={currentSessionActiveQueueCount}
        sessionCompletionSignal={gameSessionCompletionSignal}
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

      {activeToolEntry && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setActiveToolEntry(null)}
            aria-label="Close tool dialog"
          />
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
                  {activeToolEntry.subtitle && (
                    <div className="mt-1 break-words text-sm leading-6 text-slate-500 [overflow-wrap:anywhere]">
                      {activeToolEntry.subtitle}
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
