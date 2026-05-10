import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import {
  cancelCodexRun,
  createCodexForkSession,
  getAvailableProfiles as getAvailableCodexProfiles,
  getCodexModelCatalog,
  getCodexRateLimitSnapshot,
  getCodexSessionDetail,
  listCodexSessions,
  resolveCodexProfile,
  runCodexPrompt,
  type CodexExecutionConfig,
  type CodexModelCatalog,
  type CodexProfile,
  type CodexRateLimitSnapshot,
  type CodexSessionDetail,
  type CodexSessionSummary,
  type CodexUploadedAttachment,
} from './codexService.js';
import {
  cancelClaudeRun,
  createClaudeForkSession,
  getAvailableClaudeProfiles,
  getClaudeModelCatalog,
  getClaudeRateLimitSnapshot,
  getClaudeSessionDetail,
  listClaudeSessions,
  resolveClaudeProfile,
  runClaudePrompt,
  ClaudeRunCancelledError,
} from './claudeService.js';
import {
  cancelGeminiRun,
  createGeminiForkSession,
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

export type AgentProfile = CodexProfile;

export interface AgentRunResult {
  sessionId: string;
  finalMessage: string;
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

export async function getAvailableProfiles(): Promise<AgentProfile[]> {
  const [codexProfiles, claudeProfiles, geminiProfiles] = await Promise.all([
    getAvailableCodexProfiles(),
    getAvailableClaudeProfiles(),
    getAvailableGeminiProfiles(),
  ]);

  return [...codexProfiles, ...claudeProfiles, ...geminiProfiles];
}

export async function listAgentSessions(
  profileId?: string,
  query?: string,
  limit?: number
): Promise<CodexSessionSummary[]> {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return listClaudeSessions(profile.id, query, limit);
  }
  if (profile.provider === 'gemini') {
    return listGeminiSessions(profile.id, query, limit);
  }

  return listCodexSessions(profile.id, query, limit);
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
  if (profile.provider === 'claude') {
    return getClaudeSessionDetail(sessionId, profile.id, options);
  }
  if (profile.provider === 'gemini') {
    return getGeminiSessionDetail(sessionId, profile.id, options);
  }

  return getCodexSessionDetail(sessionId, profile.id, options);
}

export async function getAgentModelCatalog(profileId?: string): Promise<CodexModelCatalog> {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return getClaudeModelCatalog(profile.id);
  }
  if (profile.provider === 'gemini') {
    return getGeminiModelCatalog(profile.id);
  }

  return getCodexModelCatalog(profile.id);
}

export async function getAgentRateLimitSnapshot(
  profileId?: string,
  sessionId?: string
): Promise<CodexRateLimitSnapshot | null> {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return getClaudeRateLimitSnapshot(profile.id, sessionId);
  }
  if (profile.provider === 'gemini') {
    return getGeminiRateLimitSnapshot(profile.id, sessionId);
  }

  return getCodexRateLimitSnapshot(profile.id, sessionId);
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
  } = {}
): Promise<AgentRunResult> {
  const profile = resolveProfile(profileId);
  if (profile.provider === 'claude') {
    return runClaudePrompt(prompt, sessionId, profile.id, attachments, options);
  }
  if (profile.provider === 'gemini') {
    return runGeminiPrompt(prompt, sessionId, profile.id, attachments, options);
  }

  return runCodexPrompt(prompt, sessionId, profile.id, attachments, options);
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
