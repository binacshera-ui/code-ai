interface CodexClientLogContext {
  profileId?: string | null;
  selectedSessionId?: string | null;
  queueKey?: string | null;
  isDraftConversation?: boolean;
  isSidebarOpen?: boolean;
  isScheduleOpen?: boolean;
  sessionCount?: number;
  visibleQueueCount?: number;
  activeQueueCount?: number;
  timelineLength?: number;
  renderedTimelineLength?: number;
  searchQuery?: string;
}

interface CodexClientLogPayload {
  type: string;
  message: string;
  stack?: string | null;
  details?: Record<string, unknown> | null;
}

interface CodexClientLogEvent {
  createdAt: string;
  href: string;
  userAgent: string;
  viewport: {
    width: number;
    height: number;
  };
  memory?: {
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
    usedJSHeapSize?: number;
  };
  breadcrumbs: Array<{ at: string; label: string; data?: Record<string, unknown> }>;
  context: CodexClientLogContext;
  type: string;
  message: string;
  stack?: string | null;
  details?: Record<string, unknown> | null;
}

type BrowserMemory = {
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
};

declare global {
  interface Performance {
    memory?: BrowserMemory;
  }
}

const LOG_ENDPOINT = '/api/codex/client-logs';
const MAX_BREADCRUMBS = 40;
const DEDUPE_WINDOW_MS = 12_000;

let latestRuntimeContext: CodexClientLogContext = {};
let installed = false;
let breadcrumbTrail: Array<{ at: string; label: string; data?: Record<string, unknown> }> = [];
let lastFingerprint = '';
let lastFingerprintAt = 0;

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildEvent(payload: CodexClientLogPayload): CodexClientLogEvent {
  return {
    createdAt: new Date().toISOString(),
    href: window.location.href,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    memory: performance?.memory
      ? {
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        usedJSHeapSize: performance.memory.usedJSHeapSize,
      }
      : undefined,
    breadcrumbs: breadcrumbTrail.slice(-MAX_BREADCRUMBS),
    context: { ...latestRuntimeContext },
    type: payload.type,
    message: payload.message,
    stack: payload.stack || null,
    details: payload.details || null,
  };
}

function sendLog(event: CodexClientLogEvent) {
  const body = JSON.stringify(event);

  if (typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon(LOG_ENDPOINT, blob);
    return;
  }

  void fetch(LOG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

export function setCodexRuntimeContext(context: CodexClientLogContext) {
  latestRuntimeContext = { ...context };
}

export function recordCodexBreadcrumb(label: string, data?: Record<string, unknown>) {
  breadcrumbTrail.push({
    at: new Date().toISOString(),
    label,
    data,
  });

  if (breadcrumbTrail.length > MAX_BREADCRUMBS) {
    breadcrumbTrail = breadcrumbTrail.slice(-MAX_BREADCRUMBS);
  }
}

export function reportCodexClientLog(payload: CodexClientLogPayload) {
  const event = buildEvent(payload);
  const fingerprint = JSON.stringify([
    event.type,
    event.message,
    event.stack || '',
    event.context.profileId || '',
    event.context.selectedSessionId || '',
  ]);
  const now = Date.now();

  if (fingerprint === lastFingerprint && now - lastFingerprintAt < DEDUPE_WINDOW_MS) {
    return;
  }

  lastFingerprint = fingerprint;
  lastFingerprintAt = now;
  sendLog(event);
}

export function installCodexGlobalCrashHandlers() {
  if (installed || typeof window === 'undefined') {
    return () => undefined;
  }

  installed = true;

  const handleError = (event: ErrorEvent) => {
    reportCodexClientLog({
      type: 'window-error',
      message: event.message || 'Unknown window error',
      stack: event.error?.stack || null,
      details: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = typeof reason === 'string'
      ? reason
      : reason?.message || 'Unhandled promise rejection';

    reportCodexClientLog({
      type: 'unhandledrejection',
      message,
      stack: reason?.stack || null,
      details: {
        reason: typeof reason === 'object' ? safeSerialize(reason) : String(reason),
      },
    });
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    installed = false;
  };
}
