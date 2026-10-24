type Json = Record<string, unknown>;

const now = '2026-09-29T10:00:00.000Z';
const profile = {
  id: 'preview', label: 'חשבון הדגמה', provider: 'codex', mode: 'standard',
  codexHome: '/demo/.codex', workspaceCwd: '/demo/projects/code-ai', defaultProfile: true,
};
const sessions = [
  { id: 'preview-architecture', title: 'מפת הארכיטקטורה של CODE-AI', preview: 'הצג לי את חלקי המערכת והקשרים ביניהם', startPreview: 'הצג לי את חלקי המערכת', endPreview: 'זו מפת המערכת.', updatedAt: now, createdAt: now, lastCompletedAt: now, profileId: profile.id, cwd: profile.workspaceCwd, messageCount: 3, source: 'fixture' },
  { id: 'preview-design', title: 'ליטוש הממשק', preview: 'נבחן את צבעי התצוגה', startPreview: 'נבחן את צבעי התצוגה', endPreview: 'העיצוב עודכן.', updatedAt: '2026-09-28T11:00:00.000Z', createdAt: '2026-09-28T10:00:00.000Z', lastCompletedAt: '2026-09-28T11:00:00.000Z', profileId: profile.id, cwd: profile.workspaceCwd, messageCount: 2, source: 'fixture' },
];
const timeline = [
  { id: 'e1', entryType: 'message', role: 'user', kind: 'prompt', text: 'הצג לי את חלקי המערכת והקשרים ביניהם.', timestamp: '2026-09-29T09:00:00.000Z' },
  { id: 'e2', entryType: 'message', role: 'assistant', kind: 'commentary', text: 'אני בודק את המבנה ומארגן את החלקים לפי סדר הזרימה.', timestamp: '2026-09-29T09:01:00.000Z' },
  { id: 'e3', entryType: 'tool', title: 'קריאת קבצי הממשק', toolName: 'exec_command', status: 'completed', timestamp: '2026-09-29T09:02:00.000Z', toolInputText: 'rg --files client/src', toolOutputText: 'App.tsx\nCodexMobileApp.tsx\nWorkbenchApp.tsx' },
  { id: 'e4', entryType: 'message', role: 'assistant', kind: 'final', text: 'הממשק מורכב ממסך השיחה, סרגל השיחות, אזור הכתיבה וסביבת העבודה. זו תצוגת הדגמה בלבד, ללא שרת פעיל.', timestamp: now },
];
const details = sessions.map((session, index) => ({
  ...session, modelProvider: 'codex', timeline: index ? [timeline[0], timeline[3]] : timeline,
  totalTimelineEntries: index ? 2 : timeline.length, timelineWindowStart: 0,
  timelineWindowEnd: index ? 2 : timeline.length, hasEarlierTimeline: false,
}));

function json(value: Json, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fixture(path: string, url: URL): Json | null {
  if (path === '/api/codex/auth/status') return { authenticated: true, localBypass: true, deviceUnlocked: true, user: { id: 'preview-user', email: 'preview@local.invalid', name: 'תצוגת הדגמה' } };
  if (path === '/api/codex/servers') return { servers: [{ id: 'local', label: 'ממשק הדגמה', transport: 'local', isLocal: true, enabled: true, description: 'תצוגה מקומית ללא שרת', status: 'online', lastCheckedAt: now, lastError: null, hostname: null, version: null, codexVersion: null, profileCount: 1, authenticatedProfileCount: 1 }] };
  if (path === '/api/codex/profiles') return { profiles: [profile] };
  if (path === '/api/codex/sessions') return { sessions };
  if (path.startsWith('/api/codex/sessions/')) {
    const id = decodeURIComponent(path.split('/')[4] || '');
    const session = details.find((item) => item.id === id);
    return session ? { session } : null;
  }
  if (path === '/api/codex/queue/items') return { items: [], boundSessionId: null };
  if (path === '/api/codex/session-read-state') return { viewed: Object.fromEntries(sessions.map((s) => [s.id, Date.parse(s.updatedAt)])), completions: {}, activity: {} };
  if (path === '/api/codex/topics') return { topics: [] };
  if (path === '/api/codex/models') return {
    models: [{ slug: 'gpt-6-sol', displayName: 'GPT-6 Sol', description: 'מודל לדוגמה', defaultReasoningLevel: 'medium', supportedReasoningLevels: [{ effort: 'medium', description: 'רגילה' }], isConfiguredDefault: true }],
    selectedModel: 'gpt-6-sol', selectedReasoningEffort: 'medium', permissions: null, responseSpeed: null,
  };
  if (path === '/api/codex/rate-limits') return { rateLimits: null };
  if (path === '/api/codex/session-browser-mode') return { browserMode: { enabled: true, headless: true, profileSeed: 'empty', customProfileDir: '' } };
  if (path === '/api/codex/session-browser-viewer') return { viewer: {
    currentTabId: null, currentTitle: null, currentUrl: 'about:blank', frame: null,
    headless: true, profileDir: '', sessionKey: url.searchParams.get('sessionKey') || '', tabs: [],
  } };
  if (path === '/api/codex/session-context-selection') return { selection: { anchorIds: [], skillIds: [], reminderIds: [], agentSessionDraftId: null, professionalMode: false, annotationsMode: false, goalMode: false, actionRestriction: null } };
  if (path === '/api/codex/session-flow-mode') return { flowMode: { enabled: false, detail: 'balanced', brief: '', activeMapId: null, maps: [], document: null, mapRevision: 0, revision: 0, updatedAt: null, lastGeneratedAt: null, source: null } };
  if (path === '/api/codex/session-instruction') return { instruction: null, enabled: true, legacyLikelyTruncated: false };
  if (path === '/api/codex/session-design-mode') return { designMode: null };
  if (path === '/api/codex/session-ux-mode') return { uxMode: null };
  if (path === '/api/codex/session-project-mode') return { projectMode: null };
  if (path === '/api/codex/session-conversation-search-mode') return { searchMode: null };
  if (path === '/api/codex/session-personal-chrome-mode') return { personalChromeMode: null };
  if (path === '/api/codex/session-phone-mode') return { phoneMode: null };
  if (path === '/api/codex/session-reminders') return { reminders: [] };
  if (path === '/api/codex/anchors') return { anchors: [] };
  if (path === '/api/codex/agent-sessions') return { agentSessions: [], sessions: [] };
  if (path === '/api/codex/account-auth') return { auth: { state: 'idle', flowId: null, profileId: profile.id, verificationUrl: null, userCode: null, startedAt: null, expiresAt: null, completedAt: null, error: null } };
  if (path === '/api/codex/session-subtasks') return { subtasks: [] };
  if (path === '/api/codex/browser-extension/devices') return { devices: [] };
  if (path === '/api/codex/browser-extension/bindings') return { bindings: [] };
  if (path === '/api/codex/folders' || path === '/api/codex/file-tree') {
    const rootPath = profile.workspaceCwd;
    return { currentPath: rootPath, currentName: 'code-ai', rootPath, parentPath: null,
      breadcrumbs: [{ name: 'code-ai', path: rootPath }], entries: [],
      roots: [{ label: 'פרויקט לדוגמה', path: rootPath }], truncated: false };
  }
  if (path === '/api/codex/project-anchors') return { anchors: [] };
  if (path === '/api/codex/skills') return { skills: [] };
  if (path === '/api/codex/reminders') return { reminders: [] };
  if (path === '/api/codex/tasks') return { tasks: [] };
  if (path === '/api/codex/session-final-notification') return { notification: { enabled: false, effectiveEnabled: false, defaultEnabled: false, available: false, endpointLabel: null, longResponseMode: 'attachment' } };
  return null;
}

export function installPreviewApi(): void {
  const previewFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input), window.location.href);
    const method = (init?.method || request?.method || 'GET').toUpperCase();
    if (method !== 'GET') return json({ error: 'זהו עותק תצוגה בלבד. פעולות שמירה ושליחה אינן זמינות.' }, 403);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
      return json({ error: 'העותק מנותק מהרשת ומהבקאנד.' }, 403);
    }
    if (url.pathname.endsWith('/events')) {
      return new Response('event: ready\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    const payload = fixture(url.pathname, url);
    return payload ? json(payload) : json({ error: 'נתוני הדגמה אינם זמינים למסך הזה.' }, 404);
  };
  window.fetch = previewFetch;
  try {
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => false });
  } catch { /* The server also blocks all API traffic. */ }
}
