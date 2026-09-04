import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { clearCodexAccountUsageCache, type CodexAccountUsageProfile } from './codexAccountUsage.js';
import {
  getProviderProcessSpawnOptions,
  terminateProviderProcessTree,
} from './providerProcessLifecycle.js';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEVICE_AUTH_LIFETIME_MS = 15 * 60 * 1_000;
const TERMINAL_FLOW_RETENTION_MS = 30 * 60 * 1_000;
const MAX_CAPTURED_OUTPUT = 64 * 1_024;

export type CodexDeviceAuthState =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'authenticated'
  | 'failed'
  | 'cancelled';

export interface CodexDeviceAuthSnapshot {
  state: CodexDeviceAuthState;
  flowId: string | null;
  profileId: string;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  error: string | null;
}

interface ActiveCodexDeviceAuthFlow extends CodexDeviceAuthSnapshot {
  codexHomeKey: string;
  child: ChildProcess | null;
  output: string;
  expiryTimer: NodeJS.Timeout | null;
  retentionTimer: NodeJS.Timeout | null;
}

interface ParsedDeviceAuthPrompt {
  verificationUrl: string | null;
  userCode: string | null;
}

const activeFlows = new Map<string, ActiveCodexDeviceAuthFlow>();

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeCapturedOutput(value: string): string {
  return stripAnsi(value).replace(/\r/g, '').slice(-MAX_CAPTURED_OUTPUT);
}

export function parseCodexDeviceAuthOutput(value: string): ParsedDeviceAuthPrompt {
  const normalized = normalizeCapturedOutput(value);
  const urls = normalized.match(/https?:\/\/[^\s<>"']+/giu) || [];
  const verificationUrl = urls
    .map((candidate) => candidate.replace(/[),.;]+$/u, ''))
    .find((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(parsed.hostname);
      } catch {
        return false;
      }
    }) || null;

  const codeMatch = normalized.match(/\b[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+\b/u);
  return {
    verificationUrl,
    userCode: codeMatch?.[0] || null,
  };
}

function buildCodexAuthEnv(profile: CodexAccountUsageProfile): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.dirname(profile.codexHome),
    CODEX_HOME: profile.codexHome,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
  };
}

function getCodexHomeKey(profile: CodexAccountUsageProfile): string {
  return path.resolve(profile.codexHome);
}

function publicSnapshot(flow: ActiveCodexDeviceAuthFlow): CodexDeviceAuthSnapshot {
  return {
    state: flow.state,
    flowId: flow.flowId,
    profileId: flow.profileId,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
    completedAt: flow.completedAt,
    error: flow.error,
  };
}

function idleSnapshot(profileId: string): CodexDeviceAuthSnapshot {
  return {
    state: 'idle',
    flowId: null,
    profileId,
    verificationUrl: null,
    userCode: null,
    startedAt: null,
    expiresAt: null,
    completedAt: null,
    error: null,
  };
}

function clearFlowTimers(flow: ActiveCodexDeviceAuthFlow): void {
  if (flow.expiryTimer) {
    clearTimeout(flow.expiryTimer);
    flow.expiryTimer = null;
  }
  if (flow.retentionTimer) {
    clearTimeout(flow.retentionTimer);
    flow.retentionTimer = null;
  }
}

function scheduleTerminalFlowRemoval(flow: ActiveCodexDeviceAuthFlow): void {
  if (flow.retentionTimer) {
    clearTimeout(flow.retentionTimer);
  }
  flow.retentionTimer = setTimeout(() => {
    if (activeFlows.get(flow.codexHomeKey)?.flowId === flow.flowId) {
      activeFlows.delete(flow.codexHomeKey);
    }
  }, TERMINAL_FLOW_RETENTION_MS);
  flow.retentionTimer.unref();
}

function finishFlow(
  flow: ActiveCodexDeviceAuthFlow,
  state: Extract<CodexDeviceAuthState, 'authenticated' | 'failed' | 'cancelled'>,
  error: string | null = null
): void {
  if (flow.state === 'authenticated' || flow.state === 'failed' || flow.state === 'cancelled') {
    return;
  }
  if (flow.expiryTimer) {
    clearTimeout(flow.expiryTimer);
    flow.expiryTimer = null;
  }
  flow.state = state;
  flow.completedAt = new Date().toISOString();
  flow.error = error;
  flow.child = null;
  if (state === 'authenticated') {
    clearCodexAccountUsageCache({ id: flow.profileId, codexHome: flow.codexHomeKey });
  }
  scheduleTerminalFlowRemoval(flow);
}

function describeLoginFailure(output: string, exitCode: number | null): string {
  const normalized = normalizeCapturedOutput(output);
  const errorLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => /error|failed|disabled|timed out|not available/iu.test(line));
  if (errorLine) {
    return errorLine.slice(0, 500);
  }
  return exitCode === null
    ? 'תהליך ההתחברות ל־Codex נסגר לפני שהושלם.'
    : `תהליך ההתחברות ל־Codex הסתיים בקוד ${exitCode}.`;
}

function captureFlowOutput(flow: ActiveCodexDeviceAuthFlow, chunk: Buffer | string): void {
  flow.output = normalizeCapturedOutput(`${flow.output}${String(chunk)}`);
  const parsed = parseCodexDeviceAuthOutput(flow.output);
  if (parsed.verificationUrl) {
    flow.verificationUrl = parsed.verificationUrl;
  }
  if (parsed.userCode) {
    flow.userCode = parsed.userCode;
  }
  if (flow.verificationUrl && flow.userCode && flow.state === 'starting') {
    flow.state = 'waiting';
  }
}

export function getCodexDeviceAuthStatus(profile: CodexAccountUsageProfile): CodexDeviceAuthSnapshot {
  const flow = activeFlows.get(getCodexHomeKey(profile));
  return flow ? publicSnapshot(flow) : idleSnapshot(profile.id);
}

export function startCodexDeviceAuth(profile: CodexAccountUsageProfile): CodexDeviceAuthSnapshot {
  const codexHomeKey = getCodexHomeKey(profile);
  const existing = activeFlows.get(codexHomeKey);
  if (existing && (existing.state === 'starting' || existing.state === 'waiting')) {
    return publicSnapshot(existing);
  }
  if (existing) {
    clearFlowTimers(existing);
  }

  const startedAtMs = Date.now();
  const flow: ActiveCodexDeviceAuthFlow = {
    ...idleSnapshot(profile.id),
    state: 'starting',
    flowId: randomUUID(),
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + DEVICE_AUTH_LIFETIME_MS).toISOString(),
    codexHomeKey,
    child: null,
    output: '',
    expiryTimer: null,
    retentionTimer: null,
  };
  activeFlows.set(codexHomeKey, flow);

  try {
    const child = spawn(CODEX_BIN, ['login', '--device-auth'], {
      cwd: profile.codexHome,
      env: buildCodexAuthEnv(profile),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...getProviderProcessSpawnOptions(),
    });
    flow.child = child;
    child.stdout.on('data', (chunk) => captureFlowOutput(flow, chunk));
    child.stderr.on('data', (chunk) => captureFlowOutput(flow, chunk));
    child.once('error', (error) => {
      finishFlow(flow, 'failed', `לא ניתן להפעיל את Codex: ${error.message}`);
    });
    child.once('close', (code) => {
      if (flow.state === 'cancelled' || flow.state === 'failed') {
        return;
      }
      if (code === 0) {
        finishFlow(flow, 'authenticated');
        return;
      }
      finishFlow(flow, 'failed', describeLoginFailure(flow.output, code));
    });
  } catch (error: any) {
    finishFlow(flow, 'failed', `לא ניתן להפעיל את Codex: ${error?.message || 'שגיאה לא ידועה'}`);
  }

  flow.expiryTimer = setTimeout(() => {
    if (flow.state !== 'starting' && flow.state !== 'waiting') {
      return;
    }
    if (flow.child) {
      terminateProviderProcessTree(flow.child);
    }
    finishFlow(flow, 'failed', 'קוד המכשיר פג תוקף. אפשר להתחיל התחברות חדשה.');
  }, DEVICE_AUTH_LIFETIME_MS + 5_000);
  flow.expiryTimer.unref();
  return publicSnapshot(flow);
}

export function cancelCodexDeviceAuth(
  profile: CodexAccountUsageProfile,
  flowId?: string | null
): CodexDeviceAuthSnapshot {
  const flow = activeFlows.get(getCodexHomeKey(profile));
  if (!flow) {
    return idleSnapshot(profile.id);
  }
  if (flowId?.trim() && flow.flowId !== flowId.trim()) {
    throw new Error('ניסיון ההתחברות השתנה; רענן את החלונית ונסה שוב.');
  }
  if (flow.state === 'starting' || flow.state === 'waiting') {
    const child = flow.child;
    finishFlow(flow, 'cancelled');
    if (child) {
      terminateProviderProcessTree(child);
    }
  }
  return publicSnapshot(flow);
}

async function runCodexLogout(profile: CodexAccountUsageProfile): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(CODEX_BIN, ['logout'], {
      cwd: profile.codexHome,
      env: buildCodexAuthEnv(profile),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...getProviderProcessSpawnOptions(),
    });
    const capture = (chunk: Buffer | string) => {
      output = normalizeCapturedOutput(`${output}${String(chunk)}`);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateProviderProcessTree(child);
      reject(new Error('פג זמן ההמתנה לניתוק חשבון Codex.'));
    }, 20_000);
    timeout.unref();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`לא ניתן להפעיל את Codex: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(describeLoginFailure(output, code)));
    });
  });
}

export async function disconnectCodexAccount(profile: CodexAccountUsageProfile): Promise<void> {
  cancelCodexDeviceAuth(profile);
  await runCodexLogout(profile);
  const codexHomeKey = getCodexHomeKey(profile);
  const existing = activeFlows.get(codexHomeKey);
  if (existing) {
    clearFlowTimers(existing);
    activeFlows.delete(codexHomeKey);
  }
  clearCodexAccountUsageCache(profile);
}

process.once('exit', () => {
  for (const flow of activeFlows.values()) {
    if (flow.child && (flow.state === 'starting' || flow.state === 'waiting')) {
      try {
        flow.child.kill('SIGTERM');
      } catch {
        // The process is already gone.
      }
    }
  }
});
