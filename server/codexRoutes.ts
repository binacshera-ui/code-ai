import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import type { AppMode, AppProvider } from './config.js';
import {
  CodexExecutionConfig,
  CodexSessionDetail,
  CodexSessionSummary,
  CodexUploadedAttachment,
  CODEX_UPLOAD_ROOT,
} from './codexService.js';
import {
  createAgentForkSession,
  deleteAgentTurn,
  deleteAgentSession,
  getAgentSessionChangeRecord,
  getAgentModelCatalog,
  getAgentRateLimitSnapshot,
  getAgentSessionDetail,
  getAvailableProfiles,
  listAgentSessions,
  runAgentPrompt,
  updateAgentPermissionMode,
  updateAgentResponseSpeed,
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
import { deleteSessionVisibility } from './codexSessionVisibility.js';
import {
  createSessionTopic,
  deleteSessionTopic,
  deleteSessionTopicAssignment,
  getSessionTopicMap,
  listTopicAssignmentSessionIds,
  listSessionTopics,
  setSessionTopic,
} from './codexSessionTopics.js';
import { deleteSessionCustomTitle, getSessionTitleMap, setSessionCustomTitle } from './codexSessionTitles.js';
import {
  deleteSessionInstruction,
  getSessionInstruction,
  rebindSessionInstruction,
  setSessionInstruction,
} from './codexSessionInstructions.js';
import {
  createForkDraftSession,
  deleteForkDraftSession,
  deleteForkSessionMetadata,
  getForkDraftSession,
  recordForkSessionMetadata,
  updateForkDraftSession,
} from './codexForkSessions.js';
import { createProjectAnchor, deleteProjectAnchor, listProjectAnchors } from './codexProjectAnchors.js';
import {
  approveAgentSession,
  buildAgentExecutionPrompt,
  buildAgentPlanPrompt,
  createAgentSessionDraft,
  getAgentSessionLinkForSession,
  getAgentSessionRecord,
  listAgentSessionLinksForSourceProfile,
  listAgentSessionRecords,
  markAgentSessionLaunched,
  recordAgentSessionLinkedSession,
  resolveAgentProviderProfileId,
  saveAgentSessionPlan,
  updateAgentRuntimeStatus,
  updateAgentSessionGoal,
  type AgentSessionAgentPlan,
  type AgentSessionLinkRecord,
  type AgentSessionRecord,
} from './codexAgentSessions.js';
import {
  deleteSessionContextSelection,
  getSessionContextSelection,
  rebindSessionContextSelection,
  setSessionContextSelection,
} from './codexSessionContextSelections.js';
import {
  copySessionReminders,
  createSessionReminder,
  deleteSessionReminder,
  deleteSessionReminders,
  listSessionReminders,
  rebindSessionReminders,
} from './codexSessionReminders.js';
import {
  createSessionTask,
  deleteSessionTask,
  listSessionTasks,
  removeSessionFromTasks,
  setTaskSessionAssignment,
  setTaskSessionCompletion,
  updateSessionTask,
} from './codexSessionTasks.js';
import {
  createSessionSubtask,
  deleteSessionSubtask,
  listSessionSubtasks,
  removeSessionSubtasks,
  setSessionSubtaskCompletion,
} from './codexSessionSubtasks.js';
import { buildSessionPromptAdditionsContext } from './sessionPromptAdditions.js';
import { listUnifiedSkills } from './skillCatalogService.js';
import { getSelectedPermissionModeId } from './providerPermissions.js';
import {
  buildSupportPromptEnvelope,
  deleteSupportSessionRecord,
  decorateSupportSessionDetail,
  decorateSupportSessionSummary,
  filterProfilesByMode,
  isSupportProfile,
  normalizeSupportSessionForOperations,
  recordSupportTurnRequest,
  rebindSupportSessionRecord,
  resolveDefaultProfileForMode,
  resolveSupportProfileSelection,
  type SupportPromptEnvelope,
} from './supportAgentService.js';
import { deleteSessionChangeRecords } from './sessionChangeTracker.js';

const router = Router();
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const MAX_UPLOAD_FILES = 8;
const RECURRING_FREQUENCIES = new Set(['daily', 'weekly']);
const CODEX_CLIENT_LOG_ROOT = path.dirname(CLIENT_CRASH_LOG);
const CODEX_CLIENT_LOG_FILE = CLIENT_CRASH_LOG;
const DEVICE_UNLOCK_COOKIE = 'code_ai_device_unlock';
const FORUM_SESSION_COOKIE = 'forum.session';
const SUPPORT_WEBHOOK_TOKEN = process.env.CODEX_SUPPORT_WEBHOOK_TOKEN?.trim() || '';

function nowIso(): string {
  return new Date().toISOString();
}

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

function requireSupportWebhookAccess(req: Request, res: Response, next: NextFunction) {
  if (SUPPORT_WEBHOOK_TOKEN) {
    const incoming = typeof req.headers['x-code-ai-support-token'] === 'string'
      ? req.headers['x-code-ai-support-token']
      : Array.isArray(req.headers['x-code-ai-support-token'])
        ? req.headers['x-code-ai-support-token'][0]
        : '';

    if (incoming === SUPPORT_WEBHOOK_TOKEN) {
      next();
      return;
    }

    res.status(401).json({ error: 'Support webhook token is invalid' });
    return;
  }

  requireCodexAccess(req, res, next);
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
  const permissionModeId = typeof body?.permissionModeId === 'string' && body.permissionModeId.trim()
    ? body.permissionModeId.trim()
    : null;

  return {
    model,
    reasoningEffort,
    permissionModeId,
  };
}

type SupportExecutionLevel = 'fast' | 'balanced' | 'deep';

function readSupportExecutionLevel(value: unknown): SupportExecutionLevel | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'balanced' || normalized === 'deep') {
    return normalized;
  }

  return null;
}

function resolveSupportExecutionConfig(
  provider: AppProvider,
  requestedLevel: SupportExecutionLevel | null,
  explicitConfig: CodexExecutionConfig
): {
  level: SupportExecutionLevel;
  executionConfig: CodexExecutionConfig;
} {
  const level = requestedLevel || 'balanced';

  const presetByProvider: Record<AppProvider, Record<SupportExecutionLevel, { model: string; reasoningEffort: string }>> = {
    codex: {
      fast: { model: 'gpt-5.4-mini', reasoningEffort: 'low' },
      balanced: { model: 'gpt-5.4', reasoningEffort: 'medium' },
      deep: { model: 'gpt-5.5', reasoningEffort: 'xhigh' },
    },
    claude: {
      fast: { model: 'claude-sonnet-4-6', reasoningEffort: 'low' },
      balanced: { model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
      deep: { model: 'claude-opus-4-6', reasoningEffort: 'max' },
    },
    gemini: {
      fast: { model: 'gemini-2.5-flash-lite', reasoningEffort: 'low' },
      balanced: { model: 'gemini-2.5-flash', reasoningEffort: 'medium' },
      deep: { model: 'gemini-2.5-pro', reasoningEffort: 'high' },
    },
  };

  const preset = presetByProvider[provider][level];

  return {
    level,
    executionConfig: {
      model: explicitConfig.model || preset.model,
      reasoningEffort: explicitConfig.reasoningEffort || preset.reasoningEffort,
      permissionModeId: explicitConfig.permissionModeId || null,
    },
  };
}

function readRequestedMode(value: unknown): AppMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim() === 'support' ? 'support' : value.trim() === 'standard' ? 'standard' : undefined;
}

function findConfiguredProfile(profileId: string | undefined) {
  return CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profileId) || null;
}

function resolveVisibleSourceProfile(profileId: string | undefined) {
  const configuredProfile = findConfiguredProfile(profileId);
  if (!configuredProfile) {
    return null;
  }

  if (configuredProfile.mode === 'standard' || !configuredProfile.sourceProfileId) {
    return configuredProfile;
  }

  return findConfiguredProfile(configuredProfile.sourceProfileId);
}

function buildAgentSessionMeta(
  record: AgentSessionRecord,
  link: AgentSessionLinkRecord
): CodexSessionSummary['agentSession'] {
  const linkedAgent = link.agentId
    ? record.plan?.agents.find((agent) => agent.id === link.agentId) || null
    : null;

  return {
    id: record.id,
    title: record.title,
    goal: record.goal,
    status: record.status,
    kind: link.kind,
    sourceProfileId: record.sourceProfileId,
    linkedProfileId: link.profileId,
    plannerProvider: record.plannerProvider || null,
    topicId: record.topicId,
    agentId: link.agentId,
    agentName: linkedAgent?.name || null,
    approvedAt: record.approvedAt,
    launchedAt: record.launchedAt,
    plannerSessionId: record.plannerSessionId,
    sharedStatusPath: record.plan?.sharedStatusPath || record.sharedStatusPath || null,
    eventsPath: record.plan?.eventsPath || record.eventsPath || null,
    plan: record.plan ? {
      title: record.plan.title,
      goal: record.plan.goal,
      sharedStatusPath: record.plan.sharedStatusPath,
      eventsPath: record.plan.eventsPath,
      coordinationRules: [...record.plan.coordinationRules],
      agents: record.plan.agents.map((agent) => ({
        ...agent,
        scopePaths: [...agent.scopePaths],
        dependsOn: [...agent.dependsOn],
        runtimeStatus: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.runtimeStatus || null,
        linkedSessionId: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.linkedSessionId || null,
        queueItemId: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.queueItemId || null,
        updatedAt: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.updatedAt || null,
        lastMessage: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.lastMessage || null,
        lastError: record.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.lastError || null,
      })),
    } : null,
  };
}

async function resolveEffectiveProfileIdForSession(
  requestedProfileId: string | undefined,
  sessionId: string
): Promise<string | undefined> {
  const linked = await getAgentSessionLinkForSession(sessionId);
  if (!linked) {
    return requestedProfileId;
  }

  return linked.profileId;
}

async function loadAgentLinkedSessionSummaries(
  sourceProfileId: string,
  query: string,
  limit?: number
): Promise<CodexSessionSummary[]> {
  const links = await listAgentSessionLinksForSourceProfile(sourceProfileId);
  if (links.length === 0) {
    return [];
  }

  const profileIds = [...new Set(links.map((link) => link.profileId))];
  const linkedIds = new Set(links.map((link) => link.sessionId));
  const linksBySessionId = new Map(links.map((link) => [link.sessionId, link]));
  const recordsById = new Map<string, AgentSessionRecord>();
  const agentSessionIds = [...new Set(links.map((link) => link.agentSessionId))];
  await Promise.all(agentSessionIds.map(async (agentSessionId) => {
    const record = await getAgentSessionRecord(agentSessionId);
    if (record) {
      recordsById.set(agentSessionId, record);
    }
  }));

  const results = await Promise.all(profileIds.map(async (profileId) => (
    listAgentSessions(profileId, query, limit ? Math.max(limit * 4, 80) : 160)
  )));

  return results
    .flat()
    .filter((session) => linkedIds.has(session.id))
    .map((session) => {
      const link = linksBySessionId.get(session.id);
      const record = link ? recordsById.get(link.agentSessionId) || null : null;
      return {
        ...session,
        profileId: sourceProfileId,
        agentSession: link && record ? buildAgentSessionMeta(record, link) : null,
      };
    });
}

async function decorateSessionSummaryListForClient(
  profileId: string | undefined,
  sessions: CodexSessionSummary[]
) {
  if (!profileId) {
    return sessions;
  }

  const profile = findConfiguredProfile(profileId);
  const links = await listAgentSessionLinksForSourceProfile(profileId);
  const recordsById = new Map<string, AgentSessionRecord>();
  await Promise.all([...new Set(links.map((link) => link.agentSessionId))].map(async (agentSessionId) => {
    const record = await getAgentSessionRecord(agentSessionId);
    if (record) {
      recordsById.set(agentSessionId, record);
    }
  }));
  const linksBySessionId = new Map(links.map((link) => [link.sessionId, link]));
  const enriched = sessions.map((session) => {
    const link = linksBySessionId.get(session.id);
    const record = link ? recordsById.get(link.agentSessionId) || null : null;
    return {
      ...session,
      agentSession: link && record ? buildAgentSessionMeta(record, link) : null,
    };
  });

  if (!profile || !isSupportProfile(profile)) {
    return enriched;
  }

  return Promise.all(enriched.map((session) => decorateSupportSessionSummary(profile, session)));
}

async function decorateSessionDetailForClient(
  profileId: string | undefined,
  session: CodexSessionDetail
) {
  if (!profileId) {
    return session;
  }

  const linked = await getAgentSessionLinkForSession(session.id);
  const linkedRecord = linked ? await getAgentSessionRecord(linked.agentSessionId) : null;
  const enriched = {
    ...session,
    agentSession: linked && linkedRecord ? buildAgentSessionMeta(linkedRecord, linked) : null,
  };

  const profile = findConfiguredProfile(profileId);
  if (!profile || !isSupportProfile(profile)) {
    return enriched;
  }

  return decorateSupportSessionDetail(profile, enriched);
}

async function normalizeSessionDetailForOperations(
  profileId: string | undefined,
  session: CodexSessionDetail
) {
  if (!profileId) {
    return session;
  }

  const profile = findConfiguredProfile(profileId);
  if (!profile || !isSupportProfile(profile)) {
    return session;
  }

  return normalizeSupportSessionForOperations(profile, session);
}

function buildSupportSessionInstruction(
  baseInstruction: string | undefined,
  supportEnvelope: SupportPromptEnvelope | null
): string | undefined {
  const sections = [
    supportEnvelope?.compiledPrompt?.trim() || '',
    typeof baseInstruction === 'string' ? baseInstruction.trim() : '',
  ].filter(Boolean);

  if (sections.length === 0) {
    return undefined;
  }

  return sections.join('\n\n');
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

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('was not found');
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

async function copySessionContextSelectionToSession(
  sourceProfileId: string,
  targetProfileId: string,
  sourceSessionId: string,
  targetSessionId: string
) {
  const selection = await getSessionContextSelection(sourceProfileId, sourceSessionId);
  if (
    selection.anchorIds.length === 0
    && selection.skillIds.length === 0
    && selection.reminderIds.length === 0
    && !selection.agentSessionDraftId
    && !selection.professionalMode
  ) {
    return;
  }

  await setSessionContextSelection(targetProfileId, targetSessionId, selection);
}

async function copySessionRemindersToSession(
  sourceProfileId: string,
  targetProfileId: string,
  sourceSessionId: string,
  targetSessionId: string
) {
  await copySessionReminders(sourceProfileId, sourceSessionId, targetProfileId, targetSessionId);
}

async function deleteSessionMetadata(profileId: string, sessionId: string) {
  await Promise.all([
    deleteSessionVisibility(profileId, sessionId),
    deleteSessionTopicAssignment(profileId, sessionId),
    deleteSessionCustomTitle(profileId, sessionId),
    deleteSessionInstruction(profileId, sessionId),
    deleteSessionContextSelection(profileId, sessionId),
    deleteSessionReminders(profileId, sessionId),
    deleteForkSessionMetadata(sessionId),
    deleteSupportSessionRecord(profileId, sessionId),
    deleteSessionChangeRecords(sessionId),
  ]);
}

async function deleteSessionPermanently(profileId: string, sessionId: string) {
  if (isDraftSessionKey(sessionId)) {
    await deleteForkDraftSession(sessionId);
    await deleteSessionMetadata(profileId, sessionId);
    await removeSessionFromTasks(profileId, sessionId);
    await removeSessionSubtasks(profileId, sessionId);
    return {
      deleted: true,
      sessionId,
      profileId,
      draft: true,
    };
  }

  try {
    await deleteAgentSession(sessionId, profileId);
  } catch (error) {
    if (!isMissingSessionError(error)) {
      throw error;
    }
  }

  await deleteSessionMetadata(profileId, sessionId);
  await removeSessionFromTasks(profileId, sessionId);
  await removeSessionSubtasks(profileId, sessionId);
  return {
    deleted: true,
    sessionId,
    profileId,
    draft: false,
  };
}

interface ProfessionalModeQueueSpec {
  prompt: string;
  promptPreview: string;
}

function buildProfessionalModeQueueSpecs(goal: string): ProfessionalModeQueueSpec[] {
  const trimmedGoal = goal.trim();
  return [
    {
      prompt: [
        `עליך לתכנן היטב מקצה לקצה את "${trimmedGoal}".`,
        'חשוב קודם למפות את המטרה, התלויות, הסיכונים, שלבי העבודה, ומה הסדר המקצועי הנכון לביצוע.',
        'אל תישאר ברמת דיבור כללית; כתוב תכנון מעשי ומדויק ואז עבור לביצוע הצעד הראשון שבאמת מקדם את המשימה.',
      ].join('\n\n'),
      promptPreview: `מצב מקצועי · תכנון · ${trimmedGoal}`,
    },
    {
      prompt: [
        `כעת בצע על מלא ובצורה מקצועית את "${trimmedGoal}".`,
        'הסתמך על התכנון שכבר נבנה בשיחה, עבוד מקצה לקצה, אל תעצור באמצע, ועדכן באופן ברור מה בוצע בפועל ומה נשאר אם יש חסם אמיתי.',
      ].join('\n\n'),
      promptPreview: `מצב מקצועי · ביצוע · ${trimmedGoal}`,
    },
    {
      prompt: [
        `בדוק כעת מקצה לקצה את "${trimmedGoal}".`,
        'בצע בדיקת עומק מקצועית לתוצאה שכבר הופקה: מה תקין, מה חסר, מה מסוכן, ומה עדיין דורש תיקון או אימות נוסף.',
        'אם אתה מגלה פער, דווח עליו בצורה ישירה וברורה.',
      ].join('\n\n'),
      promptPreview: `מצב מקצועי · בדיקה · ${trimmedGoal}`,
    },
  ];
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

function readAppProvider(value: unknown): AppProvider | null {
  if (value === 'codex' || value === 'claude' || value === 'gemini') {
    return value;
  }
  return null;
}

async function readAgentPlanJsonFromDisk(record: AgentSessionRecord): Promise<unknown> {
  const raw = await fs.readFile(record.planPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`תכנית הסוכנים נכתבה אבל אינה JSON תקין: ${error?.message || 'Invalid JSON'}`);
  }
}

function assertAgentSessionAccess(record: AgentSessionRecord, sourceProfileId: string) {
  if (record.sourceProfileId !== sourceProfileId) {
    throw new Error('סשן הסוכנים המבוקש לא שייך לפרופיל הפעיל.');
  }
}

function isUserTimelineMessage(entry: CodexSessionDetail['timeline'][number] | undefined): boolean {
  return Boolean(entry && entry.entryType === 'message' && entry.role === 'user');
}

function isAssistantFinalTimelineMessage(entry: CodexSessionDetail['timeline'][number] | undefined): boolean {
  return Boolean(entry && entry.entryType === 'message' && entry.role === 'assistant' && entry.kind === 'final');
}

function resolveDeletedTurnRange(
  timeline: CodexSessionDetail['timeline'],
  selectedEntryId: string
): {
  startIndex: number;
  endExclusive: number;
  selectedEntry: CodexSessionDetail['timeline'][number];
  turnEntries: CodexSessionDetail['timeline'];
  deletedUserEntryId: string;
  deletedAssistantEntryId: string | null;
} {
  const selectedIndex = timeline.findIndex((entry) => entry.id === selectedEntryId);
  if (selectedIndex === -1) {
    throw new Error('לא ניתן לאתר את זוג ההודעות שנבחר למחיקה.');
  }

  const selectedEntry = timeline[selectedIndex]!;
  let startIndex = selectedIndex;

  if (!isUserTimelineMessage(selectedEntry)) {
    startIndex = -1;
    for (let index = selectedIndex; index >= 0; index -= 1) {
      if (isUserTimelineMessage(timeline[index])) {
        startIndex = index;
        break;
      }
    }
  }

  if (startIndex < 0 || !isUserTimelineMessage(timeline[startIndex])) {
    throw new Error('אפשר למחוק רק זוג שמתחיל בהודעת משתמש.');
  }

  let endExclusive = timeline.length;
  for (let index = startIndex + 1; index < timeline.length; index += 1) {
    if (isUserTimelineMessage(timeline[index])) {
      endExclusive = index;
      break;
    }
  }

  const turnEntries = timeline.slice(startIndex, endExclusive).map((entry) => ({ ...entry }));
  const deletedAssistantEntry = [...turnEntries].reverse().find((entry) => isAssistantFinalTimelineMessage(entry)) || null;

  return {
    startIndex,
    endExclusive,
    selectedEntry,
    turnEntries,
    deletedUserEntryId: timeline[startIndex]!.id,
    deletedAssistantEntryId: deletedAssistantEntry?.id || null,
  };
}

function buildDeletedTurnPromptPrefix(
  sourceSession: CodexSessionDetail,
  sourceProviderLabel: string,
  timeline: CodexSessionDetail['timeline']
): string {
  if (timeline.length === 0) {
    return [
      `הקשר משוחזר מתוך שיחה קיימת עם ${sourceProviderLabel}, אחרי מחיקת הודעות מהשיחה.`,
      sourceSession.cwd ? `התיקייה הפעילה: ${sourceSession.cwd}` : '',
      'אין כרגע היסטוריה קודמת תקפה בתוך השיחה. המשך מכאן רק לפי ההודעה החדשה שתגיע אחר כך.',
    ].filter(Boolean).join('\n\n');
  }

  const transcript = timeline
    .map((entry) => renderTransferTimelineEntry(entry, sourceProviderLabel))
    .filter((value): value is string => Boolean(value))
    .join('\n\n');

  return [
    `הקשר משוחזר מתוך שיחה קיימת עם ${sourceProviderLabel}, אחרי מחיקת הודעות מהשיחה.`,
    `כותרת השיחה: ${sourceSession.title}`,
    sourceSession.cwd ? `התיקייה הפעילה: ${sourceSession.cwd}` : '',
    'להלן ההיסטוריה התקפה היחידה של השיחה, לפי סדר כרונולוגי:',
    transcript,
    'הודעות שנמחקו אינן חלק מהשיחה יותר. אסור להתייחס אליהן, לצטט אותן, או להמשיך מהן. המשך רק מההיסטוריה התקפה למעלה ומההודעה החדשה שתגיע אחר כך.',
  ].filter(Boolean).join('\n\n');
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
    const mode = readRequestedMode((_req as any).query?.mode);
    const allProfiles = await getAvailableProfiles();
    const profiles = mode ? filterProfilesByMode(allProfiles, mode) : allProfiles;
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

router.post('/permissions', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const modeId = typeof req.body?.modeId === 'string' ? req.body.modeId.trim() : '';
    if (!modeId) {
      res.status(400).json({ error: 'Permission mode is required' });
      return;
    }

    const permissions = await updateAgentPermissionMode(profileId, modeId);
    res.json({ permissions });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update permission mode' });
  }
});

router.post('/response-speed', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const modeId = typeof req.body?.modeId === 'string' ? req.body.modeId.trim() : '';
    if (!modeId) {
      res.status(400).json({ error: 'Response speed mode is required' });
      return;
    }

    const catalog = await updateAgentResponseSpeed(profileId, modeId);
    res.json(catalog);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update response speed' });
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

    const primarySessions = await listAgentSessions(profileId, query, limit);
    const linkedSessions = profileId ? await loadAgentLinkedSessionSummaries(profileId, query, limit) : [];
    const mergedSessionMap = new Map<string, CodexSessionSummary>();
    for (const session of [...primarySessions, ...linkedSessions]) {
      mergedSessionMap.set(session.id, session);
    }
    const sessions = await decorateSessionSummaryListForClient(
      profileId,
      [...mergedSessionMap.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    );
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

router.delete('/topics/:topicId', requireCodexAccess, async (req, res) => {
  try {
    const topicId = readRouteParam(req.params.topicId);
    const profileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : typeof req.body?.profileId === 'string' && req.body.profileId.trim()
        ? req.body.profileId.trim()
        : undefined;
    const deleteSessions = req.query.deleteSessions === 'true' || req.body?.deleteSessions === true;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const affectedSessionIds = await listTopicAssignmentSessionIds(profileId, topicId);
    const deletion = await deleteSessionTopic(profileId, topicId);

    if (deleteSessions) {
      for (const sessionId of affectedSessionIds) {
        await deleteSessionPermanently(profileId, sessionId);
      }
    }

    res.json({
      deleted: true,
      profileId,
      topic: deletion.topic,
      affectedSessionIds,
      deletedSessions: deleteSessions,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete topic' });
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

router.delete('/sessions/:sessionId', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const requestedProfileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : typeof req.body?.profileId === 'string' && req.body.profileId.trim()
        ? req.body.profileId.trim()
        : undefined;
    const profileId = await resolveEffectiveProfileIdForSession(requestedProfileId, sessionId);

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }
    res.json(await deleteSessionPermanently(requestedProfileId || profileId, sessionId));
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete session permanently' });
  }
});

router.get('/sessions/:sessionId', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const requestedProfileId = typeof req.query.profile === 'string' ? req.query.profile : undefined;
    const profileId = await resolveEffectiveProfileIdForSession(requestedProfileId, sessionId);
    const tail = typeof req.query.tail === 'string'
      ? Number.parseInt(req.query.tail, 10)
      : undefined;
    const before = typeof req.query.before === 'string'
      ? Number.parseInt(req.query.before, 10)
      : undefined;
    const full = req.query.full === '1' || req.query.full === 'true';
    const session = await decorateSessionDetailForClient(
      profileId,
      await getAgentSessionDetail(sessionId, profileId, {
        tail: Number.isFinite(tail) ? tail : undefined,
        before: Number.isFinite(before) ? before : undefined,
        full,
      })
    );
    const visibleProfileId = requestedProfileId || profileId;
    const topicMap = visibleProfileId ? await getSessionTopicMap(visibleProfileId) : {};
    const titleMap = visibleProfileId ? await getSessionTitleMap(visibleProfileId) : {};
    res.json({
      session: {
        ...session,
        profileId: visibleProfileId || session.profileId,
        title: visibleProfileId ? titleMap[session.id] || session.title : session.title,
        topic: session.agentSession?.topicId
          ? Object.values(topicMap).find((topic) => topic.id === session.agentSession?.topicId) || null
          : visibleProfileId ? topicMap[session.id] || null : null,
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
    const requestedProfileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim()
      : undefined;
    const profileId = await resolveEffectiveProfileIdForSession(requestedProfileId, sessionId);
    const record = await getAgentSessionChangeRecord(sessionId, entryId, profileId);
    res.json({ record });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session change record' });
  }
});

router.post('/sessions/:sessionId/delete-turn', requireCodexAccess, async (req, res) => {
  try {
    const sessionId = readRouteParam(req.params.sessionId);
    const requestedProfileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const profileId = await resolveEffectiveProfileIdForSession(requestedProfileId, sessionId);
    const entryId = typeof req.body?.entryId === 'string' && req.body.entryId.trim()
      ? req.body.entryId.trim()
      : undefined;

    if (!profileId || !entryId) {
      res.status(400).json({ error: 'Profile id and entry id are required' });
      return;
    }

    const profile = CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      res.status(404).json({ error: 'הפרופיל שנבחר לא קיים.' });
      return;
    }

    const sourceSession = await normalizeSessionDetailForOperations(
      profileId,
      await getAgentSessionDetail(sessionId, profileId, {
        full: true,
      })
    );
    const resolvedTurnRange = sourceSession.isDraft
      ? resolveDeletedTurnRange(sourceSession.timeline, entryId)
      : (() => {
        try {
          return resolveDeletedTurnRange(sourceSession.timeline, entryId);
        } catch {
          return null;
        }
      })();
    const deletedUserEntryId = resolvedTurnRange?.deletedUserEntryId || entryId;
    const deletedAssistantEntryId = resolvedTurnRange?.deletedAssistantEntryId || null;
    const filteredTimeline = resolvedTurnRange
      ? [
        ...sourceSession.timeline.slice(0, resolvedTurnRange.startIndex),
        ...sourceSession.timeline.slice(resolvedTurnRange.endExclusive),
      ].map((entry) => ({ ...entry }))
      : [];

    const activeQueueItems = (await listCodexQueueItems(profileId)).filter((item) => (
      (item.queueKey === sessionId || item.sessionId === sessionId)
      && (
        item.status === 'scheduled'
        || item.status === 'queued'
        || item.status === 'running'
        || item.status === 'cancelling'
      )
    ));

    for (const item of activeQueueItems) {
      try {
        await cancelCodexQueueItem(item.id);
      } catch {
        // Best effort cancellation. Session rewrite still proceeds.
      }
    }

    if (sourceSession.isDraft) {
      const draft = await getForkDraftSession(sourceSession.id);
      if (!draft || draft.profileId !== profileId) {
        throw new Error('טיוטת השיחה שנבחרה כבר לא קיימת.');
      }

      const sourceProviderLabel = getProviderDisplayLabel(
        draft.transferSourceProvider || profile.provider
      );
      const latestUserEntryWithText = [...filteredTimeline]
        .reverse()
        .find((entry) => entry.entryType === 'message' && entry.role === 'user' && entry.text?.trim());
      const promptPreview = clipTransferText(latestUserEntryWithText?.text || draft.sourceTitle, 140);
      const promptPrefix = buildDeletedTurnPromptPrefix({
        ...sourceSession,
        title: draft.sourceTitle || sourceSession.title,
        cwd: draft.sourceCwd || sourceSession.cwd,
      }, sourceProviderLabel, filteredTimeline);

      await updateForkDraftSession(sourceSession.id, {
        promptPreview,
        promptPrefix,
        timeline: filteredTimeline,
      });
    } else {
      await deleteAgentTurn(sourceSession.id, deletedUserEntryId, profileId);
    }

    await deleteSessionChangeRecords(sourceSession.id);

    const updatedSessionBase = await getAgentSessionDetail(sourceSession.id, profileId, {
      full: true,
    });
    const updatedSession = await decorateSessionDetailForClient(profileId, updatedSessionBase);
    const [topicMap, titleMap] = await Promise.all([
      getSessionTopicMap(profileId),
      getSessionTitleMap(profileId),
    ]);

    res.json({
      sessionId: sourceSession.id,
      deletedUserEntryId,
      deletedAssistantEntryId,
      cancelledQueueItemIds: activeQueueItems.map((item) => item.id),
      session: {
        ...updatedSession,
        title: titleMap[sourceSession.id] || updatedSession.title,
        topic: topicMap[sourceSession.id] || null,
      },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete the selected turn' });
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

    const sourceSession = await normalizeSessionDetailForOperations(
      profileId,
      await getAgentSessionDetail(sessionId, profileId, {
        full: true,
      })
    );
    const forkResult = await createAgentForkSession(sourceSession.id, forkEntryId, profileId);
    const forkSidebarMetadata = await copySessionSidebarMetadataToForkSession(
      profileId,
      profileId,
      sourceSession,
      forkResult.sessionId
    );
    await copySessionContextSelectionToSession(profileId, profileId, sourceSession.id, forkResult.sessionId);
    await copySessionRemindersToSession(profileId, profileId, sourceSession.id, forkResult.sessionId);
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
    const forkSession = await decorateSessionDetailForClient(
      profileId,
      await getAgentSessionDetail(forkResult.sessionId, profileId, {
        tail: 120,
      })
    );

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
    await copySessionContextSelectionToSession(profileId, targetProfile.id, sourceSession.id, draft.sessionId);
    await copySessionRemindersToSession(profileId, targetProfile.id, sourceSession.id, draft.sessionId);
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
    const transferSession = await decorateSessionDetailForClient(
      targetProfile.id,
      await getAgentSessionDetail(draft.sessionId, targetProfile.id, {
        tail: 120,
      })
    );

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

router.get('/session-context-selection', requireCodexAccess, async (req, res) => {
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

    const selection = await getSessionContextSelection(profileId, sessionKey);
    res.json({ selection });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session context selection' });
  }
});

router.post('/session-context-selection', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sessionKey = typeof req.body?.sessionKey === 'string' && req.body.sessionKey.trim()
      ? req.body.sessionKey.trim()
      : undefined;

    if (!profileId || !sessionKey) {
      res.status(400).json({ error: 'Profile id and session key are required' });
      return;
    }

    const selection = await setSessionContextSelection(profileId, sessionKey, {
      anchorIds: req.body?.anchorIds,
      skillIds: req.body?.skillIds,
      reminderIds: req.body?.reminderIds,
      agentSessionDraftId: req.body?.agentSessionDraftId,
      professionalMode: req.body?.professionalMode,
    });
    res.json({ selection });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update session context selection' });
  }
});

router.get('/agent-sessions', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const cwdInput = typeof req.query.cwd === 'string' && req.query.cwd.trim()
      ? req.query.cwd.trim()
      : null;
    const cwd = cwdInput
      ? (await resolveCodexFolderPath(cwdInput, sourceProfile.id)).resolvedPath
      : null;
    const agentSessions = await listAgentSessionRecords(sourceProfile.id, cwd);
    res.json({ agentSessions });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load agent sessions' });
  }
});

router.post('/agent-sessions', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const cwdInput = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : sourceProfile.workspaceCwd;
    const cwd = (await resolveCodexFolderPath(cwdInput, sourceProfile.id)).resolvedPath;
    const plannerProvider = readAppProvider(req.body?.plannerProvider) || sourceProfile.provider;
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : `סשן סוכנים · ${path.basename(cwd) || 'workspace'}`;
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : '';
    const topicId = typeof req.body?.topicId === 'string' && req.body.topicId.trim()
      ? req.body.topicId.trim()
      : null;

    const agentSession = await createAgentSessionDraft({
      sourceProfile,
      cwd,
      title,
      goal,
      plannerProvider,
      topicId,
    });

    res.status(201).json({ agentSession });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create agent session draft' });
  }
});

router.get('/agent-sessions/:agentSessionId', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const agentSessionId = readRouteParam(req.params.agentSessionId);
    const agentSession = await getAgentSessionRecord(agentSessionId);
    if (!agentSession) {
      res.status(404).json({ error: 'Agent session was not found' });
      return;
    }
    assertAgentSessionAccess(agentSession, sourceProfile.id);

    res.json({ agentSession });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to load agent session' });
  }
});

router.post('/agent-sessions/:agentSessionId/goal', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const agentSessionId = readRouteParam(req.params.agentSessionId);
    const record = await getAgentSessionRecord(agentSessionId);
    if (!record) {
      res.status(404).json({ error: 'Agent session was not found' });
      return;
    }
    assertAgentSessionAccess(record, sourceProfile.id);

    const goal = typeof req.body?.goal === 'string' ? req.body.goal : '';
    const agentSession = await updateAgentSessionGoal(agentSessionId, goal);
    res.json({ agentSession });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update agent session goal' });
  }
});

router.post('/agent-sessions/:agentSessionId/plan', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const agentSessionId = readRouteParam(req.params.agentSessionId);
    const record = await getAgentSessionRecord(agentSessionId);
    if (!record) {
      res.status(404).json({ error: 'Agent session was not found' });
      return;
    }
    assertAgentSessionAccess(record, sourceProfile.id);

    const rawPlan = req.body?.plan;
    const agentSession = await saveAgentSessionPlan(agentSessionId, rawPlan, {
      plannerSessionId: record.plannerSessionId,
      plannerProfileId: record.plannerProfileId,
    });
    res.json({ agentSession });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to save agent session plan' });
  }
});

router.post('/agent-sessions/:agentSessionId/approve', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sourceProfile = resolveVisibleSourceProfile(requestedProfileId);
    if (!sourceProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }

    const agentSessionId = readRouteParam(req.params.agentSessionId);
    const record = await getAgentSessionRecord(agentSessionId);
    if (!record) {
      res.status(404).json({ error: 'Agent session was not found' });
      return;
    }
    assertAgentSessionAccess(record, sourceProfile.id);

    const approvedRecord = await approveAgentSession(agentSessionId);
    const launchItems = [];
    const agents = approvedRecord.plan?.agents || [];

    for (const agent of agents) {
      const internalProfileId = resolveAgentProviderProfileId(sourceProfile, agent.provider);
      const item = await enqueueCodexQueueItem({
        profileId: internalProfileId,
        sourceProfileId: sourceProfile.id,
        queueKey: `agent:${approvedRecord.id}:${agent.id}:${randomUUID()}`,
        sessionId: approvedRecord.plan?.runtimeAgents?.find((runtimeAgent) => runtimeAgent.id === agent.id)?.linkedSessionId || undefined,
        cwd: approvedRecord.cwd,
        prompt: buildAgentExecutionPrompt(approvedRecord, agent),
        promptPreview: `${approvedRecord.title} / ${agent.name}`,
        permissionModeId: 'full',
        agentSessionId: approvedRecord.id,
        agentId: agent.id,
        agentLinkKind: 'agent',
      });
      launchItems.push(item);
      await updateAgentRuntimeStatus(approvedRecord.id, agent.id, {
        runtimeStatus: 'queued',
        queueItemId: item.id,
        linkedSessionId: item.sessionId,
        lastError: null,
      });
    }

    await markAgentSessionLaunched(agentSessionId);
    const agentSession = await getAgentSessionRecord(agentSessionId);
    res.json({ agentSession, items: launchItems });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to approve and launch agent session' });
  }
});

router.get('/anchors', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const cwdInput = typeof req.query.cwd === 'string' && req.query.cwd.trim()
      ? req.query.cwd.trim()
      : undefined;

    if (!profileId || !cwdInput) {
      res.status(400).json({ error: 'Profile id and cwd are required' });
      return;
    }

    const cwd = (await resolveCodexFolderPath(cwdInput, profileId)).resolvedPath;
    const anchors = await listProjectAnchors(cwd);
    res.json({
      anchors: anchors.map((anchor) => ({
        ...anchor,
        relativePath: path.relative(cwd, anchor.targetPath) || '.',
      })),
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to load anchors' });
  }
});

router.post('/anchors', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const cwdInput = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const targetPathInput = typeof req.body?.targetPath === 'string' && req.body.targetPath.trim()
      ? req.body.targetPath.trim()
      : undefined;
    const targetKind = req.body?.targetKind === 'directory' ? 'directory' : req.body?.targetKind === 'file' ? 'file' : null;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : '';

    if (!profileId || !cwdInput || !targetPathInput || !targetKind) {
      res.status(400).json({ error: 'Profile id, cwd, target path and target kind are required' });
      return;
    }

    const cwd = (await resolveCodexFolderPath(cwdInput, profileId)).resolvedPath;
    const targetPath = (await resolveCodexFolderPath(targetPathInput, profileId)).resolvedPath;
    const targetStats = await fs.stat(targetPath);
    if (targetKind === 'directory' && !targetStats.isDirectory()) {
      res.status(400).json({ error: 'Target is not a directory' });
      return;
    }
    if (targetKind === 'file' && !targetStats.isFile()) {
      res.status(400).json({ error: 'Target is not a file' });
      return;
    }

    const anchor = await createProjectAnchor(cwd, {
      targetPath,
      targetKind,
      name,
      description,
    });
    res.status(201).json({
      anchor: {
        ...anchor,
        relativePath: path.relative(cwd, anchor.targetPath) || '.',
      },
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create anchor' });
  }
});

router.delete('/anchors/:anchorId', requireCodexAccess, async (req, res) => {
  try {
    const anchorId = readRouteParam(req.params.anchorId);
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const cwdInput = typeof req.query.cwd === 'string' && req.query.cwd.trim()
      ? req.query.cwd.trim()
      : undefined;

    if (!profileId || !cwdInput) {
      res.status(400).json({ error: 'Profile id and cwd are required' });
      return;
    }

    const cwd = (await resolveCodexFolderPath(cwdInput, profileId)).resolvedPath;
    await deleteProjectAnchor(cwd, anchorId);
    res.status(204).end();
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete anchor' });
  }
});

router.get('/skills', requireCodexAccess, async (_req, res) => {
  try {
    const skills = await listUnifiedSkills();
    res.json({ skills });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load unified skills' });
  }
});

router.get('/session-reminders', requireCodexAccess, async (req, res) => {
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

    const reminders = await listSessionReminders(profileId, sessionKey);
    res.json({ reminders });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session reminders' });
  }
});

router.post('/session-reminders', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sessionKey = typeof req.body?.sessionKey === 'string' && req.body.sessionKey.trim()
      ? req.body.sessionKey.trim()
      : undefined;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const sourceEntryId = typeof req.body?.sourceEntryId === 'string' ? req.body.sourceEntryId : null;
    const sourceRole = req.body?.sourceRole === 'user' || req.body?.sourceRole === 'assistant'
      ? req.body.sourceRole
      : null;

    if (!profileId || !sessionKey) {
      res.status(400).json({ error: 'Profile id and session key are required' });
      return;
    }

    const reminder = await createSessionReminder(profileId, sessionKey, {
      name,
      content,
      sourceEntryId,
      sourceRole,
    });
    res.status(201).json({ reminder });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create reminder' });
  }
});

router.delete('/session-reminders/:reminderId', requireCodexAccess, async (req, res) => {
  try {
    const reminderId = readRouteParam(req.params.reminderId);
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

    await deleteSessionReminder(profileId, sessionKey, reminderId);
    res.json({ deleted: true, reminderId });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete reminder' });
  }
});

router.get('/tasks', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const tasks = await listSessionTasks(profileId);
    res.json({ tasks });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load tasks' });
  }
});

router.post('/tasks', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const taskId = typeof req.body?.taskId === 'string' && req.body.taskId.trim()
      ? req.body.taskId.trim()
      : null;
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : '';
    const dueAt = typeof req.body?.dueAt === 'string' ? req.body.dueAt : req.body?.dueAt === null ? null : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const task = taskId
      ? await updateSessionTask(profileId, taskId, { title, description, dueAt })
      : await createSessionTask(profileId, { title, description, dueAt });

    res.status(taskId ? 200 : 201).json({ task });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to save task' });
  }
});

router.delete('/tasks/:taskId', requireCodexAccess, async (req, res) => {
  try {
    const taskId = readRouteParam(req.params.taskId);
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : typeof req.body?.profileId === 'string' && req.body.profileId.trim()
        ? req.body.profileId.trim()
        : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    await deleteSessionTask(profileId, taskId);
    res.json({ deleted: true, taskId });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete task' });
  }
});

router.post('/tasks/:taskId/sessions', requireCodexAccess, async (req, res) => {
  try {
    const taskId = readRouteParam(req.params.taskId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const assigned = req.body?.assigned !== false;

    if (!profileId || !sessionId) {
      res.status(400).json({ error: 'Profile id and session id are required' });
      return;
    }

    const task = await setTaskSessionAssignment(profileId, taskId, sessionId, assigned);
    res.json({ task });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update task sessions' });
  }
});

router.post('/tasks/:taskId/sessions/:sessionId/completion', requireCodexAccess, async (req, res) => {
  try {
    const taskId = readRouteParam(req.params.taskId);
    const sessionId = readRouteParam(req.params.sessionId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const completed = req.body?.completed !== false;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const task = await setTaskSessionCompletion(profileId, taskId, sessionId, completed);
    res.json({ task });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update task completion' });
  }
});

router.get('/session-subtasks', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : undefined;
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.trim()
      ? req.query.sessionId.trim()
      : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const subtasks = await listSessionSubtasks(profileId, sessionId);
    res.json({ subtasks });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load session subtasks' });
  }
});

router.post('/session-subtasks', requireCodexAccess, async (req, res) => {
  try {
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const title = typeof req.body?.title === 'string' ? req.body.title : '';

    if (!profileId || !sessionId) {
      res.status(400).json({ error: 'Profile id and session id are required' });
      return;
    }

    const subtask = await createSessionSubtask(profileId, sessionId, title);
    res.status(201).json({ subtask });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to create session subtask' });
  }
});

router.post('/session-subtasks/:subtaskId/completion', requireCodexAccess, async (req, res) => {
  try {
    const subtaskId = readRouteParam(req.params.subtaskId);
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;
    const completed = req.body?.completed !== false;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    const subtask = await setSessionSubtaskCompletion(profileId, subtaskId, completed);
    res.json({ subtask });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to update session subtask completion' });
  }
});

router.delete('/session-subtasks/:subtaskId', requireCodexAccess, async (req, res) => {
  try {
    const subtaskId = readRouteParam(req.params.subtaskId);
    const profileId = typeof req.query.profileId === 'string' && req.query.profileId.trim()
      ? req.query.profileId.trim()
      : typeof req.body?.profileId === 'string' && req.body.profileId.trim()
        ? req.body.profileId.trim()
        : undefined;

    if (!profileId) {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }

    await deleteSessionSubtask(profileId, subtaskId);
    res.json({ deleted: true, subtaskId });
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Failed to delete session subtask' });
  }
});

router.post('/queue/items', requireCodexAccess, async (req, res) => {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const visibleProfileId = requestedProfileId || 'developer';
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const profileId = sessionId
      ? await resolveEffectiveProfileIdForSession(visibleProfileId, sessionId)
      : visibleProfileId;
    const configuredProfile = findConfiguredProfile(profileId);
    if (!configuredProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }
    const queueKey = typeof req.body?.queueKey === 'string' && req.body.queueKey.trim()
      ? req.body.queueKey.trim()
      : randomUUID();
    const clientRequestId = typeof req.body?.clientRequestId === 'string' && req.body.clientRequestId.trim()
      ? req.body.clientRequestId.trim()
      : undefined;
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const prompt = typeof req.body?.prompt === 'string'
      ? req.body.prompt
      : typeof req.body?.message === 'string'
        ? req.body.message
        : '';
    const promptPreview = typeof req.body?.promptPreview === 'string' ? req.body.promptPreview : undefined;
    const contextPrefix = typeof req.body?.contextPrefix === 'string' ? req.body.contextPrefix : undefined;
    const sessionInstruction = typeof req.body?.sessionInstruction === 'string' ? req.body.sessionInstruction : undefined;
    const forkContext = req.body?.forkContext;
    const scheduledAt = typeof req.body?.scheduledAt === 'string' && req.body.scheduledAt.trim()
      ? req.body.scheduledAt.trim()
      : undefined;
    const recurrence = readRecurringConfig(req.body);
    const cwd = requestedCwd
      ? (await resolveCodexFolderPath(requestedCwd, visibleProfileId)).resolvedPath
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
        visibleProfileId,
        queueKey,
        sessionId,
        contextPrefix,
        forkContext
      )
      : {
        contextPrefix: undefined,
        forkContext: undefined,
      };
    const supportEnvelope = isSupportProfile(configuredProfile)
      ? buildSupportPromptEnvelope(configuredProfile, {
        source: 'ui',
        userPrompt: prompt,
        authenticatedUser: (req as any).codexAuth?.user || null,
      })
      : null;
    const basePrompt = supportEnvelope?.compiledPrompt || prompt;
    const effectivePromptPreview = supportEnvelope?.promptPreview || promptPreview;
    const effectiveSessionInstruction = buildSupportSessionInstruction(sessionInstruction, supportEnvelope);
    const sessionContextKey = sessionId || queueKey;
    const sessionContextSelection = sessionContextKey
      ? await getSessionContextSelection(visibleProfileId, sessionContextKey)
      : { anchorIds: [], skillIds: [], reminderIds: [], agentSessionDraftId: null, professionalMode: false };
    const contextCwd = cwd || (
      sessionId
        ? (await getAgentSessionDetail(sessionId, profileId, { tail: 1 }).catch(() => null))?.cwd || configuredProfile.workspaceCwd
        : configuredProfile.workspaceCwd
    );
    const additionsPromptSuffix = sessionContextKey
      ? await buildSessionPromptAdditionsContext({
        profileId: visibleProfileId,
        sessionKey: sessionContextKey,
        cwd: contextCwd,
      })
      : null;
    const effectivePrompt = [basePrompt, additionsPromptSuffix]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
    const combinedContextPrefix = [hydratedForkDraft.contextPrefix]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');

    if (sessionContextSelection.agentSessionDraftId) {
      const sourceProfile = resolveVisibleSourceProfile(visibleProfileId);
      if (!sourceProfile) {
        res.status(404).json({ error: 'The selected profile was not found' });
        return;
      }

      const existingRecord = await getAgentSessionRecord(sessionContextSelection.agentSessionDraftId);
      if (!existingRecord) {
        res.status(404).json({ error: 'Agent session draft was not found' });
        return;
      }
      assertAgentSessionAccess(existingRecord, sourceProfile.id);

      const updatedRecord = await updateAgentSessionGoal(existingRecord.id, effectivePrompt);
      const plannerProfileId = resolveAgentProviderProfileId(sourceProfile, updatedRecord.plannerProvider);
      const plannerItem = await enqueueCodexQueueItem({
        profileId: plannerProfileId,
        sourceProfileId: sourceProfile.id,
        queueKey,
        clientRequestId,
        sessionId: updatedRecord.plannerSessionId || undefined,
        cwd: updatedRecord.cwd,
        prompt: buildAgentPlanPrompt(updatedRecord),
        promptPreview: `תכנית סוכנים · ${updatedRecord.title}`,
        contextPrefix: combinedContextPrefix || undefined,
        attachments,
        agentSessionId: updatedRecord.id,
        agentLinkKind: 'planner',
        permissionModeId: 'full',
      });

      if (sessionContextKey) {
        await deleteSessionContextSelection(visibleProfileId, sessionContextKey);
      }

      res.status(202).json({ item: plannerItem, agentSession: updatedRecord });
      return;
    }

    if (sessionContextSelection.professionalMode) {
      if (recurrence) {
        res.status(400).json({ error: 'מצב מקצועי אינו תומך כרגע בתזמון קבוע. בחר שליחה חד-פעמית.' });
        return;
      }

      const professionalSpecs = buildProfessionalModeQueueSpecs(basePrompt);
      const queuedItems: Awaited<ReturnType<typeof enqueueCodexQueueItem>>[] = [];

      for (const [index, spec] of professionalSpecs.entries()) {
        const stepPrompt = index === 0
          ? [spec.prompt, additionsPromptSuffix]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .join('\n\n')
          : spec.prompt;
        const nextItem = await enqueueCodexQueueItem({
          profileId,
          sourceProfileId: visibleProfileId,
          queueKey,
          clientRequestId: index === 0 ? clientRequestId : undefined,
          sessionId,
          cwd,
          prompt: stepPrompt,
          promptPreview: spec.promptPreview,
          contextPrefix: combinedContextPrefix || undefined,
          sessionInstruction: effectiveSessionInstruction,
          forkContext: index === 0 ? hydratedForkDraft.forkContext : undefined,
          scheduledAt,
          attachments: index === 0 ? attachments : [],
        });
        queuedItems.push(nextItem);
      }

      if (sessionContextKey) {
        await deleteSessionContextSelection(visibleProfileId, sessionContextKey);
      }

      res.status(202).json({ items: queuedItems });
      return;
    }

    if (supportEnvelope) {
      await recordSupportTurnRequest({
        profile: configuredProfile,
        sessionKey: sessionId || queueKey,
        source: 'ui',
        envelope: supportEnvelope,
      });
    }

    const item = await enqueueCodexQueueItem({
      profileId,
      sourceProfileId: visibleProfileId,
      queueKey,
      clientRequestId,
      sessionId,
      cwd,
      prompt: effectivePrompt,
      promptPreview: effectivePromptPreview,
      contextPrefix: combinedContextPrefix || undefined,
      sessionInstruction: effectiveSessionInstruction,
      forkContext: hydratedForkDraft.forkContext,
      scheduledAt,
      attachments,
      recurrence,
    });

    if (sessionContextKey) {
      await deleteSessionContextSelection(visibleProfileId, sessionContextKey);
    }

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
    const prompt = typeof req.body?.prompt === 'string'
      ? req.body.prompt
      : typeof req.body?.message === 'string'
        ? req.body.message
        : '';
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
    const visibleProfileId = requestedProfileId || 'developer';
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
    const profileId = sessionId
      ? await resolveEffectiveProfileIdForSession(visibleProfileId, sessionId)
      : visibleProfileId;
    const configuredProfile = findConfiguredProfile(profileId);
    if (!configuredProfile) {
      res.status(404).json({ error: 'The selected profile was not found' });
      return;
    }
    const effectiveQueueKey = queueKey || sessionId || randomUUID();
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const promptPreview = typeof req.body?.promptPreview === 'string' ? req.body.promptPreview : undefined;
    const contextPrefix = typeof req.body?.contextPrefix === 'string' ? req.body.contextPrefix : undefined;
    const sessionInstruction = typeof req.body?.sessionInstruction === 'string' ? req.body.sessionInstruction : undefined;
    const forkContext = req.body?.forkContext;
    const executionConfig = readExecutionConfig(req.body);
    if (!executionConfig.permissionModeId) {
      executionConfig.permissionModeId = await getSelectedPermissionModeId(configuredProfile);
    }
    const recurrence = readRecurringConfig(req.body);
    const cwd = requestedCwd
      ? (await resolveCodexFolderPath(requestedCwd, visibleProfileId)).resolvedPath
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
        visibleProfileId,
        queueKey,
        sessionId,
        contextPrefix,
        forkContext
      )
      : {
        contextPrefix: undefined,
        forkContext: undefined,
      };
    const supportEnvelope = isSupportProfile(configuredProfile)
      ? buildSupportPromptEnvelope(configuredProfile, {
        source: 'ui',
        userPrompt: prompt,
        authenticatedUser: (req as any).codexAuth?.user || null,
      })
      : null;
    const providerPrompt = supportEnvelope?.compiledPrompt || prompt;
    const sessionContextKey = sessionId || effectiveQueueKey;
    const sessionContextSelection = await getSessionContextSelection(visibleProfileId, sessionContextKey);
    const contextCwd = cwd || (sessionId
      ? (await getAgentSessionDetail(sessionId, visibleProfileId, { tail: 1 }).catch(() => null))?.cwd || configuredProfile.workspaceCwd
      : configuredProfile.workspaceCwd);
    const additionsPromptSuffix = await buildSessionPromptAdditionsContext({
      profileId: visibleProfileId,
      sessionKey: sessionContextKey,
      cwd: contextCwd,
    });
    const providerPromptWithAdditions = [providerPrompt, additionsPromptSuffix]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
    const combinedContextPrefix = [hydratedForkDraft.contextPrefix]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n');
    const promptWithForkContext = combinedContextPrefix.trim()
      ? `${combinedContextPrefix.trim()}\n\nהודעת ההמשך החדשה:\n${providerPromptWithAdditions}`
      : providerPromptWithAdditions;
    const effectiveSessionInstruction = buildSupportSessionInstruction(sessionInstruction, supportEnvelope);
    const effectivePrompt = effectiveSessionInstruction?.trim()
      ? `${promptWithForkContext}\n\nהוראה קבועה לסשן זה. יש ליישם אותה גם אם המשתמש לא חזר עליה בהודעה הנוכחית:\n${effectiveSessionInstruction.trim()}`
      : promptWithForkContext;

    if (sessionContextSelection.agentSessionDraftId) {
      const sourceProfile = resolveVisibleSourceProfile(visibleProfileId);
      if (!sourceProfile) {
        res.status(404).json({ error: 'The selected profile was not found' });
        return;
      }

      const existingRecord = await getAgentSessionRecord(sessionContextSelection.agentSessionDraftId);
      if (!existingRecord) {
        res.status(404).json({ error: 'Agent session draft was not found' });
        return;
      }
      assertAgentSessionAccess(existingRecord, sourceProfile.id);

      const updatedRecord = await updateAgentSessionGoal(existingRecord.id, effectivePrompt);
      const plannerProfileId = resolveAgentProviderProfileId(sourceProfile, updatedRecord.plannerProvider);
      const plannerExecutionConfig: CodexExecutionConfig = {
        model: null,
        reasoningEffort: null,
        permissionModeId: 'full',
      };

      if (!asyncRequested) {
        const result = await runAgentPrompt(
          buildAgentPlanPrompt(updatedRecord),
          updatedRecord.plannerSessionId,
          plannerProfileId,
          attachments,
          {
            cwd: updatedRecord.cwd,
            injectDirectoryContext: !updatedRecord.plannerSessionId,
            executionConfig: plannerExecutionConfig,
          }
        );
        const parsedPlan = await readAgentPlanJsonFromDisk(updatedRecord);
        const savedRecord = await saveAgentSessionPlan(updatedRecord.id, parsedPlan, {
          plannerSessionId: result.sessionId,
          plannerProfileId,
        });
        await recordAgentSessionLinkedSession({
          sessionId: result.sessionId,
          agentSessionId: savedRecord.id,
          sourceProfileId: sourceProfile.id,
          profileId: plannerProfileId,
          provider: updatedRecord.plannerProvider,
          kind: 'planner',
          agentId: null,
          createdAt: nowIso(),
        });
        await deleteSessionContextSelection(visibleProfileId, sessionContextKey);
        const session = await decorateSessionDetailForClient(
          visibleProfileId,
          await getAgentSessionDetail(result.sessionId, plannerProfileId)
        );
        res.json({
          session,
          finalMessage: result.finalMessage,
          agentSession: savedRecord,
        });
        return;
      }

      const item = await enqueueCodexQueueItem({
        profileId: plannerProfileId,
        sourceProfileId: sourceProfile.id,
        queueKey: effectiveQueueKey,
        clientRequestId,
        sessionId: updatedRecord.plannerSessionId || undefined,
        cwd: updatedRecord.cwd,
        prompt: buildAgentPlanPrompt(updatedRecord),
        promptPreview: `תכנית סוכנים · ${updatedRecord.title}`,
        contextPrefix: combinedContextPrefix || undefined,
        attachments,
        agentSessionId: updatedRecord.id,
        agentLinkKind: 'planner',
        permissionModeId: 'full',
      });
      await deleteSessionContextSelection(visibleProfileId, sessionContextKey);
      res.status(202).json({ job: item, agentSession: updatedRecord });
      return;
    }

    if (!asyncRequested) {
      const supportSessionKey = sessionId || effectiveQueueKey;
      if (supportEnvelope) {
        await recordSupportTurnRequest({
          profile: configuredProfile,
          sessionKey: supportSessionKey,
          source: 'ui',
          envelope: supportEnvelope,
        });
      }
      const result = await runAgentPrompt(effectivePrompt, sessionId, profileId, attachments, {
        cwd,
        injectDirectoryContext: !sessionId,
        executionConfig,
      });
      if (!sessionId && supportSessionKey !== result.sessionId) {
        await rebindSessionInstruction(visibleProfileId, supportSessionKey, result.sessionId);
        await rebindSessionReminders(visibleProfileId, supportSessionKey, result.sessionId);
      }
      if (supportEnvelope && supportSessionKey !== result.sessionId) {
        await rebindSupportSessionRecord(visibleProfileId, supportSessionKey, result.sessionId);
      }
      await deleteSessionContextSelection(visibleProfileId, supportSessionKey);
      const session = await decorateSessionDetailForClient(
        visibleProfileId,
        await getAgentSessionDetail(result.sessionId, profileId)
      );

      res.json({
        session,
        finalMessage: result.finalMessage,
      });
      return;
    }

    if (supportEnvelope) {
      await recordSupportTurnRequest({
        profile: configuredProfile,
        sessionKey: effectiveQueueKey,
        source: 'ui',
        envelope: supportEnvelope,
      });
    }
    const item = await enqueueCodexQueueItem({
      profileId,
      sourceProfileId: visibleProfileId,
      queueKey: effectiveQueueKey,
      clientRequestId,
      sessionId,
      cwd,
      model: executionConfig.model,
      reasoningEffort: executionConfig.reasoningEffort,
      permissionModeId: executionConfig.permissionModeId,
      prompt: providerPrompt,
      promptPreview: supportEnvelope?.promptPreview || promptPreview,
      contextPrefix: combinedContextPrefix || undefined,
      sessionInstruction: effectiveSessionInstruction,
      forkContext: hydratedForkDraft.forkContext,
      attachments,
      recurrence,
    });

    await deleteSessionContextSelection(visibleProfileId, sessionContextKey);

    res.status(202).json({ job: item });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Codex request failed' });
  }
});

async function handleSupportAskRequest(
  req: Request,
  res: Response,
  source: 'api' | 'webhook'
) {
  try {
    const requestedProfileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : '';
    const requestedProvider = typeof req.body?.provider === 'string'
      ? req.body.provider.trim()
      : '';
    const profile = resolveSupportProfileSelection(
      requestedProfileId || undefined,
      requestedProvider === 'codex' || requestedProvider === 'claude' || requestedProvider === 'gemini'
        ? requestedProvider
        : undefined
    );
    const prompt = typeof req.body?.prompt === 'string'
      ? req.body.prompt
      : typeof req.body?.message === 'string'
        ? req.body.message
        : '';
    const asyncRequested = req.headers['x-codex-async'] === '1' || req.body?.async === true;
    const requestedCwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
      ? req.body.cwd.trim()
      : undefined;
    const queueKey = typeof req.body?.queueKey === 'string' && req.body.queueKey.trim()
      ? req.body.queueKey.trim()
      : `draft:support:${randomUUID()}`;
    const clientRequestId = typeof req.body?.clientRequestId === 'string' && req.body.clientRequestId.trim()
      ? req.body.clientRequestId.trim()
      : undefined;
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    const requestedSupportLevel = readSupportExecutionLevel(
      req.body?.supportLevel ?? req.body?.level ?? req.body?.tier
    );
    const supportExecution = resolveSupportExecutionConfig(
      profile.provider,
      requestedSupportLevel,
      readExecutionConfig(req.body)
    );
    const executionConfig = supportExecution.executionConfig;
    if (!executionConfig.permissionModeId) {
      executionConfig.permissionModeId = await getSelectedPermissionModeId(profile);
    }
    const cwd = requestedCwd
      ? (await resolveCodexFolderPath(requestedCwd, profile.id)).resolvedPath
      : profile.workspaceCwd;
    const envelope = buildSupportPromptEnvelope(profile, {
      source,
      userPrompt: prompt,
      userContext: typeof req.body?.userContext === 'string'
        ? req.body.userContext
        : (() => {
          try {
            return req.body?.userContext === undefined
              ? null
              : JSON.stringify(req.body.userContext, null, 2);
          } catch {
            return null;
          }
        })(),
      webhookPayload: req.body?.payload ?? req.body?.webhookPayload,
      authenticatedUser: (req as any).codexAuth?.user || null,
    });

    await recordSupportTurnRequest({
      profile,
      sessionKey: sessionId || queueKey,
      source,
      envelope,
    });

    if (!asyncRequested) {
      const result = await runAgentPrompt(envelope.compiledPrompt, sessionId, profile.id, [], {
        cwd,
        injectDirectoryContext: !sessionId,
        executionConfig,
      });
      if ((sessionId || queueKey) !== result.sessionId) {
        await rebindSupportSessionRecord(profile.id, sessionId || queueKey, result.sessionId);
      }
      const session = await decorateSessionDetailForClient(
        profile.id,
        await getAgentSessionDetail(result.sessionId, profile.id)
      );

      res.json({
        profileId: profile.id,
        supportLevel: supportExecution.level,
        executionConfig,
        session,
        finalMessage: result.finalMessage,
      });
      return;
    }

    const item = await enqueueCodexQueueItem({
      profileId: profile.id,
      queueKey: sessionId || queueKey,
      clientRequestId,
      sessionId,
      cwd,
      model: executionConfig.model,
      reasoningEffort: executionConfig.reasoningEffort,
      permissionModeId: executionConfig.permissionModeId,
      prompt: envelope.compiledPrompt,
      promptPreview: envelope.promptPreview,
    });

    res.status(202).json({
      profileId: profile.id,
      supportLevel: supportExecution.level,
      executionConfig,
      item,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Support request failed' });
  }
}

router.post('/support/ask', requireCodexAccess, async (req, res) => {
  await handleSupportAskRequest(req, res, 'api');
});

router.post('/support/webhook', requireSupportWebhookAccess, async (req, res) => {
  await handleSupportAskRequest(req, res, 'webhook');
});

export default router;
