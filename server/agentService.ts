import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import {
  cancelCodexRun,
  consumeCodexFullReset,
  createCodexForkSession,
  deleteCodexSession,
  deleteCodexTurn,
  getAvailableProfiles as getAvailableCodexProfiles,
  getCodexModelCatalog,
  getCodexMultiAgentSnapshot,
  getCodexRateLimitSnapshot,
  getCodexSessionDetail,
  listCodexSessions,
  resolveCodexProfile,
  runCodexPrompt,
  updateCodexExecutionDefaults,
  updateCodexMultiAgentMode,
  updateCodexResponseSpeed,
  type CodexExecutionConfig,
  type CodexModelCatalog,
  type CodexMultiAgentSnapshot,
  type CodexPermissionSnapshot,
  type CodexProfile,
  type CodexRateLimitSnapshot,
  type CodexSessionDetail,
  type CodexSessionSummary,
  type CodexUploadedAttachment,
} from './codexService.js';
import {
  cancelClaudeRun,
  createClaudeForkSession,
  deleteClaudeSession,
  deleteClaudeTurn,
  getAvailableClaudeProfiles,
  getClaudeModelCatalog,
  getClaudeRateLimitSnapshot,
  getClaudeSessionDetail,
  listClaudeSessions,
  resolveClaudeProfile,
  runClaudePrompt,
  updateClaudeResponseSpeed,
  ClaudeRunCancelledError,
} from './claudeService.js';
import {
  cancelGeminiRun,
  createGeminiForkSession,
  deleteGeminiSession,
  deleteGeminiTurn,
  getAvailableGeminiProfiles,
  getGeminiModelCatalog,
  getGeminiRateLimitSnapshot,
  getGeminiSessionDetail,
  listGeminiSessions,
  resolveGeminiProfile,
  runGeminiPrompt,
  GeminiRunCancelledError,
} from './geminiService.js';
import { CodexRunCancelledError } from './codexService.js';
import {
  beginSessionChangeCapture,
  discardSessionChangeCapture,
  deriveSessionChangeRecordFromTimeline,
  enforceSessionActionRestriction,
  finalizeSessionChangeCapture,
  readSessionChangeRecord,
  SessionActionRestrictionViolationError,
  type SessionChangeRecord,
} from './sessionChangeTracker.js';
import {
  prepareAllSupportProfileHomes,
  prepareSupportProfileHome,
} from './supportAgentService.js';
import {
  isAgentSessionProfile,
  prepareAgentSessionProfileHome,
} from './agentSessionProfiles.js';
import {
  buildPermissionSnapshotFromMode,
  getSelectedPermissionMode,
  getSelectedPermissionModeId,
  setSelectedPermissionModeId,
} from './providerPermissions.js';
import type { CodexSessionActionRestriction } from './codexSessionContextSelections.js';
import type { CodexSessionBrowserMode } from './codexBrowserMode.js';
import type { CodexSessionDesignMode } from './codexDesignMode.js';
import type { CodexSessionUxMode } from './codexUxMode.js';
import type { CodexSessionPersonalChromeMode } from './codexPersonalChromeMode.js';
import type { CodexSessionPhoneMode } from './codexPhoneMode.js';
import {
  enqueueFinalResponseNotification,
  enqueueSessionOutcomeNotification,
  type SessionNotificationOutcome,
} from './codexFinalNotifications.js';
import type { ProviderSessionStartedHandler } from './providerProcessLifecycle.js';
import {
  getSessionWorkspaceMap,
  getSessionWorkspaceOverride,
} from './codexSessionWorkspaces.js';

export type AgentProfile = CodexProfile;

export interface AgentRunResult {
  sessionId: string;
  finalMessage: string;
  sessionTitle: string | null;
}

function classifyFailedRunNotificationOutcome(error: unknown): Exclude<SessionNotificationOutcome, 'completed'> {
  if (isAgentRunCancelledError(error)) {
    return 'cancelled';
  }
  const message = error instanceof Error ? error.message : String(error || '');
  return /\b(abort(?:ed)?|interrupt(?:ed)?|terminat(?:ed|ion)|disconnect(?:ed)?|closed?|restart)\b/iu.test(message)
    ? 'interrupted'
    : 'failed';
}

function resolveLatestAssistantEntryId(
  detail: CodexSessionDetail,
  baselineEntryIds: Set<string>
): string | null {
  const newAssistantMessages = detail.timeline.filter((entry) => (
    entry.entryType === 'message'
    && entry.role === 'assistant'
    && !baselineEntryIds.has(entry.id)
  ));

  const preferredNewFinal = [...newAssistantMessages].reverse().find((entry) => entry.kind === 'final');
  if (preferredNewFinal) {
    return preferredNewFinal.id;
  }

  if (newAssistantMessages.length > 0) {
    return newAssistantMessages[newAssistantMessages.length - 1]?.id || null;
  }

  const latestFinal = [...detail.timeline].reverse().find((entry) => (
    entry.entryType === 'message'
    && entry.role === 'assistant'
    && entry.kind === 'final'
  ));

  if (latestFinal) {
    return latestFinal.id;
  }

  const latestAssistant = [...detail.timeline].reverse().find((entry) => (
    entry.entryType === 'message'
    && entry.role === 'assistant'
  ));

  return latestAssistant?.id || null;
}

function resolveProfile(profileId?: string): AgentProfile {
  const profile = CODEX_APP_CONFIG.profiles.find((candidate) => candidate.id === profileId)
    || CODEX_APP_CONFIG.profiles.find((candidate) => candidate.defaultProfile)
    || CODEX_APP_CONFIG.profiles[0];

  if (!profile) {
    throw new Error('No agent profile is configured');
  }

  return profile;
}

export function resolveAgentProfile(profileId?: string): AgentProfile {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return resolveClaudeProfile(profile.id);
  }
  if (profile.provider === 'gemini') {
    return resolveGeminiProfile(profile.id);
  }

  return resolveCodexProfile(profile.id);
}

export function getProviderForProfile(profileId?: string): AppProvider {
  return resolveProfile(profileId).provider;
}

async function buildProviderPermissionSnapshot(profile: AgentProfile): Promise<CodexPermissionSnapshot> {
  const selectedMode = await getSelectedPermissionMode(profile);
  const selectedModeId = await getSelectedPermissionModeId(profile);
  return buildPermissionSnapshotFromMode(profile, selectedMode, {
    profileId: profile.id,
    sessionId: null,
    selectedModeId,
    effectiveModeId: selectedMode.id,
    effectiveModeLabel: selectedMode.modeLabel,
    approvalLabel: selectedMode.approvalLabel,
    sandboxLabel: selectedMode.sandboxLabel,
    toolsLabel: selectedMode.toolsLabel,
    trustLabel: selectedMode.trustLabel,
    updatedAt: null,
    pendingApproval: null,
  });
}

async function prepareInternalProfileHome(profile: AgentProfile): Promise<void> {
  if (isAgentSessionProfile(profile)) {
    await prepareAgentSessionProfileHome(profile);
    return;
  }

  await prepareSupportProfileHome(profile);
}

export async function getAvailableProfiles(): Promise<AgentProfile[]> {
  const failedSupportProfiles = await prepareAllSupportProfileHomes();
  const [codexProfiles, claudeProfiles, geminiProfiles] = await Promise.all([
    getAvailableCodexProfiles(),
    getAvailableClaudeProfiles(),
    getAvailableGeminiProfiles(),
  ]);

  return [...codexProfiles, ...claudeProfiles, ...geminiProfiles].filter((profile) => (
    !failedSupportProfiles.has(profile.id)
    && profile.mode !== 'agent'
    && !profile.internalOnly
  ));
}

export async function listAgentSessions(
  profileId?: string,
  query?: string,
  limit?: number,
  options?: { allowExtendedLimit?: boolean },
): Promise<CodexSessionSummary[]> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  let sessions: CodexSessionSummary[];
  if (profile.provider === 'claude') {
    sessions = await listClaudeSessions(profile.id, query, limit, options?.allowExtendedLimit);
  } else if (profile.provider === 'gemini') {
    sessions = await listGeminiSessions(profile.id, query, limit, options?.allowExtendedLimit);
  } else {
    sessions = await listCodexSessions(profile.id, query, limit, options?.allowExtendedLimit);
  }

  const workspaceMap = await getSessionWorkspaceMap(profile.id);
  return sessions.map((session) => workspaceMap[session.id]
    ? { ...session, cwd: workspaceMap[session.id]!.cwd }
    : session);
}

export async function getAgentSessionDetail(
  sessionId: string,
  profileId?: string,
  options?: {
    tail?: number;
    before?: number;
    full?: boolean;
  }
): Promise<CodexSessionDetail> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  let session: CodexSessionDetail;
  if (profile.provider === 'claude') {
    session = await getClaudeSessionDetail(sessionId, profile.id, options);
  } else if (profile.provider === 'gemini') {
    session = await getGeminiSessionDetail(sessionId, profile.id, options);
  } else {
    session = await getCodexSessionDetail(sessionId, profile.id, options);
  }

  const workspaceOverride = await getSessionWorkspaceOverride(profile.id, sessionId);
  return workspaceOverride ? { ...session, cwd: workspaceOverride.cwd } : session;
}

export async function getAgentModelCatalog(profileId?: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  const permissions = await buildProviderPermissionSnapshot(profile);
  if (profile.provider === 'claude') {
    const catalog = await getClaudeModelCatalog(profile.id);
    return {
      ...catalog,
      permissions,
    };
  }
  if (profile.provider === 'gemini') {
    const catalog = await getGeminiModelCatalog(profile.id);
    return {
      ...catalog,
      permissions,
    };
  }

  const catalog = await getCodexModelCatalog(profile.id);
  return {
    ...catalog,
    permissions,
  };
}

export async function updateAgentPermissionMode(
  profileId: string | undefined,
  modeId: string
): Promise<CodexPermissionSnapshot> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  await setSelectedPermissionModeId(profile, modeId);
  return buildProviderPermissionSnapshot(profile);
}

export async function updateAgentResponseSpeed(
  profileId: string | undefined,
  modeId: string
): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider === 'claude') {
    const catalog = await updateClaudeResponseSpeed(profile.id, modeId);
    return {
      ...catalog,
      permissions: await buildProviderPermissionSnapshot(profile),
    };
  }
  if (profile.provider === 'gemini') {
    throw new Error('Gemini CLI does not expose a configurable response speed mode');
  }

  const catalog = await updateCodexResponseSpeed(profile.id, modeId);
  return {
    ...catalog,
    permissions: await buildProviderPermissionSnapshot(profile),
  };
}

export async function updateAgentExecutionDefaults(
  profileId: string | undefined,
  modelSlug: string,
  reasoningEffort?: string | null
): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider !== 'codex') {
    throw new Error('Persistent model selection is currently available for Codex profiles only');
  }

  const catalog = await updateCodexExecutionDefaults(profile.id, modelSlug, reasoningEffort);
  return {
    ...catalog,
    permissions: await buildProviderPermissionSnapshot(profile),
  };
}

export async function getAgentMultiAgentSnapshot(
  profileId?: string
): Promise<CodexMultiAgentSnapshot> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider !== 'codex') {
    throw new Error('Native multi-agent controls are available for Codex profiles only');
  }

  return getCodexMultiAgentSnapshot(profile.id);
}

export async function updateAgentMultiAgentMode(
  profileId: string | undefined,
  enabled: boolean
): Promise<CodexMultiAgentSnapshot> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider !== 'codex') {
    throw new Error('Native multi-agent controls are available for Codex profiles only');
  }

  return updateCodexMultiAgentMode(profile.id, enabled);
}

export async function getAgentRateLimitSnapshot(
  profileId?: string,
  sessionId?: string,
  forceAccountRefresh = false
): Promise<CodexRateLimitSnapshot | null> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider === 'claude') {
    return getClaudeRateLimitSnapshot(profile.id, sessionId);
  }
  if (profile.provider === 'gemini') {
    return getGeminiRateLimitSnapshot(profile.id, sessionId);
  }

  return getCodexRateLimitSnapshot(profile.id, sessionId, forceAccountRefresh);
}

export async function consumeAgentFullReset(
  profileId: string | undefined,
  creditId: string,
  redeemRequestId: string
) {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider !== 'codex') {
    throw new Error('Full Reset זמין רק בפרופילי Codex.');
  }
  return consumeCodexFullReset(profile.id, creditId, redeemRequestId);
}

export async function runAgentPrompt(
  prompt: string,
  sessionId?: string,
  profileId?: string,
  attachments: CodexUploadedAttachment[] = [],
  options: {
    runId?: string;
    cwd?: string;
    injectDirectoryContext?: boolean;
    executionConfig?: CodexExecutionConfig | null;
    actionRestriction?: CodexSessionActionRestriction | null;
    browserMode?: CodexSessionBrowserMode | null;
    browserModeProfileId?: string | null;
    browserModeSessionKey?: string | null;
    personalChromeMode?: CodexSessionPersonalChromeMode | null;
    personalChromeModeProfileId?: string | null;
    personalChromeModeSessionKey?: string | null;
    phoneMode?: CodexSessionPhoneMode | null;
    phoneModeProfileId?: string | null;
    phoneModeSessionKey?: string | null;
    designMode?: CodexSessionDesignMode | null;
    designModeProfileId?: string | null;
    designModeSessionKey?: string | null;
    uxMode?: CodexSessionUxMode | null;
    uxModeProfileId?: string | null;
    uxModeSessionKey?: string | null;
    onSessionStarted?: ProviderSessionStartedHandler;
    finalNotification?: {
      profileId?: string | null;
      sessionKey?: string | null;
      dedupeKey?: string | null;
      deferUntilQueueTerminal?: boolean;
    };
  } = {}
): Promise<AgentRunResult> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  const resolvedCwd = options.cwd || (
    sessionId
      ? (await getAgentSessionDetail(sessionId, profile.id, { tail: 1 }).catch(() => null))?.cwd || profile.workspaceCwd
      : profile.workspaceCwd
  );
  const beforeDetail = sessionId
    ? await getAgentSessionDetail(sessionId, profile.id, { tail: 80 }).catch(() => null)
    : null;
  const baselineEntryIds = new Set(beforeDetail?.timeline.map((entry) => entry.id) || []);
  const capture = await beginSessionChangeCapture({
    provider: profile.provider,
    profileId: profile.id,
    cwd: resolvedCwd,
    captureWholeRepo: options.actionRestriction?.enabled === true,
  }).catch(() => null);
  let startedSessionId = sessionId?.trim() || null;
  const providerRunOptions = {
    ...options,
    cwd: resolvedCwd,
    onSessionStarted: async (nextSessionId: string) => {
      startedSessionId = nextSessionId;
      await options.onSessionStarted?.(nextSessionId);
    },
  };

  try {
    let result: Pick<AgentRunResult, 'sessionId' | 'finalMessage'>;
    if (profile.provider === 'claude') {
      result = await runClaudePrompt(prompt, sessionId, profile.id, attachments, providerRunOptions);
    } else if (profile.provider === 'gemini') {
      result = await runGeminiPrompt(prompt, sessionId, profile.id, attachments, providerRunOptions);
    } else {
      result = await runCodexPrompt(prompt, sessionId, profile.id, attachments, providerRunOptions);
    }

    const afterDetail = await getAgentSessionDetail(result.sessionId, profile.id, { tail: 160 }).catch(() => null);
    const entryId = afterDetail ? resolveLatestAssistantEntryId(afterDetail, baselineEntryIds) : null;
    const changeRecord = await finalizeSessionChangeCapture(capture, {
      sessionId: result.sessionId,
      entryId,
    }, {
      cleanup: false,
    }).catch(() => null);

    const violations = await enforceSessionActionRestriction(
      capture,
      changeRecord,
      options.actionRestriction || null,
    ).catch(() => []);
    if (violations.length > 0 && options.actionRestriction?.enabled) {
      throw new SessionActionRestrictionViolationError(options.actionRestriction, violations);
    }

    await discardSessionChangeCapture(capture);

    if (!options.finalNotification?.deferUntilQueueTerminal) {
      const notificationProfileId = options.finalNotification?.profileId?.trim()
        || options.browserModeProfileId?.trim()
        || options.personalChromeModeProfileId?.trim()
        || options.phoneModeProfileId?.trim()
        || options.designModeProfileId?.trim()
        || options.uxModeProfileId?.trim()
        || profile.id;
      const notificationSessionKey = options.finalNotification?.sessionKey?.trim()
        || options.browserModeSessionKey?.trim()
        || options.personalChromeModeSessionKey?.trim()
        || options.phoneModeSessionKey?.trim()
        || options.designModeSessionKey?.trim()
        || options.uxModeSessionKey?.trim()
        || sessionId
        || result.sessionId;
      await enqueueFinalResponseNotification({
        profileId: notificationProfileId,
        preferenceSessionKey: notificationSessionKey,
        sessionId: result.sessionId,
        sessionTitle: afterDetail?.title || null,
        provider: profile.provider,
        finalMessage: result.finalMessage,
        dedupeKey: options.finalNotification?.dedupeKey?.trim()
          || options.runId?.trim()
          || entryId,
      }).catch((notificationError) => {
        console.error('❌ Failed to enqueue final-response notification:', notificationError);
      });
    }

    return {
      ...result,
      sessionTitle: afterDetail?.title || null,
    };
  } catch (error) {
    await discardSessionChangeCapture(capture);
    if (!options.finalNotification?.deferUntilQueueTerminal) {
      const notificationProfileId = options.finalNotification?.profileId?.trim()
        || options.browserModeProfileId?.trim()
        || options.personalChromeModeProfileId?.trim()
        || options.phoneModeProfileId?.trim()
        || options.designModeProfileId?.trim()
        || options.uxModeProfileId?.trim()
        || profile.id;
      const notificationSessionKey = options.finalNotification?.sessionKey?.trim()
        || options.browserModeSessionKey?.trim()
        || options.personalChromeModeSessionKey?.trim()
        || options.phoneModeSessionKey?.trim()
        || options.designModeSessionKey?.trim()
        || options.uxModeSessionKey?.trim()
        || sessionId
        || startedSessionId;
      const notificationSessionId = startedSessionId || sessionId || notificationSessionKey;
      if (notificationSessionKey && notificationSessionId) {
        const notificationDetail = startedSessionId
          ? await getAgentSessionDetail(startedSessionId, profile.id, { tail: 1 }).catch(() => null)
          : null;
        await enqueueSessionOutcomeNotification({
          profileId: notificationProfileId,
          preferenceSessionKey: notificationSessionKey,
          sessionId: notificationSessionId,
          sessionTitle: notificationDetail?.title || null,
          provider: profile.provider,
          outcome: classifyFailedRunNotificationOutcome(error),
          reason: error instanceof Error ? error.message : String(error || 'Unknown provider failure'),
          dedupeKey: options.finalNotification?.dedupeKey?.trim()
            || options.runId?.trim(),
        }).catch((notificationError) => {
          console.error('❌ Failed to enqueue interrupted-run notification:', notificationError);
        });
      }
    }
    throw error;
  }
}

export async function createAgentForkSession(
  sourceSessionId: string,
  forkEntryId: string,
  profileId?: string
): Promise<{
  sessionId: string;
  forkedAt: string;
}> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);
  if (profile.provider === 'claude') {
    return createClaudeForkSession(sourceSessionId, forkEntryId, profile.id);
  }
  if (profile.provider === 'gemini') {
    return createGeminiForkSession(sourceSessionId, forkEntryId, profile.id);
  }

  return createCodexForkSession(sourceSessionId, forkEntryId, profile.id);
}

export function cancelAgentRun(runId: string, profileId?: string): boolean {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return cancelClaudeRun(runId);
  }
  if (profile.provider === 'gemini') {
    return cancelGeminiRun(runId);
  }

  return cancelCodexRun(runId);
}

export function isAgentRunCancelledError(error: unknown): boolean {
  return error instanceof CodexRunCancelledError
    || error instanceof ClaudeRunCancelledError
    || error instanceof GeminiRunCancelledError;
}

export async function getAgentSessionChangeRecord(
  sessionId: string,
  entryId: string,
  profileId?: string
): Promise<SessionChangeRecord | null> {
  const storedRecord = await readSessionChangeRecord(sessionId, entryId);
  if (storedRecord) {
    return storedRecord;
  }

  if (!profileId) {
    return null;
  }

  const profile = resolveProfile(profileId);
  const detail = await getAgentSessionDetail(sessionId, profile.id, { full: true }).catch(() => null);
  if (!detail) {
    return null;
  }

  return deriveSessionChangeRecordFromTimeline({
    sessionId,
    entryId,
    provider: profile.provider,
    profileId: profile.id,
    cwd: detail.cwd,
    timeline: detail.timeline,
  });
}

export async function deleteAgentSession(
  sessionId: string,
  profileId?: string
): Promise<void> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);

  if (profile.provider === 'claude') {
    await deleteClaudeSession(sessionId, profile.id);
    return;
  }

  if (profile.provider === 'gemini') {
    await deleteGeminiSession(sessionId, profile.id);
    return;
  }

  await deleteCodexSession(sessionId, profile.id);
}

export async function deleteAgentTurn(
  sessionId: string,
  entryId: string,
  profileId?: string
): Promise<void> {
  const profile = resolveProfile(profileId);
  await prepareInternalProfileHome(profile);

  if (profile.provider === 'claude') {
    await deleteClaudeTurn(sessionId, entryId, profile.id);
    return;
  }

  if (profile.provider === 'gemini') {
    await deleteGeminiTurn(sessionId, entryId, profile.id);
    return;
  }

  await deleteCodexTurn(sessionId, entryId, profile.id);
}
