import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  Fullscreen,
  Globe2,
  Laptop,
  Layers3,
  Loader2,
  Maximize2,
  Menu,
  MessageSquareText,
  Minus,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCw,
  ScanSearch,
  ShieldCheck,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react';
import { BrowserSurface } from './BrowserSurface';
import {
  buildSessionPath,
  readSessionRoute,
  replaceCurrentSessionRoute,
} from '@/sessionRoute';
import {
  connectWorkbenchBinaSession,
  enableWorkbenchBrowser,
  inspectWorkbenchPoint,
  openWorkbenchBrowser,
  runWorkbenchBrowserAction,
  sendWorkbenchBrowserInput,
} from './workbenchApi';
import type {
  BrowserInspectedElement,
  BrowserViewportPreset,
  BrowserViewerState,
  WorkbenchBridgeMessage,
  WorkbenchCodexContext,
  WorkbenchElementSelection,
  WorkbenchInteractionMode,
  WorkbenchSelectionMessage,
  WorkbenchViewMode,
} from './types';

const TARGET_URL_STORAGE_PREFIX = 'code-ai-workbench-target-url:v2';
const SIDEBAR_WIDTH_STORAGE_KEY = 'code-ai-workbench-sidebar-width';
const MIN_SIDEBAR_WIDTH = 360;
const MAX_SIDEBAR_WIDTH = 580;
const LIVE_INPUT_ACTIONS = new Set(['click', 'drag', 'key', 'scroll', 'type']);

const VIEWPORT_PRESETS: BrowserViewportPreset[] = [
  { id: 'desktop', label: 'מחשב', width: 1440, height: 1000 },
  { id: 'tablet', label: 'טאבלט', width: 820, height: 1080 },
  { id: 'mobile', label: 'נייד', width: 390, height: 844 },
];

const INITIAL_CONTEXT: WorkbenchCodexContext = {
  type: 'code-ai:workbench-context',
  profileId: null,
  provider: null,
  sessionKey: null,
  sessionId: null,
  routePending: false,
  cwd: null,
  authenticated: false,
  deviceUnlocked: false,
};

function normalizeTargetUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function isViewerReadyPlaceholder(value: string | null | undefined) {
  if (!value || value === 'about:blank' || value.startsWith('chrome://newtab')) return true;
  if (!value.startsWith('data:text/html')) return false;
  try {
    return decodeURIComponent(value).includes('<title>Browser viewer ready</title>');
  } catch {
    return value.includes('Browser%20viewer%20ready');
  }
}

function buildChatFrameSource() {
  const route = readSessionRoute();
  const params = new URLSearchParams({ embed: 'workbench' });
  if (route?.profileId && route.sessionKey && route.kind) {
    return `${buildSessionPath(route.profileId, route.sessionKey, route.kind, 'chat')}?${params.toString()}`;
  }
  if (route?.profileId) params.set('profile', route.profileId);
  return `/chat?${params.toString()}`;
}

function replaceWorkbenchRoute(profileId: string | null, sessionKey: string | null, sessionId: string | null) {
  replaceCurrentSessionRoute(
    profileId,
    sessionKey,
    sessionKey ? (sessionId ? 'session' : 'draft') : null,
    'workbench'
  );
}

function targetUrlStorageKey(profileId: string, sessionKey: string) {
  return `${TARGET_URL_STORAGE_PREFIX}:${encodeURIComponent(profileId)}:${encodeURIComponent(sessionKey)}`;
}

function readStoredTargetUrl(profileId: string, sessionKey: string) {
  return localStorage.getItem(targetUrlStorageKey(profileId, sessionKey)) || '';
}

function writeStoredTargetUrl(profileId: string, sessionKey: string, targetUrl: string) {
  localStorage.setItem(targetUrlStorageKey(profileId, sessionKey), targetUrl);
}

function isWorkbenchBridgeMessage(value: unknown): value is WorkbenchBridgeMessage {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { type?: unknown }).type === 'string'
    && String((value as { type: string }).type).startsWith('code-ai:workbench-');
}

function selectionLabel(selection: WorkbenchElementSelection) {
  const element = selection.element;
  return element.sourceHint?.component
    || element.accessibleName
    || element.textSnippet
    || element.role
    || element.tagName;
}

function selectionDescription(selection: WorkbenchElementSelection) {
  const element = selection.element;
  if (element.sourceHint?.file) {
    return `${element.sourceHint.file}${element.sourceHint.line ? `:${element.sourceHint.line}` : ''}`;
  }
  return element.primarySelector;
}

function WorkbenchSelectionTray({
  selections,
  onRemove,
  onClear,
  onFocusComposer,
}: {
  selections: WorkbenchElementSelection[];
  onRemove: (selectionId: string) => void;
  onClear: () => void;
  onFocusComposer: () => void;
}) {
  if (selections.length === 0) return null;
  return (
    <div className="absolute bottom-20 left-1/2 z-50 w-[min(46rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white/95 p-2.5 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.34)] backdrop-blur-xl" dir="rtl">
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5 scrollbar-hide">
        {selections.map((selection, index) => (
          <div key={selection.selectionId} className="flex min-w-[13rem] max-w-[18rem] items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/75 p-1.5">
            {selection.cropUrl || selection.screenshotUrl ? (
              <img src={selection.cropUrl || selection.screenshotUrl || ''} alt="" className="h-10 w-12 shrink-0 rounded-lg border border-slate-200 bg-white object-cover" />
            ) : (
              <div className="flex h-10 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-400">
                <ScanSearch className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold text-slate-700">{index + 1}. {selectionLabel(selection)}</div>
              <div className="mt-0.5 truncate text-[9px] text-slate-400" dir="ltr">{selectionDescription(selection)}</div>
            </div>
            <button type="button" onClick={() => onRemove(selection.selectionId)} className="rounded-full p-1 text-slate-400 hover:bg-white hover:text-slate-700" aria-label="הסר בחירה">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" onClick={onFocusComposer} className="flex shrink-0 items-center gap-2 rounded-xl bg-slate-900 px-3 py-3 text-[11px] font-semibold text-white transition hover:bg-slate-800">
          <MessageSquareText className="h-4 w-4" />
          כתוב ל־Code‑AI
        </button>
        <button type="button" onClick={onClear} className="shrink-0 rounded-xl border border-slate-200 bg-white p-3 text-slate-400 transition hover:bg-slate-50 hover:text-rose-500" aria-label="נקה בחירות">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SourceInspector({ selections }: { selections: WorkbenchElementSelection[] }) {
  const [activeSelectionId, setActiveSelectionId] = useState<string | null>(null);
  const active = selections.find((selection) => selection.selectionId === activeSelectionId) || selections.at(-1) || null;

  useEffect(() => {
    if (!activeSelectionId && selections.length > 0) setActiveSelectionId(selections.at(-1)?.selectionId || null);
    if (activeSelectionId && !selections.some((selection) => selection.selectionId === activeSelectionId)) {
      setActiveSelectionId(selections.at(-1)?.selectionId || null);
    }
  }, [activeSelectionId, selections]);

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-8" dir="rtl">
        <div className="max-w-md text-center">
          <Code2 className="mx-auto h-9 w-9 text-slate-300" />
          <h2 className="mt-4 text-base font-semibold text-slate-700">בחר אלמנט בתצוגה</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">לאחר הבחירה יוצגו כאן מקור אפשרי, selector, כללי CSS והמאפיינים שמנוע Code‑AI יקבל.</p>
        </div>
      </div>
    );
  }

  const element = active.element;
  return (
    <div className="h-full overflow-auto bg-white p-5" dir="rtl">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Selected element</div>
            <h2 className="mt-1 text-xl font-semibold text-slate-800">{selectionLabel(active)}</h2>
            <div className="mt-2 max-w-3xl break-all font-mono text-xs text-slate-500" dir="ltr">{element.primarySelector}</div>
          </div>
          {active.cropUrl && <img src={active.cropUrl} alt="Selected element" className="max-h-28 max-w-52 rounded-xl border border-slate-200 bg-slate-50 object-contain" />}
        </div>

        {selections.length > 1 && (
          <div className="mt-4 flex gap-2 overflow-x-auto">
            {selections.map((selection, index) => (
              <button
                key={selection.selectionId}
                type="button"
                onClick={() => setActiveSelectionId(selection.selectionId)}
                className={active.selectionId === selection.selectionId
                  ? 'shrink-0 rounded-full border border-slate-900 bg-slate-900 px-3 py-1.5 text-[11px] text-white'
                  : 'shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50'}
              >
                {index + 1}. {selectionLabel(selection)}
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-slate-50/55 p-4">
            <h3 className="text-xs font-semibold text-slate-700">מקור ורכיב</h3>
            {element.sourceHint ? (
              <div className="mt-3 space-y-2 text-xs text-slate-600">
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono" dir="ltr">{element.sourceHint.file}:{element.sourceHint.line || '—'}</div>
                <div className="flex items-center justify-between"><span>רכיב</span><span className="font-medium">{element.sourceHint.component || 'לא זוהה'}</span></div>
                <div className="flex items-center justify-between"><span>שיטת התאמה</span><span>{element.sourceHint.method}</span></div>
                <div className="flex items-center justify-between"><span>ביטחון</span><span>{Math.round(element.sourceHint.confidence * 100)}%</span></div>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-6 text-slate-500">אין באתר Source Bridge. Code‑AI ישתמש ב־selector, בכללי CSS ובחיפוש בריפו כדי לאתר את המקור.</p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-slate-50/55 p-4">
            <h3 className="text-xs font-semibold text-slate-700">נגישות ומבנה</h3>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-slate-400">Tag</dt><dd className="font-mono text-slate-700" dir="ltr">{element.tagName}</dd>
              <dt className="text-slate-400">Role</dt><dd className="text-slate-700">{element.role || '—'}</dd>
              <dt className="text-slate-400">שם נגיש</dt><dd className="text-slate-700">{element.accessibleName || '—'}</dd>
              <dt className="text-slate-400">טקסט</dt><dd className="line-clamp-3 text-slate-700">{element.textSnippet || '—'}</dd>
              <dt className="text-slate-400">Fingerprint</dt><dd className="font-mono text-[10px] text-slate-500" dir="ltr">{element.domFingerprint}</dd>
            </dl>
          </section>
        </div>

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-xs font-semibold text-slate-700">Computed styles</h3>
          <div className="mt-3 grid gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-3" dir="ltr">
            {Object.entries(element.computedStyleSubset).map(([property, value]) => (
              <div key={property} className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-100 py-1.5 font-mono text-[10px]">
                <span className="truncate text-slate-400">{property}</span>
                <span className="max-w-[58%] truncate text-slate-700" title={value}>{value || '—'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-xs font-semibold text-slate-700">כללי CSS תואמים</h3>
          {element.matchedCssRules.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">לא נמצאו כללים נגישים; ייתכן שהם מגיעים מ־stylesheet חיצוני מוגן.</p>
          ) : (
            <div className="mt-3 space-y-3" dir="ltr">
              {element.matchedCssRules.slice(0, 20).map((rule, index) => (
                <div key={`${rule.selector}-${index}`} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/60">
                  <div className="border-b border-slate-200 bg-white px-3 py-2 font-mono text-[10px] font-semibold text-slate-700">{rule.selector}</div>
                  <pre className="overflow-x-auto p-3 text-[10px] leading-5 text-slate-600">{JSON.stringify(rule.declarations, null, 2)}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function WorkbenchApp() {
  const chatFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewAreaRef = useRef<HTMLDivElement | null>(null);
  const actionInFlightRef = useRef(false);
  const actionTailRef = useRef<Promise<void>>(Promise.resolve());
  const pendingActionsRef = useRef(0);
  const pendingBusyActionsRef = useRef(0);
  const hoverRequestSequenceRef = useRef(0);
  const pollingRef = useRef(false);
  const pendingComposerFocusRef = useRef(false);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const viewerRef = useRef<BrowserViewerState | null>(null);
  const activeBrowserBindingRef = useRef('');
  const initializationSequenceRef = useRef(0);
  const requestedSessionRouteRef = useRef(readSessionRoute());

  const [context, setContext] = useState<WorkbenchCodexContext>(INITIAL_CONTEXT);
  const [chatFrameSource] = useState(buildChatFrameSource);
  const [urlDraft, setUrlDraft] = useState('');
  const [viewer, setViewer] = useState<BrowserViewerState | null>(null);
  const [selections, setSelections] = useState<WorkbenchElementSelection[]>([]);
  const [hoveredElement, setHoveredElement] = useState<BrowserInspectedElement | null>(null);
  const [viewMode, setViewMode] = useState<WorkbenchViewMode>('preview');
  const [interactionMode, setInteractionMode] = useState<WorkbenchInteractionMode>('browse');
  const [viewportPreset, setViewportPreset] = useState<BrowserViewportPreset>(VIEWPORT_PRESETS[0]);
  const [customWidth, setCustomWidth] = useState(VIEWPORT_PRESETS[0].width);
  const [customHeight, setCustomHeight] = useState(VIEWPORT_PRESETS[0].height);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [streamHealthy, setStreamHealthy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binaConnection, setBinaConnection] = useState<'idle' | 'checking' | 'connected' | 'not-connected' | 'error'>('idle');
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 960);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const rawStored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!rawStored) return 430;
    const stored = Number(rawStored);
    return Number.isFinite(stored) ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, stored)) : 430;
  });

  const canUseBrowser = context.authenticated
    && context.deviceUnlocked
    && context.provider === 'codex'
    && Boolean(context.profileId && context.sessionKey);
  const browserBindingReady = canUseBrowser && viewer?.sessionKey === context.sessionKey;

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const postToChat = useCallback((message: WorkbenchBridgeMessage) => {
    chatFrameRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Code‑AI Workbench';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== chatFrameRef.current?.contentWindow) return;
      if (!isWorkbenchBridgeMessage(event.data)) return;
      if (event.data.type === 'code-ai:workbench-context') {
        const requestedRoute = requestedSessionRouteRef.current;
        const matchesRequestedRoute = Boolean(
          requestedRoute?.sessionKey
          && requestedRoute.sessionKey === event.data.sessionKey
          && (!requestedRoute.profileId || requestedRoute.profileId === event.data.profileId)
        );
        if (requestedRoute?.sessionKey && !matchesRequestedRoute && event.data.routePending) {
          return;
        }
        if (!event.data.routePending || matchesRequestedRoute) {
          requestedSessionRouteRef.current = null;
        }
        setContext(event.data);
        replaceWorkbenchRoute(event.data.profileId, event.data.sessionKey, event.data.sessionId);
        return;
      }
      if (event.data.type === 'code-ai:workbench-selections') {
        setSelections(Array.isArray(event.data.selections) ? event.data.selections.slice(0, 12) : []);
        return;
      }
      if (event.data.type === 'code-ai:workbench-clear-selections') {
        setSelections([]);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const message: WorkbenchSelectionMessage = { type: 'code-ai:workbench-selections', selections };
    postToChat(message);
  }, [postToChat, selections]);

  useEffect(() => {
    if (!canUseBrowser || !context.profileId || !context.sessionKey) {
      initializationSequenceRef.current += 1;
      activeBrowserBindingRef.current = '';
      return;
    }
    const bindingKey = `${context.profileId}:${context.sessionKey}`;
    const initializationSequence = ++initializationSequenceRef.current;
    activeBrowserBindingRef.current = bindingKey;
    const storedTargetUrl = readStoredTargetUrl(context.profileId, context.sessionKey);
    setUrlDraft(storedTargetUrl);
    let cancelled = false;
    const previousViewer = viewerRef.current;
    const shouldShowBlockingBusy = !previousViewer;
    const initialize = async () => {
      if (shouldShowBlockingBusy) setBusy(true);
      setError(null);
      setBinaConnection('checking');
      try {
        await enableWorkbenchBrowser(context.profileId!, context.sessionKey!);
        let nextViewer = await openWorkbenchBrowser(
          context.profileId!,
          context.sessionKey!,
          null,
        );

        try {
          const connection = await connectWorkbenchBinaSession(context.profileId!, context.sessionKey!);
          if (!cancelled) setBinaConnection(connection.connected ? 'connected' : 'not-connected');
        } catch {
          if (!cancelled) setBinaConnection('error');
        }

        const openedFreshViewer = isViewerReadyPlaceholder(nextViewer.currentUrl);
        const carriedTargetUrl = normalizeTargetUrl(storedTargetUrl) || null;
        if (openedFreshViewer && carriedTargetUrl && nextViewer.currentTabId) {
          nextViewer = await runWorkbenchBrowserAction(context.profileId!, context.sessionKey!, {
            action: 'navigate',
            tabId: nextViewer.currentTabId,
            url: carriedTargetUrl,
          });
        }
        if (openedFreshViewer && nextViewer.currentTabId) {
          nextViewer = await runWorkbenchBrowserAction(context.profileId!, context.sessionKey!, {
            action: 'resize',
            tabId: nextViewer.currentTabId,
            width: customWidth,
            height: customHeight,
          });
        }
        if (
          !cancelled
          && initializationSequence === initializationSequenceRef.current
          && activeBrowserBindingRef.current === bindingKey
        ) {
          viewerRef.current = nextViewer;
          setViewer(nextViewer);
          const nextTargetUrl = nextViewer.currentUrl && !nextViewer.currentUrl.startsWith('data:')
            ? nextViewer.currentUrl
            : storedTargetUrl;
          setUrlDraft(nextTargetUrl);
          if (nextTargetUrl) {
            writeStoredTargetUrl(context.profileId!, context.sessionKey!, nextTargetUrl);
          }
        }
      } catch (initializeError: any) {
        if (
          !cancelled
          && initializationSequence === initializationSequenceRef.current
          && activeBrowserBindingRef.current === bindingKey
        ) {
          setError(initializeError.message || 'לא ניתן היה לפתוח את סביבת הדפדפן.');
        }
      } finally {
        if (!cancelled && initializationSequence === initializationSequenceRef.current && shouldShowBlockingBusy) {
          setBusy(false);
        }
      }
    };
    void initialize();
    return () => { cancelled = true; };
    // Rebind the viewer only when the actual Code-AI context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseBrowser, context.profileId, context.sessionKey]);

  useEffect(() => {
    if (!viewer || !browserBindingReady || !context.profileId || !context.sessionKey) return;
    const intervalId = window.setInterval(() => {
      if (document.hidden || actionInFlightRef.current || pollingRef.current) return;
      pollingRef.current = true;
      const bindingKey = `${context.profileId}:${context.sessionKey}`;
      void runWorkbenchBrowserAction(context.profileId!, context.sessionKey!, {
        action: streamHealthy && viewer.frame?.streamUrl ? 'sync' : 'capture',
        tabId: viewer.currentTabId,
      }).then((nextViewer) => {
        if (activeBrowserBindingRef.current !== bindingKey) return;
        viewerRef.current = nextViewer;
        setViewer((current) => current?.sessionKey === nextViewer.sessionKey ? nextViewer : current);
        if (nextViewer.currentUrl && !nextViewer.currentUrl.startsWith('data:')) {
          setUrlDraft(nextViewer.currentUrl);
          writeStoredTargetUrl(context.profileId!, context.sessionKey!, nextViewer.currentUrl);
        }
      }).catch(() => {
        // Direct actions surface errors; a skipped background frame should stay silent.
      }).finally(() => {
        pollingRef.current = false;
      });
    }, streamHealthy && viewer.frame?.streamUrl ? 3_000 : 1_000);
    return () => window.clearInterval(intervalId);
  }, [browserBindingReady, context.profileId, context.sessionKey, streamHealthy, viewer?.currentTabId, viewer?.frame?.streamUrl, viewer?.sessionKey]);

  const runAction = useCallback((payload: Record<string, unknown>) => {
    if (!browserBindingReady || !context.profileId || !context.sessionKey) return Promise.resolve();
    const activeProfileId = context.profileId;
    const activeSessionKey = context.sessionKey;
    const bindingKey = `${activeProfileId}:${activeSessionKey}`;
    const actionType = typeof payload.action === 'string' ? payload.action : '';
    const shouldShowBusy = !streamHealthy || !LIVE_INPUT_ACTIONS.has(actionType);
    pendingActionsRef.current += 1;
    actionInFlightRef.current = true;
    if (shouldShowBusy) {
      pendingBusyActionsRef.current += 1;
      setBusy(true);
    }

    const execute = async () => {
      setError(null);
      try {
        const nextViewer = await runWorkbenchBrowserAction(activeProfileId, activeSessionKey, payload);
        if (activeBrowserBindingRef.current !== bindingKey) return;
        viewerRef.current = nextViewer;
        setViewer(nextViewer);
        if (nextViewer.currentUrl && !nextViewer.currentUrl.startsWith('data:')) {
          setUrlDraft(nextViewer.currentUrl);
          writeStoredTargetUrl(activeProfileId, activeSessionKey, nextViewer.currentUrl);
        }
        if (nextViewer.selection) {
          setSelections((current) => {
            if (interactionMode === 'multi-select') {
              const withoutDuplicate = current.filter((selection) => selection.element.domFingerprint !== nextViewer.selection!.element.domFingerprint);
              return [...withoutDuplicate, nextViewer.selection!].slice(-12);
            }
            return [nextViewer.selection!];
          });
          setHoveredElement(null);
        }
      } catch (actionError: any) {
        if (activeBrowserBindingRef.current === bindingKey) {
          setError(actionError.message || 'פעולת הדפדפן נכשלה.');
        }
      } finally {
        pendingActionsRef.current = Math.max(0, pendingActionsRef.current - 1);
        if (pendingActionsRef.current === 0) {
          actionInFlightRef.current = false;
        }
        if (shouldShowBusy) {
          pendingBusyActionsRef.current = Math.max(0, pendingBusyActionsRef.current - 1);
        }
        if (pendingBusyActionsRef.current === 0) {
          setBusy(false);
        }
      }
    };

    const next = actionTailRef.current.catch(() => undefined).then(execute);
    actionTailRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, [browserBindingReady, context.profileId, context.sessionKey, interactionMode, streamHealthy]);

  const handleBrowserInput = useCallback((payload: Record<string, unknown>) => {
    if (!browserBindingReady || !context.profileId || !context.sessionKey) return;
    void sendWorkbenchBrowserInput(context.profileId, context.sessionKey, payload).catch(() => {
      // High-frequency pointer input is best-effort; direct actions still surface errors.
    });
  }, [browserBindingReady, context.profileId, context.sessionKey]);

  const handleHoverPoint = useCallback((point: { x: number; y: number } | null) => {
    const requestSequence = ++hoverRequestSequenceRef.current;
    if (!point || !browserBindingReady || !context.profileId || !context.sessionKey || !viewer?.currentTabId) {
      setHoveredElement(null);
      return;
    }
    void inspectWorkbenchPoint(
      context.profileId,
      context.sessionKey,
      point.x,
      point.y,
      viewer.currentTabId,
    ).then((inspection) => {
      if (requestSequence === hoverRequestSequenceRef.current) setHoveredElement(inspection.element);
    }).catch(() => {
      if (requestSequence === hoverRequestSequenceRef.current) setHoveredElement(null);
    });
  }, [browserBindingReady, context.profileId, context.sessionKey, viewer?.currentTabId]);

  function handleNavigate(event?: FormEvent) {
    event?.preventDefault();
    if (!browserBindingReady) return;
    const normalized = normalizeTargetUrl(urlDraft);
    if (!normalized) {
      setError('יש להזין כתובת אתר.');
      return;
    }
    if (context.profileId && context.sessionKey) {
      writeStoredTargetUrl(context.profileId, context.sessionKey, normalized);
    }
    setSelections([]);
    void runAction({ action: 'navigate', tabId: viewer?.currentTabId, url: normalized });
  }

  async function applyViewport(preset: BrowserViewportPreset) {
    if (!browserBindingReady) return;
    setViewportPreset(preset);
    setCustomWidth(preset.width);
    setCustomHeight(preset.height);
    setZoom(1);
    await runAction({ action: 'resize', tabId: viewer?.currentTabId, width: preset.width, height: preset.height });
  }

  function handleRegionSelected(region: { x: number; y: number; width: number; height: number }) {
    const syntheticSelection: WorkbenchElementSelection = {
      selectionId: crypto.randomUUID(),
      tabId: viewer?.currentTabId || 0,
      url: viewer?.currentUrl || null,
      title: viewer?.currentTitle || null,
      capturedAt: new Date().toISOString(),
      screenshotImageId: viewer?.frame?.imageId || null,
      screenshotUrl: viewer?.frame?.imageUrl || null,
      cropImageId: null,
      cropUrl: null,
      element: {
        tagName: 'visual-region',
        role: 'region',
        accessibleName: 'אזור חזותי שנבחר',
        textSnippet: null,
        attributes: {},
        rect: {
          ...region,
          top: region.y,
          left: region.x,
          right: region.x + region.width,
          bottom: region.y + region.height,
        },
        primarySelector: `visual-region(${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)})`,
        selectorCandidates: [],
        framePath: [],
        shadowPath: [],
        ancestors: [],
        computedStyleSubset: {},
        matchedCssRules: [],
        sourceHint: null,
        sensitive: false,
        domFingerprint: `region-${viewer?.frame?.imageId || 'frame'}-${Math.round(region.x)}-${Math.round(region.y)}-${Math.round(region.width)}-${Math.round(region.height)}`,
        viewport: {
          width: customWidth,
          height: customHeight,
          devicePixelRatio: 1,
          scrollX: 0,
          scrollY: 0,
        },
      },
    };
    setSelections((current) => interactionMode === 'multi-select' ? [...current, syntheticSelection].slice(-12) : [syntheticSelection]);
  }

  function focusComposer() {
    pendingComposerFocusRef.current = true;
    setChatOpen(true);
    window.setTimeout(() => {
      postToChat({ type: 'code-ai:workbench-selections', selections });
      postToChat({ type: 'code-ai:workbench-request-context' });
      postToChat({ type: 'code-ai:workbench-focus-composer' });
      pendingComposerFocusRef.current = false;
    }, 120);
  }

  function handleChatFrameLoad() {
    window.setTimeout(() => {
      postToChat({ type: 'code-ai:workbench-selections', selections });
      postToChat({ type: 'code-ai:workbench-request-context' });
      if (pendingComposerFocusRef.current) {
        postToChat({ type: 'code-ai:workbench-focus-composer' });
        pendingComposerFocusRef.current = false;
      }
    }, 0);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!resizeStateRef.current) return;
    const next = resizeStateRef.current.startWidth + (resizeStateRef.current.startX - event.clientX);
    setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, next)));
  }

  function finishSidebarResize() {
    resizeStateRef.current = null;
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }

  const connectionLabel = !context.authenticated
    ? 'ממתין להתחברות'
    : !context.deviceUnlocked
      ? 'ממתין לפתיחת מכשיר'
      : context.provider !== 'codex'
        ? 'בחר פרופיל Codex'
        : !browserBindingReady && viewer
          ? 'מחבר לסשן'
        : busy
          ? 'מעדכן'
          : viewer?.frame
            ? 'מחובר'
            : 'מוכן';

  return (
    <div className="h-dvh w-full overflow-hidden bg-[#f6f7f8] font-sans text-slate-800" dir="ltr">
      <div className="flex h-full min-h-0 flex-row-reverse">
        {chatOpen && (
          <aside
            className="relative z-[70] h-full shrink-0 overflow-hidden border-l border-slate-200 bg-white max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:w-[min(92vw,28rem)] max-lg:shadow-2xl"
            style={{ width: window.innerWidth >= 1024 ? sidebarWidth : undefined }}
          >
            <iframe
              ref={chatFrameRef}
              src={chatFrameSource}
              title="Code-AI"
              className="h-full w-full border-0 bg-white"
              onLoad={handleChatFrameLoad}
              allow="clipboard-read; clipboard-write"
            />
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="absolute left-2 top-2 z-[80] hidden rounded-full border border-slate-200 bg-white/95 p-2 text-slate-500 shadow-sm max-lg:block"
              aria-label="סגור Code-AI"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onPointerDown={startSidebarResize}
              onPointerMove={resizeSidebar}
              onPointerUp={finishSidebarResize}
              className="absolute inset-y-0 -left-1 z-[80] hidden w-2 cursor-col-resize touch-none lg:block"
              aria-label="שנה רוחב סיידבר"
            >
              <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition hover:bg-sky-300" />
            </button>
          </aside>
        )}

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="relative z-40 flex h-12 shrink-0 items-center border-b border-slate-200 bg-white px-2.5 shadow-[0_6px_18px_-18px_rgba(15,23,42,0.3)]">
            <div className="flex shrink-0 items-center gap-1.5">
              <button type="button" onClick={() => setChatOpen((current) => !current)} className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100" title={chatOpen ? 'סגור Code-AI' : 'פתח Code-AI'}>
                {chatOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
              </button>
              <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
                <button type="button" onClick={() => setViewMode('preview')} className={viewMode === 'preview' ? 'rounded-[0.6rem] bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-800 shadow-sm' : 'rounded-[0.6rem] px-3 py-1.5 text-[11px] font-medium text-slate-500'}>Preview</button>
                <button type="button" onClick={() => setViewMode('code')} className={viewMode === 'code' ? 'rounded-[0.6rem] bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-800 shadow-sm' : 'rounded-[0.6rem] px-3 py-1.5 text-[11px] font-medium text-slate-500'}>Code</button>
              </div>
            </div>

            <div className="mx-auto flex min-w-0 max-w-3xl flex-1 items-center justify-center gap-1.5 px-2">
              <button type="button" disabled={!browserBindingReady || busy} onClick={() => void runAction({ action: 'back', tabId: viewer?.currentTabId })} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"><ArrowLeft className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={!browserBindingReady || busy} onClick={() => void runAction({ action: 'forward', tabId: viewer?.currentTabId })} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"><ArrowRight className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={!browserBindingReady || busy} onClick={() => void runAction({ action: 'refresh', tabId: viewer?.currentTabId })} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30"><RefreshCw className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /></button>
              <form onSubmit={handleNavigate} className="flex min-w-0 max-w-2xl flex-1 items-center rounded-xl border border-slate-200 bg-slate-50 px-2.5 focus-within:border-sky-300 focus-within:bg-white">
                <Globe2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <input
                  type="text"
                  dir="ltr"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  placeholder="https://example.com"
                  className="h-8 min-w-0 flex-1 bg-transparent px-2 text-center text-[11px] text-slate-700 outline-none placeholder:text-slate-300"
                />
                <button type="submit" disabled={!browserBindingReady || busy || !urlDraft.trim()} className="rounded-md p-1 text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-30"><ArrowRight className="h-3.5 w-3.5" /></button>
              </form>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <div className="hidden items-center gap-1 xl:flex">
                {VIEWPORT_PRESETS.map((preset) => {
                  const Icon = preset.id === 'desktop' ? Laptop : preset.id === 'tablet' ? Tablet : Smartphone;
                  return (
                    <button key={preset.id} type="button" onClick={() => void applyViewport(preset)} className={viewportPreset.id === preset.id ? 'rounded-lg bg-slate-100 p-2 text-slate-800' : 'rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700'} title={preset.label}>
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setZoom((current) => Math.max(0.5, Number((current - 0.1).toFixed(2))))} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="הקטן תצוגה"><Minus className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setZoom(1)} className="w-10 rounded-lg py-2 text-center text-[9px] text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="התאם את האתר לשטח התצוגה">{Math.round(zoom * 100)}%</button>
              <button type="button" onClick={() => setZoom((current) => Math.min(1.6, Number((current + 0.1).toFixed(2))))} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="הגדל תצוגה"><Plus className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => void previewAreaRef.current?.requestFullscreen()} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="מסך מלא"><Fullscreen className="h-3.5 w-3.5" /></button>
            </div>
          </header>

          {viewer && viewer.tabs.length > 1 && (
            <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3">
              {viewer.tabs.map((tab) => (
                <button key={tab.tabId} type="button" onClick={() => void runAction({ action: 'switchTab', tabId: tab.tabId })} className={viewer.currentTabId === tab.tabId ? 'max-w-56 truncate rounded-lg bg-slate-100 px-3 py-1.5 text-[10px] font-medium text-slate-700' : 'max-w-56 truncate rounded-lg px-3 py-1.5 text-[10px] text-slate-400 hover:bg-slate-50'}>
                  {tab.title || tab.url || `Tab ${tab.tabId}`}
                </button>
              ))}
              <button type="button" onClick={() => void runAction({ action: 'newTab' })} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><Plus className="h-3.5 w-3.5" /></button>
            </div>
          )}

          <div ref={previewAreaRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#f6f7f8]">
            {viewMode === 'preview' ? (
              <BrowserSurface
                viewer={viewer}
                mode={interactionMode}
                zoom={zoom}
                busy={busy}
                hoveredElement={hoveredElement}
                selections={selections}
                onAction={(payload) => void runAction(payload)}
                onBrowserInput={handleBrowserInput}
                onHoverPoint={handleHoverPoint}
                onRegionSelected={handleRegionSelected}
                onStreamHealthChange={setStreamHealthy}
              />
            ) : (
              <SourceInspector selections={selections} />
            )}

            {viewMode === 'preview' && (
              <div className="absolute bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-[0_20px_58px_-36px_rgba(15,23,42,0.38)] backdrop-blur-xl">
                <button type="button" onClick={() => setInteractionMode('browse')} className={interactionMode === 'browse' ? 'rounded-xl bg-slate-900 p-2.5 text-white' : 'rounded-xl p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700'} title="גלישה"><MousePointer2 className="h-4 w-4" /></button>
                <button type="button" onClick={() => setInteractionMode('select')} className={interactionMode === 'select' ? 'rounded-xl bg-violet-100 p-2.5 text-violet-700' : 'rounded-xl p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700'} title="בחר אלמנט"><ScanSearch className="h-4 w-4" /></button>
                <button type="button" onClick={() => setInteractionMode('multi-select')} className={interactionMode === 'multi-select' ? 'rounded-xl bg-sky-100 p-2.5 text-sky-700' : 'rounded-xl p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700'} title="בחירה מרובה"><Layers3 className="h-4 w-4" /></button>
                <button type="button" onClick={() => setInteractionMode('region')} className={interactionMode === 'region' ? 'rounded-xl bg-amber-100 p-2.5 text-amber-700' : 'rounded-xl p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700'} title="בחר אזור"><Maximize2 className="h-4 w-4" /></button>
                <span className="mx-1 h-6 w-px bg-slate-200" />
                <button type="button" onClick={() => setSelections([])} disabled={selections.length === 0} className="rounded-xl p-2.5 text-slate-400 hover:bg-slate-100 hover:text-rose-500 disabled:opacity-25" title="נקה בחירות"><Trash2 className="h-4 w-4" /></button>
              </div>
            )}

            {selections.length > 0 && viewMode === 'preview' && (
              <WorkbenchSelectionTray
                selections={selections}
                onRemove={(selectionId) => setSelections((current) => current.filter((selection) => selection.selectionId !== selectionId))}
                onClear={() => setSelections([])}
                onFocusComposer={focusComposer}
              />
            )}

            {!chatOpen && (
              <button type="button" onClick={() => setChatOpen(true)} className="absolute right-4 top-4 z-50 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-700 shadow-sm backdrop-blur">
                <MessageSquareText className="h-4 w-4" />
                Code‑AI
              </button>
            )}

            {error && (
              <div className="absolute left-1/2 top-4 z-50 flex max-w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-rose-200 bg-white/95 px-4 py-3 text-xs text-rose-700 shadow-lg backdrop-blur" dir="rtl">
                <span className="min-w-0 flex-1">{error}</span>
                <button type="button" onClick={() => setError(null)} className="rounded-full p-1 hover:bg-rose-50"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </div>

          <footer className="flex h-8 shrink-0 items-center justify-between border-t border-slate-200 bg-white px-3 text-[9px] text-slate-400" dir="rtl">
            <div className="flex items-center gap-2">
              <span className={viewer?.frame && browserBindingReady ? 'h-1.5 w-1.5 rounded-full bg-emerald-400' : busy ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400' : 'h-1.5 w-1.5 rounded-full bg-slate-300'} />
              <span>{connectionLabel}</span>
              {binaConnection === 'connected' && (
                <span className="flex items-center gap-1 border-r border-slate-200 pr-2 text-emerald-600" title="הסשן המרכזי של Bina אומת וחובר לדפדפן העבודה">
                  <ShieldCheck className="h-3 w-3" />
                  Bina מחובר
                </span>
              )}
              {context.cwd && <span className="max-w-64 truncate border-r border-slate-200 pr-2" dir="ltr" title={context.cwd}>{context.cwd}</span>}
            </div>
            <div className="flex items-center gap-3" dir="ltr">
              <span>{customWidth} × {customHeight}</span>
              <span>{selections.length} selected</span>
              {context.sessionId && <span className="max-w-44 truncate" title={context.sessionId}>{context.sessionId}</span>}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

export default WorkbenchApp;
