import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useState,
} from 'react';
import {
  Archive,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  Files,
  FolderOpen,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  TriangleAlert,
  User,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  compressGeminiConversation,
  exportGeminiConversation,
  getGeminiConversationDetail,
  getGeminiJobDetail,
  listGeminiConversations,
  restartGeminiConversation,
} from './api';
import type {
  GeminiArtifact,
  GeminiConversationDetailResponse,
  GeminiConversationMessage,
  GeminiConversationSummary,
  GeminiExportResponse,
  GeminiJobDetailResponse,
  GeminiJobRecord,
} from './types';

type InspectorTab = 'overview' | 'turn' | 'tools' | 'files' | 'jobs' | 'raw';

function readInitialConversationId() {
  try {
    const search = new URLSearchParams(window.location.search);
    return search.get('conversation');
  } catch {
    return null;
  }
}

function updateConversationParam(conversationId: string | null) {
  try {
    const url = new URL(window.location.href);
    if (conversationId) {
      url.searchParams.set('conversation', conversationId);
    } else {
      url.searchParams.delete('conversation');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore URL sync issues
  }
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('he-IL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatNumber(value: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('he-IL').format(value);
}

function formatDuration(durationMs: number | null) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function trimWords(value: string, limit = 10) {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  return `${words.slice(0, limit).join(' ')}…`;
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function normalizeSearchValue(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function getStageTone(stage: string | null) {
  const normalized = String(stage || '').toLowerCase();
  if (normalized.includes('error')) {
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }
  if (normalized.includes('completed')) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  }
  if (normalized.includes('processing') || normalized.includes('pending') || normalized.includes('uploading')) {
    return 'bg-amber-50 text-amber-700 border-amber-200';
  }
  return 'bg-slate-100 text-slate-700 border-slate-200';
}

function getRoleTone(role: string) {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'model') {
    return {
      badge: 'bg-cyan-50 text-cyan-700 border-cyan-200',
      bubble: 'bg-white border-slate-200',
      icon: Bot,
      label: 'Assistant',
    };
  }
  if (normalized === 'system') {
    return {
      badge: 'bg-violet-50 text-violet-700 border-violet-200',
      bubble: 'bg-violet-50/60 border-violet-200',
      icon: Sparkles,
      label: 'System',
    };
  }
  return {
    badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    bubble: 'bg-indigo-50/40 border-indigo-200',
    icon: User,
    label: 'User',
  };
}

function extractToolCalls(message: GeminiConversationMessage | null) {
  if (!message?.meta?.providerMetadata) return [];
  const providerMetadata = message.meta.providerMetadata;
  const directToolCalls = Array.isArray(providerMetadata.toolCalls) ? providerMetadata.toolCalls : [];
  const mcpToolCalls = Array.isArray(providerMetadata.mcp_tool_calls) ? providerMetadata.mcp_tool_calls : [];
  return [...directToolCalls, ...mcpToolCalls];
}

function extractToolResponses(message: GeminiConversationMessage | null) {
  if (!message?.meta) return [];
  const directResponses = Array.isArray(message.meta.toolResponses) ? message.meta.toolResponses : [];
  if (directResponses.length > 0) {
    return directResponses;
  }
  const providerMetadata = message.meta.providerMetadata || {};
  const mcpResults = Array.isArray(providerMetadata.mcp_tool_results) ? providerMetadata.mcp_tool_results : [];
  return mcpResults;
}

function getProviderOptions(conversations: GeminiConversationSummary[]) {
  return Array.from(new Set(conversations.map((conversation) => conversation.lastProvider).filter(Boolean))) as string[];
}

function getStageOptions(conversations: GeminiConversationSummary[]) {
  return Array.from(new Set(conversations.map((conversation) => conversation.stage).filter(Boolean))) as string[];
}

function JsonPane({
  title,
  value,
  copyValue,
  emptyLabel = 'אין נתונים להצגה',
}: {
  title: string;
  value: unknown;
  copyValue?: string | null;
  emptyLabel?: string;
}) {
  const rendered = value == null ? '' : JSON.stringify(value, null, 2);
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-950/95 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-slate-200">
        <div className="flex items-center gap-2">
          <FileJson className="h-4 w-4 text-cyan-300" />
          <span className="text-sm font-semibold">{title}</span>
        </div>
        {copyValue && (
          <button
            type="button"
            onClick={() => copyText(copyValue)}
            className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
          >
            Copy
          </button>
        )}
      </div>
      <pre dir="ltr" className="max-h-[24rem] overflow-auto whitespace-pre-wrap break-words px-4 py-4 text-xs leading-6 text-slate-100">
        {rendered || emptyLabel}
      </pre>
    </div>
  );
}

function InspectorTabButton({
  id,
  activeTab,
  onClick,
  label,
}: {
  id: InspectorTab;
  activeTab: InspectorTab;
  onClick: (next: InspectorTab) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={cn(
        'rounded-full border px-3 py-2 text-xs font-medium transition',
        activeTab === id
          ? 'border-cyan-300 bg-cyan-50 text-cyan-700'
          : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
      )}
    >
      {label}
    </button>
  );
}

function ArtifactList({
  title,
  files,
}: {
  title: string;
  files: GeminiArtifact[];
}) {
  return (
    <Card className="rounded-[1.75rem] border-slate-200 bg-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-slate-800">{title}</CardTitle>
        <CardDescription>{files.length} קבצים</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {files.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            אין קבצים בקטגוריה הזו.
          </div>
        )}
        {files.map((file, index) => {
          const fileUrl = typeof file.rawUrl === 'string' && file.rawUrl
            ? file.rawUrl
            : typeof file.fileUri === 'string' && file.fileUri
              ? file.fileUri
              : typeof file.gsUri === 'string' && file.gsUri
                ? file.gsUri
                : null;
          return (
            <div key={`${file.filename || file.originalFilename || 'file'}:${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">
                    {file.originalFilename || file.filename || `File ${index + 1}`}
                  </div>
                  <div dir="ltr" className="mt-1 truncate text-xs text-slate-400">
                    {file.mimeType || 'unknown mime'}
                  </div>
                  {file.gcsPath && (
                    <div dir="ltr" className="mt-1 truncate text-[11px] text-slate-400">
                      {file.gcsPath}
                    </div>
                  )}
                </div>
                {fileUrl && (
                  <button
                    type="button"
                    onClick={() => openUrl(fileUrl)}
                    className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                  >
                    Open
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function GeminiObservatoryApp() {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [stageFilter, setStageFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | 'files' | 'tools' | 'archived' | 'published'>('all');
  const [conversations, setConversations] = useState<GeminiConversationSummary[]>([]);
  const [listStats, setListStats] = useState({
    totalConversations: 0,
    activeJobs: 0,
    errorConversations: 0,
    archivedConversations: 0,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [isListLoading, setIsListLoading] = useState(false);
  const [isListAppending, setIsListAppending] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(readInitialConversationId());
  const [conversationDetail, setConversationDetail] = useState<GeminiConversationDetailResponse | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobDetail, setJobDetail] = useState<GeminiJobDetailResponse | null>(null);
  const [isJobDetailLoading, setIsJobDetailLoading] = useState(false);
  const [jobDetailError, setJobDetailError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [includeSystem, setIncludeSystem] = useState(true);
  const [isActionRunning, setIsActionRunning] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const loadConversations = useEffectEvent(async (append: boolean) => {
    if (append && !nextCursor) {
      return;
    }

    if (append) {
      setIsListAppending(true);
    } else {
      setIsListLoading(true);
      setListError(null);
    }

    try {
      const normalizedSearch = normalizeSearchValue(deferredSearch);
      const data = await listGeminiConversations({
        q: normalizedSearch || undefined,
        stage: stageFilter || undefined,
        provider: providerFilter || undefined,
        model: modelFilter || undefined,
        hasFiles: flagFilter === 'files' ? true : null,
        hasToolCalls: flagFilter === 'tools' ? true : null,
        historyOffloaded: flagFilter === 'archived' ? true : null,
        published: flagFilter === 'published' ? true : null,
        cursor: append ? nextCursor : null,
        limit: 30,
      });

      setConversations((current) => append ? [...current, ...data.items] : data.items);
      setListStats(data.stats);
      setNextCursor(data.nextCursor);
      setTotalCount(data.totalCount);
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Failed to load Gemini conversations');
    } finally {
      setIsListLoading(false);
      setIsListAppending(false);
    }
  });

  const loadConversationDetail = useEffectEvent(async (conversationId: string) => {
    setIsDetailLoading(true);
    setDetailError(null);

    try {
      const data = await getGeminiConversationDetail(conversationId, includeSystem);
      setConversationDetail(data);
      setSelectedMessageId((current) => {
        if (current && data.messages.some((message) => message.id === current)) {
          return current;
        }
        const preferredMessage = [...data.messages].reverse().find((message) => {
          const normalized = message.role.trim().toLowerCase();
          return normalized === 'assistant' || normalized === 'model';
        });
        return preferredMessage?.id || data.messages.at(-1)?.id || null;
      });
      setSelectedJobId((current) => current && data.jobs.some((job) => job.jobId === current)
        ? current
        : data.jobs[0]?.jobId || null);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Failed to load Gemini conversation detail');
      setConversationDetail(null);
    } finally {
      setIsDetailLoading(false);
    }
  });

  const loadJobDetail = useEffectEvent(async (jobId: string) => {
    setIsJobDetailLoading(true);
    setJobDetailError(null);
    try {
      const data = await getGeminiJobDetail(jobId, includeSystem);
      setJobDetail(data);
    } catch (error) {
      setJobDetailError(error instanceof Error ? error.message : 'Failed to load Gemini job detail');
      setJobDetail(null);
    } finally {
      setIsJobDetailLoading(false);
    }
  });

  useEffect(() => {
    void loadConversations(false);
  }, [deferredSearch, stageFilter, providerFilter, modelFilter, flagFilter]);

  useEffect(() => {
    if (!selectedConversationId) {
      setConversationDetail(null);
      updateConversationParam(null);
      return;
    }

    updateConversationParam(selectedConversationId);
    void loadConversationDetail(selectedConversationId);
  }, [selectedConversationId, includeSystem]);

  useEffect(() => {
    if (!selectedJobId) {
      setJobDetail(null);
      return;
    }

    void loadJobDetail(selectedJobId);
  }, [selectedJobId, includeSystem]);

  useEffect(() => {
    if (!selectedConversationId && conversations.length > 0) {
      startTransition(() => {
        setSelectedConversationId(conversations[0].id);
      });
    }
  }, [conversations, selectedConversationId]);

  const selectedMessage = conversationDetail?.messages.find((message) => message.id === selectedMessageId) || null;
  const selectedJob = conversationDetail?.jobs.find((job) => job.jobId === selectedJobId) || null;
  const stageOptions = getStageOptions(conversations);
  const providerOptions = getProviderOptions(conversations);
  const selectedToolCalls = extractToolCalls(selectedMessage);
  const selectedToolResponses = extractToolResponses(selectedMessage);

  async function handleRestartConversation() {
    if (!selectedConversationId) return;
    setIsActionRunning(true);
    setActionNotice(null);
    try {
      await restartGeminiConversation(selectedConversationId);
      setActionNotice('השיחה אופסה וה-snapshot עודכן.');
      await loadConversationDetail(selectedConversationId);
      await loadConversations(false);
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : 'Restart failed');
    } finally {
      setIsActionRunning(false);
    }
  }

  async function handleCompressConversation() {
    if (!selectedConversationId) return;
    setIsActionRunning(true);
    setActionNotice(null);
    try {
      const response = await compressGeminiConversation(selectedConversationId);
      setActionNotice(response?.message || response?.details || 'הדחיסה הושלמה.');
      await loadConversationDetail(selectedConversationId);
      await loadConversations(false);
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : 'Compression failed');
    } finally {
      setIsActionRunning(false);
    }
  }

  async function handleExportConversation() {
    if (!selectedConversationId) return;
    setIsActionRunning(true);
    setActionNotice(null);
    try {
      const response = await exportGeminiConversation(selectedConversationId, includeSystem);
      handleExportResponse(response);
      setActionNotice('נוצר export חדש לשיחה.');
    } catch (error) {
      setActionNotice(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setIsActionRunning(false);
    }
  }

  function handleExportResponse(response: GeminiExportResponse) {
    if (response.mode === 'zip' && response.url) {
      openUrl(response.url);
      return;
    }
    const firstResult = response.results?.[0];
    if (firstResult?.html_file?.url) {
      openUrl(firstResult.html_file.url);
    } else if (firstResult?.txt_file?.url) {
      openUrl(firstResult.txt_file.url);
    }
  }

  return (
    <div
      data-theme-preset="sky"
      className="code-ai-theme code-ai-theme-light min-h-dvh bg-[#FAFAFA] text-slate-800"
      dir="rtl"
    >
      <div className="mx-auto flex min-h-dvh max-w-[1800px] flex-col px-4 py-4 sm:px-6">
        <header className="mb-4 rounded-[2rem] border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <a
                  href="/"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-600 transition hover:bg-slate-100"
                  title="חזרה ל-code-ai"
                >
                  <ArrowRight className="h-4 w-4" />
                </a>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge className="border-cyan-200 bg-cyan-50 text-cyan-700">Gemini Service</Badge>
                    <Badge className="border-slate-200 bg-slate-50 text-slate-600">Observatory</Badge>
                  </div>
                  <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Gemini Conversation Observatory</h1>
                  <p className="mt-1 text-sm text-slate-500">
                    viewer חקירתי לכל conversation, job, tool trace ו-raw payload מתוך `gemini-conversation-service`.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card className="rounded-[1.5rem] border-slate-200 bg-slate-50 shadow-none">
                <CardContent className="p-4">
                  <div className="text-xs text-slate-500">Conversations</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{formatNumber(listStats.totalConversations)}</div>
                </CardContent>
              </Card>
              <Card className="rounded-[1.5rem] border-amber-200 bg-amber-50 shadow-none">
                <CardContent className="p-4">
                  <div className="text-xs text-amber-700">Active Jobs</div>
                  <div className="mt-1 text-xl font-semibold text-amber-900">{formatNumber(listStats.activeJobs)}</div>
                </CardContent>
              </Card>
              <Card className="rounded-[1.5rem] border-rose-200 bg-rose-50 shadow-none">
                <CardContent className="p-4">
                  <div className="text-xs text-rose-700">Errors</div>
                  <div className="mt-1 text-xl font-semibold text-rose-900">{formatNumber(listStats.errorConversations)}</div>
                </CardContent>
              </Card>
              <Card className="rounded-[1.5rem] border-violet-200 bg-violet-50 shadow-none">
                <CardContent className="p-4">
                  <div className="text-xs text-violet-700">Archived</div>
                  <div className="mt-1 text-xl font-semibold text-violet-900">{formatNumber(listStats.archivedConversations)}</div>
                </CardContent>
              </Card>
            </div>
          </div>
        </header>

        {actionNotice && (
          <div className={cn(
            'mb-4 rounded-[1.5rem] border px-4 py-3 text-sm',
            actionNotice.toLowerCase().includes('failed') || actionNotice.toLowerCase().includes('error')
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          )}>
            {actionNotice}
          </div>
        )}

        <div className="grid flex-1 gap-4 xl:grid-cols-[minmax(22rem,26rem)_minmax(0,1fr)_minmax(22rem,30rem)]">
          <Card className="min-h-[40rem] rounded-[2rem] border-slate-200 bg-white shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg text-slate-900">Conversations</CardTitle>
              <CardDescription>{formatNumber(totalCount)} conversations אחרי filtering</CardDescription>
              <div className="space-y-3 pt-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="conversation id, preview, model..."
                    className="rounded-2xl border-slate-200 bg-slate-50 pr-10"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={stageFilter}
                    onChange={(event) => setStageFilter(event.target.value)}
                    className="h-10 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700"
                  >
                    <option value="">כל הסטטוסים</option>
                    {stageOptions.map((stage) => (
                      <option key={stage} value={stage}>{stage}</option>
                    ))}
                  </select>
                  <select
                    value={providerFilter}
                    onChange={(event) => setProviderFilter(event.target.value)}
                    className="h-10 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700"
                  >
                    <option value="">כל ה-providers</option>
                    {providerOptions.map((provider) => (
                      <option key={provider} value={provider}>{provider}</option>
                    ))}
                  </select>
                </div>
                <Input
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  placeholder="סינון לפי model"
                  className="rounded-2xl border-slate-200 bg-slate-50"
                />
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 'all', label: 'הכל' },
                    { id: 'files', label: 'עם קבצים' },
                    { id: 'tools', label: 'עם tools' },
                    { id: 'archived', label: 'archived' },
                    { id: 'published', label: 'published' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFlagFilter(item.id as typeof flagFilter)}
                      className={cn(
                        'rounded-full border px-3 py-2 text-xs font-medium transition',
                        flagFilter === item.id
                          ? 'border-cyan-300 bg-cyan-50 text-cyan-700'
                          : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      checked={includeSystem}
                      onChange={(event) => setIncludeSystem(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    כלול system messages
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadConversations(false)}
                    className="rounded-full"
                  >
                    <RefreshCw className={cn('h-4 w-4', isListLoading && 'animate-spin')} />
                    רענון
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {listError && (
                <div className="mx-6 mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {listError}
                </div>
              )}
              <ScrollArea className="h-[calc(100dvh-23rem)] xl:h-[calc(100dvh-20rem)]">
                <div className="space-y-3 px-4 pb-4">
                  {isListLoading && conversations.length === 0 && (
                    <div className="flex items-center justify-center rounded-[1.5rem] border border-slate-200 bg-slate-50 px-4 py-10 text-slate-500">
                      <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                      טוען conversations...
                    </div>
                  )}

                  {!isListLoading && conversations.length === 0 && (
                    <div className="rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-slate-500">
                      לא נמצאו conversations.
                    </div>
                  )}

                  {conversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => {
                        startTransition(() => {
                          setSelectedConversationId(conversation.id);
                          setSelectedJobId(conversation.latestJobId);
                          setActiveTab('overview');
                        });
                      }}
                      className={cn(
                        'w-full rounded-[1.5rem] border px-4 py-4 text-right transition',
                        selectedConversationId === conversation.id
                          ? 'border-cyan-300 bg-cyan-50/80 shadow-sm'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">{conversation.title}</span>
                            <Badge className={cn('border', getStageTone(conversation.stage))}>{conversation.stage || 'unknown'}</Badge>
                            {conversation.historyOffloaded && (
                              <Badge className="border-violet-200 bg-violet-50 text-violet-700">Archived</Badge>
                            )}
                          </div>
                          <div dir="ltr" className="mt-1 truncate text-[11px] text-slate-400">{conversation.id}</div>
                          <div className="mt-3 text-sm leading-6 text-slate-600">
                            <div>{trimWords(conversation.lastQuestionPreview || 'ללא שאלה', 14)}</div>
                            <div className="mt-1 text-slate-400">{trimWords(conversation.lastResponsePreview || 'ללא תשובה', 16)}</div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                            {conversation.lastProvider && (
                              <Badge className="border-slate-200 bg-slate-100 text-slate-600">{conversation.lastProvider}</Badge>
                            )}
                            {conversation.lastModel && (
                              <Badge className="border-slate-200 bg-slate-100 text-slate-600">{conversation.lastModel}</Badge>
                            )}
                            <span>{formatNumber(conversation.messageCount)} turns</span>
                            <span>{formatNumber(conversation.totalTokens)} tokens</span>
                            <span>{formatDateTime(conversation.updatedAt)}</span>
                          </div>
                        </div>
                        <ChevronMarker active={selectedConversationId === conversation.id} />
                      </div>
                    </button>
                  ))}

                  {nextCursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadConversations(true)}
                      disabled={isListAppending}
                      className="w-full rounded-full"
                    >
                      {isListAppending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      טען עוד
                    </Button>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-h-[40rem] rounded-[2rem] border-slate-200 bg-white shadow-sm">
            <CardHeader className="border-b border-slate-100 pb-4">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <CardTitle className="text-lg text-slate-900">
                    {conversationDetail?.conversation.title || 'בחר conversation'}
                  </CardTitle>
                  <CardDescription className="mt-2">
                    {conversationDetail?.conversation.id || 'עדיין לא נבחרה שיחה'}
                  </CardDescription>
                  {conversationDetail && (
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Badge className={cn('border', getStageTone(conversationDetail.conversation.stage))}>
                        {conversationDetail.conversation.stage || 'unknown'}
                      </Badge>
                      {conversationDetail.conversation.lastProvider && (
                        <Badge className="border-slate-200 bg-slate-100 text-slate-600">
                          {conversationDetail.conversation.lastProvider}
                        </Badge>
                      )}
                      {conversationDetail.conversation.lastModel && (
                        <Badge className="border-slate-200 bg-slate-100 text-slate-600">
                          {conversationDetail.conversation.lastModel}
                        </Badge>
                      )}
                      {conversationDetail.conversation.hasPublishedResponse && (
                        <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
                          Published
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExportConversation}
                    disabled={!selectedConversationId || isActionRunning}
                    className="rounded-full"
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCompressConversation}
                    disabled={!selectedConversationId || isActionRunning}
                    className="rounded-full"
                  >
                    <Archive className="h-4 w-4" />
                    Compress
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleRestartConversation}
                    disabled={!selectedConversationId || isActionRunning}
                    className="rounded-full"
                  >
                    {isActionRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Restart
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {detailError && (
                <div className="mx-6 mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {detailError}
                </div>
              )}

              <ScrollArea className="h-[calc(100dvh-20rem)] xl:h-[calc(100dvh-18.5rem)]">
                <div className="space-y-4 px-5 py-5">
                  {isDetailLoading && !conversationDetail && (
                    <div className="flex items-center justify-center rounded-[1.75rem] border border-slate-200 bg-slate-50 px-4 py-14 text-slate-500">
                      <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                      טוען conversation detail...
                    </div>
                  )}

                  {!isDetailLoading && !conversationDetail && (
                    <div className="rounded-[1.75rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-14 text-center text-slate-500">
                      בחר conversation מהרשימה כדי לפתוח timeline מלא.
                    </div>
                  )}

                  {conversationDetail?.messages.map((message) => {
                    const tone = getRoleTone(message.role);
                    const Icon = tone.icon;
                    const isSelected = selectedMessageId === message.id;
                    const toolCallCount = extractToolCalls(message).length;
                    const toolResponseCount = extractToolResponses(message).length;
                    const tokenCount = message.meta?.usage?.total_tokens ?? null;

                    return (
                      <button
                        key={message.id}
                        type="button"
                        onClick={() => {
                          startTransition(() => {
                            setSelectedMessageId(message.id);
                            setActiveTab('turn');
                          });
                        }}
                        className={cn(
                          'w-full rounded-[1.75rem] border px-4 py-4 text-right shadow-sm transition',
                          tone.bubble,
                          isSelected && 'ring-2 ring-cyan-300'
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600">
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge className={cn('border', tone.badge)}>{tone.label}</Badge>
                              {message.meta?.model && (
                                <Badge className="border-slate-200 bg-white text-slate-600">{message.meta.model}</Badge>
                              )}
                              {message.meta?.finishReason && (
                                <Badge className="border-slate-200 bg-white text-slate-600">{message.meta.finishReason}</Badge>
                              )}
                              {toolCallCount > 0 && (
                                <Badge className="border-amber-200 bg-amber-50 text-amber-700">{toolCallCount} tool calls</Badge>
                              )}
                              {toolResponseCount > 0 && (
                                <Badge className="border-amber-200 bg-amber-50 text-amber-700">{toolResponseCount} tool results</Badge>
                              )}
                              {message.files.length > 0 && (
                                <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">{message.files.length} files</Badge>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                              <span>{formatDateTime(message.createdAt)}</span>
                              <span>{formatNumber(typeof tokenCount === 'number' ? tokenCount : null)} tokens</span>
                              <span dir="ltr">{message.id}</span>
                            </div>
                            <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">
                              {message.text || '—'}
                            </div>
                            {message.files.length > 0 && (
                              <div className="mt-4 flex flex-wrap gap-2">
                                {message.files.map((file, index) => (
                                  <button
                                    key={`${file.filename || file.originalFilename || 'file'}:${index}`}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      const targetUrl = typeof file.rawUrl === 'string' && file.rawUrl
                                        ? file.rawUrl
                                        : typeof file.fileUri === 'string' && file.fileUri
                                          ? file.fileUri
                                          : null;
                                      if (targetUrl) {
                                        openUrl(targetUrl);
                                      }
                                    }}
                                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] text-slate-600 transition hover:bg-slate-100"
                                  >
                                    {file.originalFilename || file.filename || `File ${index + 1}`}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-h-[40rem] rounded-[2rem] border-slate-200 bg-white shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg text-slate-900">Inspector</CardTitle>
              <CardDescription>
                {selectedMessage ? `turn ${selectedMessage.id}` : selectedJob ? `job ${selectedJob.jobId}` : 'בחר turn או job'}
              </CardDescription>
              <div className="flex flex-wrap gap-2 pt-2">
                <InspectorTabButton id="overview" activeTab={activeTab} onClick={setActiveTab} label="Overview" />
                <InspectorTabButton id="turn" activeTab={activeTab} onClick={setActiveTab} label="Turn" />
                <InspectorTabButton id="tools" activeTab={activeTab} onClick={setActiveTab} label="Tools" />
                <InspectorTabButton id="files" activeTab={activeTab} onClick={setActiveTab} label="Files" />
                <InspectorTabButton id="jobs" activeTab={activeTab} onClick={setActiveTab} label="Jobs" />
                <InspectorTabButton id="raw" activeTab={activeTab} onClick={setActiveTab} label="Raw" />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100dvh-21rem)] xl:h-[calc(100dvh-19.5rem)]">
                <div className="space-y-4 px-5 pb-5">
                  {activeTab === 'overview' && conversationDetail && (
                    <>
                      <OverviewGrid conversation={conversationDetail.conversation} jobs={conversationDetail.jobs} />
                      <JsonPane
                        title="Conversation Metadata"
                        value={conversationDetail.metadata}
                        copyValue={JSON.stringify(conversationDetail.metadata, null, 2)}
                      />
                    </>
                  )}

                  {activeTab === 'turn' && (
                    <>
                      {!selectedMessage && (
                        <EmptyInspectorState label="בחר turn מתוך ה-timeline כדי לראות metadata מלא." />
                      )}
                      {selectedMessage && (
                        <>
                          <TurnDetailsCard message={selectedMessage} />
                          <JsonPane
                            title="Request Debug"
                            value={selectedMessage.meta?.requestDebug || null}
                            copyValue={selectedMessage.meta?.requestDebug ? JSON.stringify(selectedMessage.meta.requestDebug, null, 2) : null}
                            emptyLabel="אין request debug שמור על ה-turn הזה."
                          />
                        </>
                      )}
                    </>
                  )}

                  {activeTab === 'tools' && (
                    <>
                      {!selectedMessage && (
                        <EmptyInspectorState label="בחר turn כדי לראות tool calls ו-tool results." />
                      )}
                      {selectedMessage && (
                        <>
                          <ToolListCard title="Tool Calls" emptyLabel="לא נשמרו tool calls על ה-turn הזה." items={selectedToolCalls} />
                          <ToolListCard title="Tool Results" emptyLabel="לא נשמרו tool results על ה-turn הזה." items={selectedToolResponses} />
                        </>
                      )}
                    </>
                  )}

                  {activeTab === 'files' && (
                    <>
                      {!conversationDetail && (
                        <EmptyInspectorState label="בחר conversation כדי לראות artifacts." />
                      )}
                      {conversationDetail && (
                        <>
                          <ArtifactList title="All Conversation Files" files={conversationDetail.allFiles} />
                          <ArtifactList title="Last Turn Files" files={conversationDetail.lastTurnFiles} />
                          <ArtifactList title="Selected Turn Files" files={selectedMessage?.files || []} />
                        </>
                      )}
                    </>
                  )}

                  {activeTab === 'jobs' && (
                    <>
                      {!conversationDetail && (
                        <EmptyInspectorState label="בחר conversation כדי לראות jobs." />
                      )}
                      {conversationDetail && (
                        <>
                          <Card className="rounded-[1.75rem] border-slate-200 bg-white shadow-sm">
                            <CardHeader className="pb-3">
                              <CardTitle className="text-base text-slate-800">Conversation Jobs</CardTitle>
                              <CardDescription>{conversationDetail.jobs.length} jobs קשורים</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              {conversationDetail.jobs.length === 0 && (
                                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                                  אין jobs לשיחה הזו.
                                </div>
                              )}
                              {conversationDetail.jobs.map((job) => (
                                <button
                                  key={job.jobId}
                                  type="button"
                                  onClick={() => {
                                    setSelectedJobId(job.jobId);
                                    setActiveTab('jobs');
                                  }}
                                  className={cn(
                                    'w-full rounded-2xl border px-4 py-3 text-right transition',
                                    selectedJobId === job.jobId
                                      ? 'border-cyan-300 bg-cyan-50'
                                      : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-slate-800">{job.jobId}</span>
                                        <Badge className={cn('border', getStageTone(job.status))}>{job.status || 'unknown'}</Badge>
                                        {job.rescueTriggered && (
                                          <Badge className="border-amber-200 bg-amber-50 text-amber-700">rescue</Badge>
                                        )}
                                      </div>
                                      <div className="mt-2 text-xs text-slate-500">
                                        {formatDateTime(job.updatedAt || job.completedAt || job.startedAt || job.enqueuedAt)}
                                      </div>
                                      {job.questionPreview && (
                                        <div className="mt-2 text-sm text-slate-600">{trimWords(job.questionPreview, 16)}</div>
                                      )}
                                    </div>
                                    <div className="text-left text-xs text-slate-500">
                                      <div>{formatDuration(job.durationMs)}</div>
                                      <div>{formatNumber(job.totalTokens)} tokens</div>
                                    </div>
                                  </div>
                                </button>
                              ))}
                            </CardContent>
                          </Card>

                          {isJobDetailLoading && (
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-500">
                              <Loader2 className="ml-2 inline h-4 w-4 animate-spin" />
                              טוען job detail...
                            </div>
                          )}

                          {jobDetailError && (
                            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
                              {jobDetailError}
                            </div>
                          )}

                          {jobDetail && (
                            <>
                              <JobSummaryCard job={jobDetail.job} />
                              <JsonPane
                                title="Raw Job Document"
                                value={jobDetail.rawJob}
                                copyValue={JSON.stringify(jobDetail.rawJob, null, 2)}
                              />
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {activeTab === 'raw' && (
                    <>
                      {!conversationDetail && (
                        <EmptyInspectorState label="בחר conversation כדי לראות raw payloads." />
                      )}
                      {conversationDetail && (
                        <>
                          <JsonPane
                            title="Stored Conversation Document"
                            value={conversationDetail.rawConversation}
                            copyValue={JSON.stringify(conversationDetail.rawConversation, null, 2)}
                          />
                          <JsonPane
                            title="Selected Turn Provider Metadata"
                            value={selectedMessage?.meta?.providerMetadata || null}
                            copyValue={selectedMessage?.meta?.providerMetadata ? JSON.stringify(selectedMessage.meta.providerMetadata, null, 2) : null}
                            emptyLabel="אין provider metadata על ה-turn הנבחר."
                          />
                          {jobDetail && (
                            <JsonPane
                              title="Selected Job Raw"
                              value={jobDetail.rawJob}
                              copyValue={JSON.stringify(jobDetail.rawJob, null, 2)}
                            />
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ChevronMarker({ active }: { active: boolean }) {
  return (
    <div className={cn(
      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition',
      active
        ? 'border-cyan-300 bg-white text-cyan-700'
        : 'border-slate-200 bg-slate-50 text-slate-400'
    )}>
      <ArrowRight className="h-4 w-4" />
    </div>
  );
}

function OverviewGrid({
  conversation,
  jobs,
}: {
  conversation: GeminiConversationSummary;
  jobs: GeminiJobRecord[];
}) {
  const cards = [
    { label: 'Messages', value: formatNumber(conversation.messageCount), tone: 'border-slate-200 bg-slate-50 text-slate-700' },
    { label: 'Total Tokens', value: formatNumber(conversation.totalTokens), tone: 'border-cyan-200 bg-cyan-50 text-cyan-700' },
    { label: 'Jobs', value: formatNumber(jobs.length), tone: 'border-amber-200 bg-amber-50 text-amber-700' },
    { label: 'Updated', value: formatDateTime(conversation.updatedAt), tone: 'border-violet-200 bg-violet-50 text-violet-700' },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {cards.map((card) => (
        <div key={card.label} className={cn('rounded-[1.5rem] border px-4 py-4', card.tone)}>
          <div className="text-xs font-medium">{card.label}</div>
          <div className="mt-2 text-sm font-semibold">{card.value}</div>
        </div>
      ))}
    </div>
  );
}

function EmptyInspectorState({ label }: { label: string }) {
  return (
    <div className="rounded-[1.75rem] border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
      {label}
    </div>
  );
}

function TurnDetailsCard({ message }: { message: GeminiConversationMessage }) {
  const tone = getRoleTone(message.role);
  const tokenCount = message.meta?.usage?.total_tokens ?? null;

  return (
    <Card className="rounded-[1.75rem] border-slate-200 bg-white shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={cn('border', tone.badge)}>{tone.label}</Badge>
          {message.meta?.model && (
            <Badge className="border-slate-200 bg-slate-100 text-slate-600">{message.meta.model}</Badge>
          )}
          {message.meta?.finishReason && (
            <Badge className="border-slate-200 bg-slate-100 text-slate-600">{message.meta.finishReason}</Badge>
          )}
        </div>
        <CardTitle className="text-base text-slate-900">Turn Detail</CardTitle>
        <CardDescription dir="ltr">{message.id}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <StatLine icon={Clock3} label="Timestamp" value={formatDateTime(message.createdAt)} />
          <StatLine icon={Database} label="Tokens" value={formatNumber(typeof tokenCount === 'number' ? tokenCount : null)} />
          <StatLine icon={MessageSquare} label="Role" value={message.role} />
          <StatLine icon={Sparkles} label="Response ID" value={message.meta?.responseId || '—'} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-7 text-slate-800 whitespace-pre-wrap break-words">
          {message.text || '—'}
        </div>
      </CardContent>
    </Card>
  );
}

function StatLine({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-2 break-words text-sm font-medium text-slate-800">{value}</div>
    </div>
  );
}

function ToolListCard({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: unknown[];
  emptyLabel: string;
}) {
  return (
    <Card className="rounded-[1.75rem] border-slate-200 bg-white shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-slate-900">
          <Wrench className="h-4 w-4 text-amber-600" />
          {title}
        </CardTitle>
        <CardDescription>{items.length} רשומות</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            {emptyLabel}
          </div>
        )}
        {items.map((item, index) => (
          <JsonPane
            key={`${title}:${index}`}
            title={`${title} #${index + 1}`}
            value={item}
            copyValue={JSON.stringify(item, null, 2)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function JobSummaryCard({ job }: { job: GeminiJobRecord }) {
  return (
    <Card className="rounded-[1.75rem] border-slate-200 bg-white shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={cn('border', getStageTone(job.status))}>{job.status || 'unknown'}</Badge>
          {job.provider && (
            <Badge className="border-slate-200 bg-slate-100 text-slate-600">{job.provider}</Badge>
          )}
          {job.model && (
            <Badge className="border-slate-200 bg-slate-100 text-slate-600">{job.model}</Badge>
          )}
          {job.rescueTriggered && (
            <Badge className="border-amber-200 bg-amber-50 text-amber-700">rescue triggered</Badge>
          )}
        </div>
        <CardTitle className="text-base text-slate-900">{job.jobId}</CardTitle>
        <CardDescription dir="ltr">{job.conversationId || 'no conversation'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <StatLine icon={Clock3} label="Duration" value={formatDuration(job.durationMs)} />
          <StatLine icon={Database} label="Tokens" value={formatNumber(job.totalTokens)} />
          <StatLine icon={MessageSquare} label="Enqueued" value={formatDateTime(job.enqueuedAt)} />
          <StatLine icon={CheckCircle2} label="Completed" value={formatDateTime(job.completedAt)} />
        </div>
        {job.questionPreview && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
            {job.questionPreview}
          </div>
        )}
        {job.publishedUrl && (
          <button
            type="button"
            onClick={() => openUrl(job.publishedUrl!)}
            className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
          >
            <ExternalLink className="h-4 w-4" />
            Open published response
          </button>
        )}
        {job.error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
            {job.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default GeminiObservatoryApp;
