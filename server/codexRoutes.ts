import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import type { AppProvider } from './config.js';
import {
  CodexExecutionConfig,
  CodexSessionDetail,
  CodexUploadedAttachment,
  CODEX_UPLOAD_ROOT,
} from './codexService.js';
import {
  createAgentForkSession,
  getAgentSessionChangeRecord,
  getAgentModelCatalog,
  getAgentRateLimitSnapshot,
  getAgentSessionDetail,
  getAvailableProfiles,
  listAgentSessions,
  runAgentPrompt,
} from './agentService.js';
import { CLIENT_CRASH_LOG } from './codexCrashLogs.js';
import {
  cancelCodexQueueItem,
  deleteCodexQueueItem,
  enqueueCodexQueueItem,
  getCodexQueueItem,
  getCodexQueueItemSession,
  listCodexQueueItems,
  retryCodexQueueItem,
} from './codexQueue.js';
import { CODEX_APP_CONFIG } from './config.js';
import { appendCodexFileLog, readRecentCodexFileLogs } from './codexFileLogs.js';
import { MAX_PREVIEW_FILE_BYTES, resolveCodexFileTarget } from './codexFileResolver.js';
import { browseCodexFileTree } from './codexFileTree.js';
import { browseCodexFolders, resolveCodexFolderPath } from './codexFolderBrowser.js';
import { listHiddenSessionIds, setSessionHidden } from './codexSessionVisibility.js';
import {
  createSessionTopic,
  getSessionTopicMap,
  listSessionTopics,
  setSessionTopic,
} from './codexSessionTopics.js';
import { getSessionTitleMap, setSessionCustomTitle } from './codexSessionTitles.js';
import { getSessionInstruction, setSessionInstruction } from './codexSessionInstructions.js';
import { createForkDraftSession, getForkDraftSession, recordForkSessionMetadata } from './codexForkSessions.js';

const router = Router();
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const MAX_UPLOAD_FILES = 8;
const RECURRING_FREQUENCIES = new Set(['daily', 'weekly']);
const CODEX_CLIENT_LOG_ROOT = path.dirname(CLIENT_CRASH_LOG);
const CODEX_CLIENT_LOG_FILE = CLIENT_CRASH_LOG;
const DEVICE_UNLOCK_COOKIE = 'code_ai_device_unlock';
const FORUM_SESSION_COOKIE = 'forum.session';

function sanitizeFileName(fileName: string): string {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  const normalized = stem
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${normalized || 'attachment'}${extension}`;
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function appendClientCrashLog(entry: Record<string, unknown>) {
  await fs.mkdir(CODEX_CLIENT_LOG_ROOT, { recursive: true });
  await fs.appendFile(CODEX_CLIENT_LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function readRecentClientCrashLogs(limit = 20) {
  try {
    const raw = await fs.readFile(CODEX_CLIENT_LOG_FILE, 'utf-8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 200)));

    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .reverse();
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function readRecurringConfig(body: any): { frequency: 'daily' | 'weekly'; timeZone: string } | undefined {
  const recurrence = body?.recurrence;

  if (!recurrence || typeof recurrence !== 'object') {
    return undefined;
  }

  const frequency = typeof recurrence.frequency === 'string' ? recurrence.frequency.trim() : '';
  const timeZone = typeof recurrence.timeZone === 'string' ? recurrence.timeZone.trim() : '';

  if (!RECURRING_FREQUENCIES.has(frequency)) {
    throw new Error('Recurring frequency is invalid');
  }

  if (!timeZone) {
    throw new Error('Recurring timezone is required');
  }

  return {
    frequency: frequency as 'daily' | 'weekly',
    timeZone,
  };
}

function readExecutionConfig(body: any): CodexExecutionConfig {
  const model = typeof body?.model === 'string' && body.model.trim()
    ? body.model.trim()
    : null;
  const reasoningEffort = typeof body?.reasoningEffort === 'string' && body.reasoningEffort.trim()
    ? body.reasoningEffort.trim()
    : null;

  return {
    model,
    reasoningEffort,
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      fs.mkdir(CODEX_UPLOAD_ROOT, { recursive: true })
        .then(() => callback(null, CODEX_UPLOAD_ROOT))
        .catch((error) => callback(error as Error, CODEX_UPLOAD_ROOT));
    },
    filename: (_req, file, callback) => {
      callback(null, `${Date.now()}-${randomUUID()}-${sanitizeFileName(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: MAX_UPLOAD_FILES,
  },
});

function readRequestHost(req: Request): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawHost = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || req.headers.host || '';

  return rawHost.split(',')[0]?.trim().toLowerCase() || '';
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

function readRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return value || '';
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  return header.split(';').reduce<Record<string, string>>((accumulator, part) => {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim();
    if (!key) {
      return accumulator;
    }

    accumulator[key] = decodeURIComponent(rawValue.join('=').trim());
    return accumulator;
  }, {});
}

function isPublicCodexHost(req: Request): boolean {
  if (CODEX_APP_CONFIG.openAccess) {
    return true;
  }

  const host = stripPort(readRequestHost(req));
  return CODEX_APP_CONFIG.publicHosts.includes(host);
}

function isLoopbackIp(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function createDeviceUnlockToken(req: Request): string {
  const host = stripPort(readRequestHost(req)) || 'codex-device';
  return createHmac('sha256', CODEX_APP_CONFIG.sessionSecret)
    .update(`${host}|codex-device-unlock`)
    .digest('hex');
}

function hasUnlockedDevice(req: Request): boolean {
  const cookies = parseCookies(req);
  const current = cookies[DEVICE_UNLOCK_COOKIE];
  if (!current) {
    return false;
  }

  const expected = createDeviceUnlockToken(req);
  try {
    return timingSafeEqual(Buffer.from(current), Buffer.from(expected));
  } catch {
    return false;
  }
}

function clearCodexAuthCookies(res: Response) {
  const deviceCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    domain: CODEX_APP_CONFIG.sessionCookieDomain || undefined,
    path: '/',
  };

  res.clearCookie(DEVICE_UNLOCK_COOKIE, deviceCookieOptions);
  res.clearCookie(FORUM_SESSION_COOKIE, {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: process.env.NODE_ENV === 'production' && CODEX_APP_CONFIG.sessionCookieDomain
      ? CODEX_APP_CONFIG.sessionCookieDomain
      : undefined,
    path: '/',
  });
}

function readAuthenticatedUser(req: Request) {
  const deviceUnlocked = hasUnlockedDevice(req);

  if (isPublicCodexHost(req)) {
    return {
      authenticated: true,
      localBypass: false,
      publicAccess: true,
      deviceUnlocked,
      user: {
        id: 'public-codex-access',
        email: '',
        name: 'Codex Open Access',
      },
    };
  }

  const remoteIp = req.ip || req.socket.remoteAddress || '';
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedFirst = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  const isLocalBypass = isLoopbackIp(remoteIp) && (!forwardedFirst || isLoopbackIp(forwardedFirst));

  if (isLocalBypass) {
    return {
      authenticated: true,
      localBypass: true,
      publicAccess: false,
      deviceUnlocked: true,
      user: {
        id: 'local-server',
        email: 'local@server',
        name: 'Local Server',
      },
    };
  }

  const session = req.session as any;

  if (session?.customerId) {
    return {
      authenticated: true,
      localBypass: false,
      publicAccess: false,
      deviceUnlocked: true,
      user: {
        id: session.customerId,
        email: session.customerEmail || '',
        name: session.customerEmail?.split('@')[0] || 'משתמש',
      },
    };
  }

  if (session?.userId) {
    return {
      authenticated: true,
      localBypass: false,
      publicAccess: false,
      deviceUnlocked: true,
      user: {
        id: session.userId,
        email: session.user?.email || '',
        name: session.user?.displayName || session.user?.username || 'משתמש',
      },
    };
  }

  return {
    authenticated: false,
    localBypass: false,
    publicAccess: false,
    deviceUnlocked: false,
    user: null,
  };
}

function requireCodexAccess(req: Request, res: Response, next: NextFunction) {
  const authState = readAuthenticatedUser(req);

  if (!authState.authenticated) {
    res.status(401).json({
      authenticated: false,
      error: 'פתח את code-ai דרך הכתובת שהוגדרה לשרת.',
    });
    return;
  }

  if (!authState.deviceUnlocked) {
    res.status(403).json({
      authenticated: true,
      deviceUnlocked: false,
      error: 'המכשיר הזה עדיין לא נפתח עם סיסמת הניהול.',
    });
    return;
  }

  (req as any).codexAuth = authState;
  next();
}

async function logFileRouteEvent(
  req: Request,
  entry: {
    type: string;
    rawTarget?: string;
    resolvedPath?: string | null;
    status?: number;
    message?: string;
    matches?: string[];
    mimeType?: string | false;
    previewKind?: string;
    size?: number;
    lineNumber?: number | null;
    metadata?: Record<string, unknown>;
  }
) {
  const authState = (req as any).codexAuth;
  await appendCodexFileLog({
    ...entry,
    authUserId: authState?.user?.id || null,
    remoteIp: req.ip || req.socket.remoteAddress || null,
    profileId: typeof req.query.profile === 'string'
      ? req.query.profile
      : typeof req.body?.profileId === 'string'
        ? req.body.profileId
        : null,
  });
}

async function hydrateForkDraftRequest(
  profileId: string,
  queueKey: string | undefined,
  sessionId: string | undefined,
  contextPrefix: string | undefined,
  forkContext: any
): Promise<{
  contextPrefix: string | undefined;
  forkContext: any;
}> {
  const draftSessionId = [sessionId, queueKey].find((value) => typeof value === 'string' && value.startsWith('draft:'));
  const needsContextPrefix = !contextPrefix?.trim();
  const needsForkTimeline = !forkContext || typeof forkContext !== 'object' || !Array.isArray(forkContext.timeline) || forkContext.timeline.length === 0;

  if (!draftSessionId || (!needsContextPrefix && !needsForkTimeline)) {
    return {
      contextPrefix,
      forkContext,
    };
  }

  const draft = await getForkDraftSession(draftSessionId);
  if (!draft || draft.profileId !== profileId) {
    return {
      contextPrefix,
      forkContext,
    };
  }

  return {
    contextPrefix: needsContextPrefix ? draft.promptPrefix : contextPrefix,
    forkContext: needsForkTimeline
      ? {
        sourceSessionId: draft.sourceSessionId,
        sourceTitle: draft.sourceTitle,
        sourceCwd: draft.sourceCwd,
        forkEntryId: draft.forkEntryId,
        transferSourceProvider: draft.transferSourceProvider || null,
        transferTargetProvider: draft.transferTargetProvider || null,
        timeline: draft.timeline,
      }
      : forkContext,
  };
}

function isDraftSessionKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('draft:');
}

async function copySessionSidebarMetadataToForkSession(
  sourceProfileId: string,
  targetProfileId: string,
  sourceSession: CodexSessionDetail,
  targetSessionId: string
) {
  const [hiddenIds, topicMap, titleMap] = await Promise.all([
    listHiddenSessionIds(sourceProfileId),
    getSessionTopicMap(sourceProfileId),
    getSessionTitleMap(sourceProfileId),
  ]);

  const sourceTopic = topicMap[sourceSession.id] || null;
  const sourceCustomTitle = titleMap[sourceSession.id] || null;
  const nextHidden = hiddenIds.has(sourceSession.id);
  let assignedTopic: CodexSessionTopic | null = null;

  if (sourceTopic) {
    const targetTopics = await listSessionTopics(targetProfileId, sourceTopic.cwd);
    let targetTopic = targetTopics.find((topic) => (
      topic.name === sourceTopic.name
      && topic.icon === sourceTopic.icon
      && topic.colorKey === sourceTopic.colorKey
    )) || null;

    if (!targetTopic) {
      targetTopic = await createSessionTopic(targetProfileId, sourceTopic.cwd, {
        name: sourceTopic.name,
        icon: sourceTopic.icon,
        colorKey: sourceTopic.colorKey,
      });
    }

    await setSessionTopic(targetProfileId, targetSessionId, targetTopic.id, sourceSession.cwd);
    assignedTopic = targetTopic;
  }

  if (nextHidden) {
    await setSessionHidden(targetProfileId, targetSessionId, true);
  }

  if (sourceCustomTitle) {
    await setSessionCustomTitle(targetProfileId, targetSessionId, sourceCustomTitle);
  }

  return {
    hidden: nextHidden,
    topic: assignedTopic,
    title: sourceCustomTitle || sourceSession.title,
  };
}

function getProviderDisplayLabel(provider: AppProvider): string {
  if (provider === 'claude') {
    return 'Claude';
  }

  if (provider === 'gemini') {
    return 'Gemini';
  }

  return 'Codex';
}

function clipTransferText(text: string, limit = 6_000): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}\n…`;
}

function renderTransferTimelineEntry(
  entry: CodexSessionDetail['timeline'][number],
  sourceProviderLabel: string
): string | null {
  if (entry.entryType === 'message' && typeof entry.text === 'string') {
    const prefix = entry.role === 'user'
      ? 'משתמש'
      : entry.kind === 'commentary'
        ? `${sourceProviderLabel} (עובד)`
        : sourceProviderLabel;
    return `${prefix}:\n${clipTransferText(entry.text, entry.kind === 'commentary' ? 3_000 : 8_000)}`;
  }

  if (entry.entryType === 'tool') {
    const title = entry.title || entry.toolName || 'Tool';
    const details = [entry.subtitle, entry.text].filter(Boolean).join('\n');
    return `כלי ${title}:\n${clipTransferText(details || 'Tool event without textual details.', 4_000)}`;
  }

  if (entry.entryType === 'status') {
    const details = [entry.title || entry.status || 'Status', entry.subtitle].filter(Boolean).join('\n');
    return `סטטוס:\n${clipTransferText(details, 2_000)}`;
  }

  return null;
}

function buildTransferPromptPrefix(
  sourceSession: CodexSessionDetail,
  sourceProviderLabel: string,
  timeline: CodexSessionDetail['timeline']
): string {
  const transcript = timeline
    .map((entry) => renderTransferTimelineEntry(entry, sourceProviderLabel))
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  return [
    `הקשר משוחזר מתוך שיחה קיימת עם ${sourceProviderLabel}.`,
    `כותרת השיחה: ${sourceSession.title}`,
    sourceSession.cwd ? `התיקייה הפעילה: ${sourceSession.cwd}` : '',
    'להלן השיחה עד הנקודה שנבחרה, לפי סדר כרונולוגי:',
    transcript,
    `עד כאן השיחה עם ${sourceProviderLabel} ועכשיו תורך. אל תסכם את השיחה ואל תדבר עליה מבחוץ. המשך ישירות מאותה נקודה. אם ההודעה האחרונה היא של המשתמש, ענה למשתמש. אם ההודעה האחרונה היא של המודל, המשך בהתאם לבקשה האחרונה של המשתמש.`,
  ].filter(Boolean).join('\n\n');
}

function buildTransferAutoPrompt(lastEntry: CodexSessionDetail['timeline'][number] | undefined): string {
  if (lastEntry?.entryType === 'message' && lastEntry.role === 'user') {
    return 'ענה עכשיו למשתמש מאותה נקודה, בלי לסכם את השיחה.';
  }

  return 'המשך עכשיו מאותה נקודה בצורה טבעית, בלי לסכם את השיחה.';
}

router.get('/auth/status', (req, res) => {
  res.json(readAuthenticatedUser(req));
});

router.post('/device-unlock', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (password !== CODEX_APP_CONFIG.deviceAdminPassword) {
    res.status(401).json({ error: 'סיסמת הניהול שגויה.' });
    return;
  }

  res.cookie(DEVICE_UNLOCK_COOKIE, createDeviceUnlockToken(req), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    domain: CODEX_APP_CONFIG.sessionCookieDomain || undefined,
    path: '/',
  });

  res.json({
    unlocked: true,
    deviceUnlocked: true,
  });
});

router.post('/logout', (req, res) => {
  const finalize = () => {
    clearCodexAuthCookies(res);
    res.json({ loggedOut: true });
  };

  const session = req.session as any;
  if (!session) {
    finalize();
    return;
  }

  session.destroy((error: any) => {
    if (error) {
      res.status(500).json({ error: 'לא ניתן היה לנתק את הסשן.' });
      return;
    }

    finalize();
  });
});

router.post('/client-logs', requireCodexAccess, async (req, res) => {
  try {
    const authState = (req as any).codexAuth;
    const entry = {
      ...req.body,
      receivedAt: new Date().toISOString(),
      remoteIp: req.ip || req.socket.remoteAddress || null,
      authUserId: authState?.user?.id || null,
    };

    await appendClientCrashLog(entry);
    res.status(202).json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to persist client crash log' });
  }
});

router.get('/client-logs', requireCodexAccess, async (req, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
    const logs = await readRecentClientCrashLogs(limit);
    res.json({ logs });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to read client crash logs' });
  }
});

router.post('/uploads', requireCodexAccess, upload.array('files', MAX_UPLOAD_FILES), async (req, res) => {
  try {
    const files = ((req.files as Express.Multer.File[]) || []).map((file) => ({
      id: randomUUID(),
      name: file.originalname,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      path: file.path,
      isImage: file.mimetype.startsWith('image/'),
    }));

    res.json({ files });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to upload files' });
  }
});

router.get('/profiles', requireCodexAccess, async (_req, res) => {
  try {
    const profiles = await getAvailableProfiles();
    res.json({ profiles });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load Codex profiles' });
  }
});

router.get('/models', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const catalog = await getAgentModelCatalog(profileId);
    res.json(catalog);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load Codex models' });
  }
});

router.get('/rate-limits', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const rateLimits = await getAgentRateLimitSnapshot(profileId, sessionId);
    res.json({ rateLimits });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load Codex rate limits' });
  }
});

router.get('/folders', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const result = await browseCodexFolders(requestedPath, profileId);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to browse folders' });
  }
});

router.get('/file-tree', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const result = await browseCodexFileTree(requestedPath, profileId);
    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to browse file tree' });
  }
});

router.get('/files/preview', requireCodexAccess, async (req, res) => {
  const rawTarget = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    if (!rawTarget) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const resolution = await resolveCodexFileTarget(rawTarget);
    if (resolution.kind === 'matches') {
      await logFileRouteEvent(req, {
        type: 'file-preview-ambiguous',
        rawTarget,
        status: 409,
        matches: resolution.matches.map((match) => match.path),
        lineNumber: resolution.lineNumber,
      });
      res.status(409).json({
        query: resolution.query,
        lineNumber: resolution.lineNumber,
        matches: resolution.matches,
      });
      return;
    }

    const { file } = resolution;
    const fileSize = Number(file.stats.size);
    if (fileSize > MAX_PREVIEW_FILE_BYTES) {
      await logFileRouteEvent(req, {
        type: 'file-preview-too-large',
        rawTarget,
        resolvedPath: file.resolvedPath,
        status: 413,
        size: fileSize,
        previewKind: file.previewKind,
        mimeType: file.mimeType,
        lineNumber: file.lineNumber,
      });
      res.status(413).json({
        error: `קבצים מעל ${(MAX_PREVIEW_FILE_BYTES / (1024 * 1024)).toFixed(0)}MB לא מוצגים בתצוגה מקדימה.`,
      });
      return;
    }

    const resolvedPathParam = encodeURIComponent(file.resolvedPath);
    const contentUrl = `/api/codex/files/content?path=${resolvedPathParam}`;
    const downloadUrl = `/api/codex/files/download?path=${resolvedPathParam}`;

    await logFileRouteEvent(req, {
      type: 'file-preview-success',
      rawTarget,
      resolvedPath: file.resolvedPath,
      status: 200,
      size: fileSize,
      mimeType: file.mimeType,
      previewKind: file.previewKind,
      lineNumber: file.lineNumber,
    });

    res.json({
      file: {
        path: file.displayPath,
        name: path.basename(file.resolvedPath),
        extension: file.extension,
        size: fileSize,
        lineNumber: file.lineNumber,
        isMarkdown: file.isMarkdown,
        isText: file.isText,
        mimeType: file.mimeType || 'application/octet-stream',
        previewKind: file.previewKind,
        codeLanguage: file.codeLanguage,
        truncated: file.truncated,
        content: file.content,
        downloadUrl,
        contentUrl,
      },
    });
  } catch (error: any) {
    await logFileRouteEvent(req, {
      type: 'file-preview-error',
      rawTarget,
      status: 404,
      message: error.message || 'Failed to preview file',
    });
    res.status(404).json({ error: error.message || 'Failed to preview file' });
  }
});

router.get('/files/download', requireCodexAccess, async (req, res) => {
  const rawTarget = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    if (!rawTarget) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const resolution = await resolveCodexFileTarget(rawTarget);
    if (resolution.kind === 'matches') {
      await logFileRouteEvent(req, {
        type: 'file-download-ambiguous',
        rawTarget,
        status: 409,
        matches: resolution.matches.map((match) => match.path),
        lineNumber: resolution.lineNumber,
      });
      res.status(409).json({
        error: 'נמצאו כמה קבצים. בחר קובץ אחד לפני ההורדה.',
        query: resolution.query,
        lineNumber: resolution.lineNumber,
        matches: resolution.matches,
      });
      return;
    }

    const { file } = resolution;
    const fileSize = Number(file.stats.size);
    await logFileRouteEvent(req, {
      type: 'file-download-success',
      rawTarget,
      resolvedPath: file.resolvedPath,
      status: 200,
      size: fileSize,
      mimeType: file.mimeType,
      previewKind: file.previewKind,
      lineNumber: file.lineNumber,
    });
    res.download(file.resolvedPath, path.basename(file.resolvedPath));
  } catch (error: any) {
    await logFileRouteEvent(req, {
      type: 'file-download-error',
      rawTarget,
      status: 404,
      message: error.message || 'Failed to download file',
    });
    res.status(404).json({ error: error.message || 'Failed to download file' });
  }
});

router.get('/files/content', requireCodexAccess, async (req, res) => {
  const rawTarget = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    if (!rawTarget) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    const resolution = await resolveCodexFileTarget(rawTarget);
    if (resolution.kind === 'matches') {
      await logFileRouteEvent(req, {
        type: 'file-content-ambiguous',
        rawTarget,
        status: 409,
        matches: resolution.matches.map((match) => match.path),
        lineNumber: resolution.lineNumber,
      });
      res.status(409).json({
        error: 'נמצאו כמה קבצים. בחר קובץ אחד לפני התצוגה.',
        query: resolution.query,
        lineNumber: resolution.lineNumber,
        matches: resolution.matches,
      });
      return;
    }

    const { file } = resolution;
    const fileSize = Number(file.stats.size);
    await logFileRouteEvent(req, {
      type: 'file-content-success',
      rawTarget,
      resolvedPath: file.resolvedPath,
      status: 200,
      size: fileSize,
      mimeType: file.mimeType,
      previewKind: file.previewKind,
      lineNumber: file.lineNumber,
    });

    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(file.resolvedPath))}"`);
    if (file.mimeType) {
      res.type(file.mimeType);
    }
    res.sendFile(file.resolvedPath);
  } catch (error: any) {
    await logFileRouteEvent(req, {
      type: 'file-content-error',
      rawTarget,
      status: 404,
      message: error.message || 'Failed to load file content',
    });
    res.status(404).json({ error: error.message || 'Failed to load file content' });
  }
});

router.get('/files/logs', requireCodexAccess, async (req, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const logs = await readRecentCodexFileLogs(limit);
    res.json({ logs });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to read file logs' });
  }
});

router.get('/sessions', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;

    const sessions = await listAgentSessions(profileId, query, limit);
    const hiddenIds = profileId ? await listHiddenSessionIds(profileId) : new Set<string>();
    const topicMap = profileId ? await getSessionTopicMap(profileId) : {};
    const titleMap = profileId ? await getSessionTitleMap(profileId) : {};
    res.json({
      sessions: sessions.map((session) => ({
        ...session,
        title: profileId ? titleMap[session.id] || session.title : session.title,
        hidden: hiddenIds.has(session.id),
        topic: profileId ? topicMap[session.id] || null : null,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load Codex sessions' });
  }
});

router.get('/topics', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : undefined;
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd.trim()
      ? (await resolveCodexFolderPath(req.query.cwd.trim(), profileId)).resolvedPath
      : undefined;

    if (!profileId || !cwd) {
      res.status(400).json({ error: 'Profile id and cwd are required' });
      return;
    }

    const topics = await listSessionTopics(profileId, cwd);
    res.json({ topics });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to load topics' });
  }
});

router.post('/topics', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? (await resolveCodexFolderPath(req.body.cwd.trim(), profileId)).resolvedPath
      : undefined;

    if (!profileId || !cwd) {
      res.status(400).json({ error: 'Profile id and cwd are required' });
      return;
    }

    const topic = await createSessionTopic(profileId, cwd, {
      name: typeof req.body?.name === 'string' ? req.body.name : '',
      icon: typeof req.body?.icon === 'string' ? req.body.icon : '',
      colorKey: typeof req.body?.colorKey === 'string' ? req.body.colorKey : '',
    });

    res.status(201).json({ topic });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create topic' });
  }
});

router.post('/sessions/:sessionId/hide', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const hidden = req.body?.hidden !== false;
    const nextHidden = await setSessionHidden(profileId, sessionId, hidden);
    res.json({
      sessionId,
      profileId,
      hidden: nextHidden,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update session visibility' });
  }
});

router.get('/sessions/:sessionId', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const tail = typeof req.query.tail === 'string'
      ? Number.parseInt(req.query.tail, 10)
      : undefined;
    const before = typeof req.query.before === 'string'
      ? Number.parseInt(req.query.before, 10)
      : undefined;
    const full = req.query.full === '1' || req.query.full === 'true';
    const session = await getAgentSessionDetail(sessionId, profileId, {
      tail: Number.isFinite(tail) ? tail : undefined,
      before: Number.isFinite(before) ? before : undefined,
      full,
    });
    const topicMap = profileId ? await getSessionTopicMap(profileId) : {};
    const titleMap = profileId ? await getSessionTitleMap(profileId) : {};
    res.json({
      session: {
        ...session,
        title: profileId ? titleMap[session.id] || session.title : session.title,
        topic: profileId ? topicMap[session.id] || null : null,
      },
    });
  } catch (error: any) {
    res.status(404).json({ error: error.message || 'Session was not found' });
  }
});

router.get('/sessions/:sessionId/changes/:entryId', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const entryId = readRouteParam(req.params.entryId);
    const profileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : undefined;
    const record = await getAgentSessionChangeRecord(sessionId, entryId, profileId);
    res.json({ record });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session change record' });
  }
});

router.post('/sessions/:sessionId/fork', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const forkEntryId = typeof req.body?.forkEntryId === 'string' && req.body.forkEntryId.trim()
      ? req.body.forkEntryId.trim()
      : undefined;

    if (!profileId || !forkEntryId) {
      res.status(400).json({ error: 'Profile id and fork entry id are required' });
      return;
    }

    const sourceSession = await getAgentSessionDetail(sessionId, profileId, {
      full: true,
    });
    const forkResult = await createAgentForkSession(sourceSession.id, forkEntryId, profileId);
    const forkSidebarMetadata = await copySessionSidebarMetadataToForkSession(
      profileId,
      profileId,
      sourceSession,
      forkResult.sessionId
    );
    await recordForkSessionMetadata({
      sessionId: forkResult.sessionId,
      profileId,
      sourceSessionId: sourceSession.id,
      sourceTitle: sourceSession.title,
      sourceCwd: sourceSession.cwd || null,
      forkEntryId,
      promptPreview: sourceSession.title,
      timeline: [],
      createdAt: new Date().toISOString(),
    });
    const forkSession = await getAgentSessionDetail(forkResult.sessionId, profileId, {
      tail: 120,
    });

    res.status(201).json({
      sessionId: forkResult.sessionId,
      forkedAt: forkResult.forkedAt,
      session: {
        id: forkResult.sessionId,
        title: forkSidebarMetadata.title,
        updatedAt: forkSession.updatedAt,
        createdAt: forkSession.createdAt,
        profileId,
        cwd: forkSession.cwd,
        messageCount: forkSession.messageCount,
        preview: forkSession.preview,
        startPreview: forkSession.startPreview,
        endPreview: forkSession.endPreview,
        path: forkSession.path,
        source: forkSession.source,
        hidden: forkSidebarMetadata.hidden,
        topic: forkSidebarMetadata.topic,
        forkSourceSessionId: sourceSession.id,
        forkEntryId,
      },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create fork session' });
  }
});

router.post('/sessions/:sessionId/transfer', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const targetProfileId = typeof req.body?.targetProfileId === 'string' && req.body.targetProfileId.trim()
      ? req.body.targetProfileId.trim()
      : undefined;
    const transferEntryId = typeof req.body?.transferEntryId === 'string' && req.body.transferEntryId.trim()
      ? req.body.transferEntryId.trim()
      : undefined;
    const clientRequestId = typeof req.body?.clientRequestId === 'string' && req.body.clientRequestId.trim()
      ? req.body.clientRequestId.trim()
      : randomUUID();

    if (!profileId || !targetProfileId || !transferEntryId) {
      res.status(400).json({ error: 'Source profile, target profile and transfer entry id are required' });
      return;
    }

    const sourceProfile = CODEX_APP_CONFIG.profiles.find((profile) => profile.id === profileId);
    const targetProfile = CODEX_APP_CONFIG.profiles.find((profile) => profile.id === targetProfileId);

    if (!sourceProfile || !targetProfile) {
      res.status(404).json({ error: 'אחד הפרופילים שנבחרו לא קיים.' });
      return;
    }

    if (sourceProfile.id === targetProfile.id) {
      res.status(400).json({ error: 'בחר יעד שונה מהפרופיל הנוכחי.' });
      return;
    }

    if (sourceProfile.provider === targetProfile.provider) {
      res.status(400).json({ error: 'בחר יעד מספק אחר.' });
      return;
    }

    const sourceSession = await getAgentSessionDetail(sessionId, profileId, {
      full: true,
    });
    const entryIndex = sourceSession.timeline.findIndex((entry) => entry.id === transferEntryId);

    if (entryIndex === -1) {
      res.status(404).json({ error: 'לא ניתן לאתר את נקודת ההעברה שנבחרה.' });
      return;
    }

    const slicedTimeline = sourceSession.timeline
      .slice(0, entryIndex + 1)
      .map((entry) => ({ ...entry }));
    const selectedEntry = slicedTimeline.at(-1);
    const sourceProviderLabel = getProviderDisplayLabel(sourceProfile.provider);
    const promptPreview = clipTransferText(
      (
        selectedEntry?.entryType === 'message'
        && typeof selectedEntry.text === 'string'
        && selectedEntry.text.trim()
      ) ? selectedEntry.text : sourceSession.title,
      140
    );
    const promptPrefix = buildTransferPromptPrefix(sourceSession, sourceProviderLabel, slicedTimeline);
    const draft = await createForkDraftSession({
      profileId: targetProfile.id,
      sourceSessionId: sourceSession.id,
      sourceTitle: sourceSession.title,
      sourceCwd: sourceSession.cwd || targetProfile.workspaceCwd,
      forkEntryId: transferEntryId,
      transferSourceProvider: sourceProfile.provider,
      transferTargetProvider: targetProfile.provider,
      promptPreview,
      promptPrefix,
      timeline: slicedTimeline,
    });
    const draftSidebarMetadata = await copySessionSidebarMetadataToForkSession(
      profileId,
      targetProfile.id,
      sourceSession,
      draft.sessionId
    );
    const autoPrompt = buildTransferAutoPrompt(selectedEntry);
    const queueItem = await enqueueCodexQueueItem({
      profileId: targetProfile.id,
      queueKey: draft.sessionId,
      clientRequestId,
      sessionId: null,
      cwd: draft.sourceCwd || targetProfile.workspaceCwd,
      prompt: autoPrompt,
      promptPreview,
      contextPrefix: draft.promptPrefix,
      forkContext: {
        sourceSessionId: draft.sourceSessionId,
        sourceTitle: draft.sourceTitle,
        sourceCwd: draft.sourceCwd,
        forkEntryId: draft.forkEntryId,
        transferSourceProvider: draft.transferSourceProvider || null,
        transferTargetProvider: draft.transferTargetProvider || null,
        timeline: draft.timeline,
      },
      attachments: [],
    });
    const transferSession = await getAgentSessionDetail(draft.sessionId, targetProfile.id, {
      tail: 120,
    });

    res.status(201).json({
      sessionId: draft.sessionId,
      targetProfileId: targetProfile.id,
      forkedAt: selectedEntry?.timestamp || draft.updatedAt,
      autoPrompt,
      session: {
        ...transferSession,
        title: draftSidebarMetadata.title,
        hidden: draftSidebarMetadata.hidden,
        topic: draftSidebarMetadata.topic,
      },
      item: queueItem,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to transfer session between providers' });
  }
});

router.post('/sessions/:sessionId/title', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const requestedTitle = typeof req.body?.title === 'string'
      ? req.body.title
      : req.body?.title === null
        ? null
        : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    if (requestedTitle === undefined) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const title = await setSessionCustomTitle(profileId, sessionId, requestedTitle);
    let displayTitle = title;

    if (!displayTitle) {
      const session = await getAgentSessionDetail(sessionId, profileId, {
        tail: 1,
      });
      displayTitle = session.title;
    }

    res.json({
      sessionId,
      profileId,
      title,
      displayTitle,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update session title' });
  }
});

router.post('/sessions/:sessionId/topic', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const topicId = typeof req.body?.topicId === 'string' && req.body.topicId.trim()
      ? req.body.topicId.trim()
      : null;
    const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const topic = await setSessionTopic(profileId, sessionId, topicId, cwd);
    res.json({
      sessionId,
      profileId,
      topic,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update session topic' });
  }
});

router.get('/queue/items', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const items = await listCodexQueueItems(profileId);
    res.json({ items });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load Codex queue' });
  }
});

router.get('/queue/items/:itemId', requireCodexAccess, async (req, res) => {
  try {
    const itemId = readRouteParam(req.params.itemId);
    const item = await getCodexQueueItem(itemId);
    if (!item) {
      res.status(404).json({ error: 'Queue item was not found' });
      return;
    }

    const session = await getCodexQueueItemSession(itemId);
    res.json({ item, session });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load queue item' });
  }
});

router.get('/session-instruction', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const sessionKey = typeof req.query.sessionKey === 'string' && req.query.sessionKey.trim()
      ? req.query.sessionKey.trim()
      : undefined;

    if (!profileId || !sessionKey) {
      res.status(400).json({ error: 'Profile id and session key are required' });
      return;
    }

    const instruction = await getSessionInstruction(profileId, sessionKey);
    res.json({ instruction });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session instruction' });
  }
});

router.post('/session-instruction', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sessionKey = typeof req.body?.sessionKey === 'string' && req.body.sessionKey.trim()
      ? req.body.sessionKey.trim()
      : undefined;
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction : null;

    if (!profileId || !sessionKey) {
      res.status(400).json({ error: 'Profile id and session key are required' });
      return;
    }

    const savedInstruction = await setSessionInstruction(profileId, sessionKey, instruction);
    res.json({ instruction: savedInstruction });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update session instruction' });
  }
});

router.post('/queue/items', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const profileId = requestedProfileId || 'developer';
    const queueKey = typeof req.body?.queueKey === 'string' && req.body.queueKey.trim()
      ? req.body.queueKey.trim()
      : randomUUID();
    const clientRequestId = typeof req.body?.clientRequestId === 'string' && req.body.clientRequestId.trim()
      ? req.body.clientRequestId.trim()
      : undefined;
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const promptPreview = typeof req.body?.promptPreview === 'string' ? req.body.promptPreview : undefined;
    const contextPrefix = typeof req.body?.contextPrefix === 'string' ? req.body.contextPrefix : undefined;
    const sessionInstruction = typeof req.body?.sessionInstruction === 'string' ? req.body.sessionInstruction : undefined;
    const forkContext = req.body?.forkContext;
    const scheduledAt = typeof req.body?.scheduledAt === 'string' && req.body.scheduledAt.trim()
      ? req.body.scheduledAt.trim()
      : undefined;
    const recurrence = readRecurringConfig(req.body);
    const cwd = requestedCwd
      ? (await resolveCodexFolderPath(requestedCwd, profileId)).resolvedPath
      : undefined;
    const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
      .map((attachment: any): CodexUploadedAttachment | null => {
        const attachmentPath = typeof attachment?.path === 'string'
          ? path.resolve(attachment.path)
          : '';

        if (!attachmentPath || !isPathInside(CODEX_UPLOAD_ROOT, attachmentPath)) {
          return null;
        }

        return {
          id: typeof attachment?.id === 'string' ? attachment.id : randomUUID(),
          name: typeof attachment?.name === 'string' ? attachment.name : path.basename(attachmentPath),
          mimeType: typeof attachment?.mimeType === 'string'
            ? attachment.mimeType
            : 'application/octet-stream',
          size: typeof attachment?.size === 'number' ? attachment.size : 0,
          path: attachmentPath,
          isImage: typeof attachment?.isImage === 'boolean'
            ? attachment.isImage
            : false,
        };
      })
      .filter((attachment: CodexUploadedAttachment | null): attachment is CodexUploadedAttachment => Boolean(attachment));

    const isDraftTarget = isDraftSessionKey(sessionId) || isDraftSessionKey(queueKey);
    const hydratedForkDraft = isDraftTarget
      ? await hydrateForkDraftRequest(
        profileId,
        queueKey,
        sessionId,
        contextPrefix,
        forkContext
      )
      : {
        contextPrefix: undefined,
        forkContext: undefined,
      };

    const item = await enqueueCodexQueueItem({
      profileId,
      queueKey,
      clientRequestId,
      sessionId,
      cwd,
      prompt,
      promptPreview,
      contextPrefix: hydratedForkDraft.contextPrefix,
      sessionInstruction,
      forkContext: hydratedForkDraft.forkContext,
      scheduledAt,
      attachments,
      recurrence,
    });

    res.status(202).json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to enqueue Codex task' });
  }
});

router.post('/queue/items/:itemId/cancel', requireCodexAccess, async (req, res) => {
  try {
    const item = await cancelCodexQueueItem(readRouteParam(req.params.itemId));
    res.json({ item });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to cancel queue item' });
  }
});

router.post('/queue/items/:itemId/retry', requireCodexAccess, async (req, res) => {
  try {
    const itemId = readRouteParam(req.params.itemId);
    const scheduledAt = typeof req.body?.scheduledAt === 'string' && req.body.scheduledAt.trim()
      ? req.body.scheduledAt.trim()
      : undefined;
    const item = await retryCodexQueueItem(itemId, scheduledAt);
    res.json({ item });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to retry queue item' });
  }
});

router.delete('/queue/items/:itemId', requireCodexAccess, async (req, res) => {
  try {
    await deleteCodexQueueItem(readRouteParam(req.params.itemId));
    res.status(204).end();
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete queue item' });
  }
});

router.get('/jobs/:jobId', requireCodexAccess, async (req, res) => {
  const jobId = readRouteParam(req.params.jobId);
  const job = await getCodexQueueItem(jobId);

  if (!job) {
    res.status(404).json({ error: 'Codex job was not found' });
    return;
  }

  const session = await getCodexQueueItemSession(jobId);

  res.json({ job, session });
});

router.post('/ask', requireCodexAccess, async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const profileId = requestedProfileId || 'developer';
    const asyncRequested = req.headers['x-codex-async'] === '1' || req.body?.async === true;
    const queueKey = typeof req.body?.queueKey === 'string' && req.body.queueKey.trim()
      ? req.body.queueKey.trim()
      : undefined;
    const clientRequestId = typeof req.body?.clientRequestId === 'string' && req.body.clientRequestId.trim()
      ? req.body.clientRequestId.trim()
      : undefined;
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const promptPreview = typeof req.body?.promptPreview === 'string' ? req.body.promptPreview : undefined;
    const contextPrefix = typeof req.body?.contextPrefix === 'string' ? req.body.contextPrefix : undefined;
    const sessionInstruction = typeof req.body?.sessionInstruction === 'string' ? req.body.sessionInstruction : undefined;
    const forkContext = req.body?.forkContext;
    const executionConfig = readExecutionConfig(req.body);
    const recurrence = readRecurringConfig(req.body);
    const cwd = requestedCwd
      ? (await resolveCodexFolderPath(requestedCwd, profileId)).resolvedPath
      : undefined;
    const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
      .map((attachment: any): CodexUploadedAttachment | null => {
        const attachmentPath = typeof attachment?.path === 'string'
          ? path.resolve(attachment.path)
          : '';

        if (!attachmentPath || !isPathInside(CODEX_UPLOAD_ROOT, attachmentPath)) {
          return null;
        }

        return {
          id: typeof attachment?.id === 'string' ? attachment.id : randomUUID(),
          name: typeof attachment?.name === 'string' ? attachment.name : path.basename(attachmentPath),
          mimeType: typeof attachment?.mimeType === 'string'
            ? attachment.mimeType
            : 'application/octet-stream',
          size: typeof attachment?.size === 'number' ? attachment.size : 0,
          path: attachmentPath,
          isImage: typeof attachment?.isImage === 'boolean'
            ? attachment.isImage
            : false,
        };
      })
      .filter((attachment: CodexUploadedAttachment | null): attachment is CodexUploadedAttachment => Boolean(attachment));

    const isDraftTarget = isDraftSessionKey(sessionId) || isDraftSessionKey(queueKey);
    const hydratedForkDraft = isDraftTarget
      ? await hydrateForkDraftRequest(
        profileId,
        queueKey,
        sessionId,
        contextPrefix,
        forkContext
      )
      : {
        contextPrefix: undefined,
        forkContext: undefined,
      };
    const promptWithForkContext = hydratedForkDraft.contextPrefix?.trim()
      ? `${hydratedForkDraft.contextPrefix.trim()}\n\nהודעת ההמשך החדשה:\n${prompt}`
      : prompt;
    const effectivePrompt = sessionInstruction?.trim()
      ? `${promptWithForkContext}\n\nהוראה קבועה לסשן זה. יש ליישם אותה גם אם המשתמש לא חזר עליה בהודעה הנוכחית:\n${sessionInstruction.trim()}`
      : promptWithForkContext;

    if (!asyncRequested) {
      const result = await runAgentPrompt(effectivePrompt, sessionId, profileId, attachments, {
        cwd,
        injectDirectoryContext: !sessionId,
        executionConfig,
      });
      const session = await getAgentSessionDetail(result.sessionId, profileId);

      res.json({
        session,
        finalMessage: result.finalMessage,
      });
      return;
    }

    const item = await enqueueCodexQueueItem({
      profileId,
      queueKey: queueKey || sessionId || randomUUID(),
      clientRequestId,
      sessionId,
      cwd,
      model: executionConfig.model,
      reasoningEffort: executionConfig.reasoningEffort,
      prompt,
      promptPreview,
      contextPrefix: hydratedForkDraft.contextPrefix,
      sessionInstruction,
      forkContext: hydratedForkDraft.forkContext,
      attachments,
      recurrence,
    });

    res.status(202).json({ job: item });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Codex request failed' });
  }
});

export default router;
