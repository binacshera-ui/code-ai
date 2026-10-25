import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  codexUserInputRegistry,
  type CodexRpcRequestId,
  type CodexUserInputRegistry,
  type CodexUserInputScope,
} from './codexUserInput.js';
import { getProviderProcessSpawnOptions, terminateProviderProcessTree } from './providerProcessLifecycle.js';
import { readSharedHistoryTurns } from './codexSharedHistory.js';
import { NATIVE_FRAME_BYTES } from './codexNativeTransport.mjs';
import { nativeRpcTimeoutMs, publicRpcDiagnostic, validatePublicRpcDiagnostic } from './codexRpcDiagnostic.mjs';
import { CodexAppServerTurnFailedError, codexNativeTurnFailure } from './codexNativeTurnOutcome.mjs';
import { normalizeCodexModelRetry, type CodexModelRetry } from '../shared/codexModelRetry.js';
import { createCodexProgressGuard } from './codexProgressGuard.mjs';
export { CodexAppServerTurnFailedError, isCodexAppServerTurnFailedError } from './codexNativeTurnOutcome.mjs';

export interface CodexProgressGuardClaim {
  kind: 'repeated_failure';
  fingerprint: string;
  count: number;
  turnId: string;
}

export interface CodexProgressGuardWarning extends CodexProgressGuardClaim {
  intervention: 'applied' | 'unavailable';
}

/** Protocol fields taken from codex-cli 0.160.1 app-server generate-ts. */
export interface CodexAppServerThreadOptions {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | {
    granular: { sandbox_approval: boolean; rules: boolean; skill_approval: boolean; request_permissions: boolean; mcp_elicitations: boolean };
  };
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  config?: Record<string, unknown>;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}

export interface CodexAppServerTurnOptions {
  model?: string | null;
  serviceTier?: string | null;
  effort?: string;
  summary?: 'auto' | 'concise' | 'detailed' | 'none';
}

export interface CodexAppServerRunOptions {
  bin: string;
  /** Complete app-server invocation, including externally prepared -c overrides. */
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawnOptions?: Pick<SpawnOptionsWithoutStdio, 'uid' | 'gid' | 'detached' | 'windowsHide'>;
  profileId: string;
  runId: string;
  sessionId?: string;
  prompt: string;
  imagePaths?: string[];
  threadOptions?: CodexAppServerThreadOptions;
  turnOptions?: CodexAppServerTurnOptions;
  /** Awaited before turn/start so queue ownership exists before the first question. */
  onSessionStarted?: (sessionId: string) => void | Promise<void>;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  /** Intended for status/deltas only; server request payloads are never forwarded. */
  onNotification?: (method: string, params: unknown) => void;
  onApprovalDenied?: (method: string) => void;
  /** Opt-in only: diagnose repeated owned tool failures, never infer from prose. */
  progressGuardEnabled?: boolean;
  /** Durable one-use claim BEFORE steering; survives reconnecting this adapter. */
  onProgressGuardClaim?: (warning: CodexProgressGuardClaim) => Promise<boolean>;
  onProgressGuardWarning?: (warning: CodexProgressGuardWarning) => Promise<void>;
  /** Only the durable queue owner can opt in to bounded model retries. */
  modelRetry?: CodexModelRetry | null;
  onModelRetry?: (retry: CodexModelRetry | null) => Promise<void>;
  readModelRetry?: (threadId: string, turnId: string) => Promise<{turnId: string; kind: 'rate_limit' | 'model_capacity'; observedAt: string} | null>;
  signal?: AbortSignal;
  registry?: CodexUserInputRegistry;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Opt-in only after desktop/IDE clients have migrated to this same owner. */
  sharedTransport?: {
    socketPath: string;
    bridgePath: string;
    /** Persist this stable ID before submission. It is the native ownership proof. */
    clientUserMessageId?: string;
    resumeSubmission?: CodexSharedSubmission;
    /** Queue input inherits native thread settings; it cannot carry overrides. */
    inheritOwnerSettings?: boolean;
    /** Public native settings must match before adding any new queue input. */
    expectedOwnerSettings?: CodexSharedOwnerSettings;
    /** Requires the product broker's acknowledged atomic settings reservation. */
    managedOwner?: boolean;
    onSubmissionChanged?: (submission: CodexSharedSubmission) => void | Promise<void>;
    recoverQueuedInput?: (threadId: string, queuedSubmissionId: string, clientUserMessageId: string) => Promise<unknown>;
  };
}

/** Does not claim equivalence of private environment, MCP, or instructions. */
export interface CodexSharedOwnerSettings {
  model: string;
  modelProvider?: string;
  serviceTier?: string | null;
  cwd: string;
  approvalPolicy: NonNullable<CodexAppServerThreadOptions['approvalPolicy']>;
  sandbox: { type: 'dangerFullAccess' }
    | { type: 'readOnly'; networkAccess: boolean }
    | { type: 'externalSandbox'; networkAccess: 'enabled' | 'restricted' }
    | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean;
        excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
  reasoningEffort: string | null;
}

export interface CodexSharedSubmission {
  clientUserMessageId: string;
  queuedSubmissionId: string | null;
  turnId: string | null;
  deliveryPhase: 'prepared' | 'queued' | 'running' | 'completed' | 'cancelled' | 'detached';
}

export function isCodexSharedSubmissionTerminal(submission: CodexSharedSubmission): boolean {
  return submission.deliveryPhase === 'completed' || submission.deliveryPhase === 'cancelled';
}

export interface CodexAppServerRunResult {
  sessionId: string;
  lastMessage: string;
  threadPath: string | null;
}

export class CodexAppServerCancelledError extends Error {
  constructor() { super('Codex run was cancelled'); this.name = 'CodexAppServerCancelledError'; }
}

/** A failed sampling attempt whose native turn was CONFIRMED interrupted. */
export class CodexAppServerRetryStoppedError extends CodexAppServerTurnFailedError {
  constructor(public readonly retry: CodexModelRetry) {
    super({ codexErrorInfo: retry.kind === 'rate_limit' ? 'rateLimitExceeded' : 'serverOverloaded' });
    this.name = 'CodexAppServerRetryStoppedError';
  }
}

/** The native owner still owns accepted work; never retry it as a new prompt. */
export class CodexAppServerDetachedError extends Error {
  constructor(public readonly submission: CodexSharedSubmission) {
    super('Codex shared connection lost; accepted native work must be reconciled before retry');
    this.name = 'CodexAppServerDetachedError';
  }
}

export class CodexSharedOwnerSettingsMismatchError extends Error {
  constructor() {
    super('Shared native owner settings do not match the requested configuration; no prompt was enqueued');
    this.name = 'CodexSharedOwnerSettingsMismatchError';
  }
}

/** A qualified broker explicitly proved that no native input was accepted. */
export class CodexSharedAdmissionRejectedError extends Error {
  constructor(public readonly retryable: boolean) {
    super(retryable ? 'Shared native turn is waiting for its admission boundary; no input was accepted'
      : 'Shared native submission was refused before accepting input');
    this.name = 'CodexSharedAdmissionRejectedError';
  }
}

export function isCodexSharedOwnerSettingsMismatchError(error: unknown): error is CodexSharedOwnerSettingsMismatchError {
  return error instanceof CodexSharedOwnerSettingsMismatchError;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RpcFrame {
  id?: CodexRpcRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

class CodexRpcRejectedError extends Error {
  constructor(readonly code: number | 'unknown', readonly admission: 'notAccepted' | 'uncertain' | null = null,
    readonly retryableAdmission = false, readonly diagnostic: ReturnType<typeof validatePublicRpcDiagnostic> = null) {
    super(`Codex app-server request failed (${code})${diagnostic ? ` [${diagnostic.operation}: ${diagnostic.reason}]` : ''}`);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcId(value: unknown): value is CodexRpcRequestId {
  return (typeof value === 'string' && value.length <= 1_000) || (typeof value === 'number' && Number.isSafeInteger(value));
}

function samePublicSetting(expected: unknown, actual: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (expected === actual) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => samePublicSetting(value, actual[index], depth + 1));
  if (!object(expected) || !object(actual)) return false;
  const keys = Object.keys(expected).sort();
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key)
    && samePublicSetting(expected[key], actual[key], depth + 1));
}

function ownerSettingsMatch(expected: CodexSharedOwnerSettings, response: Record<string, unknown>): boolean {
  const required = ['model', 'cwd', 'approvalPolicy', 'sandbox', 'reasoningEffort'] as const;
  const optional = ['modelProvider', 'serviceTier'] as const;
  return required.every(key => Object.hasOwn(expected, key) && Object.hasOwn(response, key)
      && samePublicSetting(expected[key], response[key]))
    && optional.every(key => !Object.hasOwn(expected, key)
      || (Object.hasOwn(response, key) && samePublicSetting(expected[key], response[key])))
    && Object.keys(expected).every(key => [...required, ...optional].includes(key as typeof required[number]));
}

function safeSpawnErrorSuffix(error: unknown): string {
  const code = object(error) ? error.code : undefined;
  const allowed = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ETXTBSY', 'ENOEXEC', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSYS']);
  return typeof code === 'string' && allowed.has(code) ? ` (${code})` : '';
}

/**
 * One client per queued turn. By default it owns an isolated native process;
 * opt-in shared transport owns only a disposable adapter, never the daemon.
 * Answering a server request does not enqueue another user turn.
 */
export async function runCodexAppServerTurn(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult> {
  if (!options.args.includes('app-server')) throw new Error('Codex app-server invocation is required');
  if (!options.prompt.trim()) throw new Error('Prompt must not be empty');
  if (options.signal?.aborted) {
    const recovered = options.sharedTransport?.resumeSubmission;
    if (recovered && !isCodexSharedSubmissionTerminal(recovered)) {
      throw new CodexAppServerDetachedError({ ...recovered, deliveryPhase: 'detached' });
    }
    throw new CodexAppServerCancelledError();
  }
  if (options.sharedTransport?.resumeSubmission?.deliveryPhase === 'cancelled') throw new CodexAppServerCancelledError();
  if (options.sharedTransport?.managedOwner && !options.sharedTransport.expectedOwnerSettings
      && !options.sharedTransport.resumeSubmission) {
    throw new Error('Managed native submission requires explicit per-turn settings');
  }
  if (options.sharedTransport && !options.sharedTransport.managedOwner && !options.sharedTransport.inheritOwnerSettings
      && (Object.keys(options.turnOptions ?? {}).length || Object.keys(options.threadOptions ?? {}).length
        || options.args.some(arg => arg === '-c' || arg === '--config' || arg.startsWith('--config=')))) {
    throw new Error('Shared native queue requires explicit owner-settings inheritance; per-turn configuration was not submitted');
  }
  const registry = options.registry ?? codexUserInputRegistry;
  const progressGuard = options.progressGuardEnabled ? createCodexProgressGuard() : null;
  const maxFrameBytes = options.maxFrameBytes ?? NATIVE_FRAME_BYTES;
  const child = spawn(options.sharedTransport ? process.execPath : options.bin,
    options.sharedTransport
      ? [options.sharedTransport.bridgePath, options.sharedTransport.socketPath]
      : options.args, {
    ...getProviderProcessSpawnOptions(), ...options.spawnOptions,
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let sessionId = options.sessionId?.trim() || '';
  let threadPath: string | null = null;
  let turnId = '';
  let lastMessage = '';
  let finalMessage = '';
  let nextId = 0;
  let ownTurnKnown = !options.sharedTransport;
  const clientUserMessageId = options.sharedTransport?.resumeSubmission?.clientUserMessageId
    ?? options.sharedTransport?.clientUserMessageId ?? `code-ai:${randomUUID()}`;
  let queuedSubmissionId: string | null = options.sharedTransport?.resumeSubmission?.queuedSubmissionId ?? null;
  let deliveryPhase: CodexSharedSubmission['deliveryPhase'] = options.sharedTransport?.resumeSubmission?.deliveryPhase ?? 'prepared';
  let nativeSubmissionPossible = Boolean(options.sharedTransport?.resumeSubmission);
  let aborting = false;
  let nativeCancelDeadline: ReturnType<typeof setTimeout> | null = null;
  let queuedRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let queuedRecoveryBusy = false;
  let modelRetry = normalizeCodexModelRetry(options.modelRetry);
  let retryInterruptSent = false;
  let retryProbeBusy = false;
  let retryProbe: ReturnType<typeof setInterval> | null = null;
  let lastNativeProgressAt = 0;
  let nativeProgressGeneration = 0;
  let submissionPersistence = Promise.resolve();
  const ownedChildThreads = new Set<string>();
  let reconcilingSharedSubmission = Boolean(options.sharedTransport?.resumeSubmission);
  const recoveryTerminalTurns = new Map<string, Record<string, any>>();
  let recoveryRequests: RpcFrame[] = [];
  let recoveryRequestBytes = 0;
  const recoveryResolvedRequests = new Set<string>();
  let recoveryResolvedBytes = 0;
  const unclaimedChildRequests = new Map<string, RpcFrame[]>();
  let unclaimedChildBytes = 0;
  let buffer = '';
  let stopped = false;
  let cancelled = false;
  let failure: Error | null = null;
  const pending = new Map<string, PendingCall>();
  let resolveCompletion!: (result: CodexAppServerRunResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<CodexAppServerRunResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A failure can arrive during initialization before lifecycle awaits completion.
  void completion.catch(() => undefined);

  function scope(): CodexUserInputScope {
    return { profileId: options.profileId, sessionId, runId: options.runId };
  }

  function submission(): CodexSharedSubmission {
    return { clientUserMessageId, queuedSubmissionId, turnId: turnId || null, deliveryPhase };
  }

  function persistSubmission(): Promise<void> {
    const metadata = submission();
    submissionPersistence = submissionPersistence.then(() => options.sharedTransport?.onSubmissionChanged?.(metadata));
    return submissionPersistence;
  }

  function stop(error?: Error, result?: CodexAppServerRunResult): void {
    if (stopped) return;
    if (queuedRecoveryTimer) clearTimeout(queuedRecoveryTimer);
    if (retryProbe) clearInterval(retryProbe);
    if (options.sharedTransport && nativeSubmissionPossible && error && !(error instanceof CodexAppServerCancelledError)) {
      deliveryPhase = 'detached';
      error = new CodexAppServerDetachedError(submission());
      void persistSubmission().catch(() => undefined);
    } else if (options.sharedTransport && result) {
      deliveryPhase = 'completed';
      void persistSubmission().catch(() => undefined);
    }
    stopped = true;
    failure = error ?? null;
    options.signal?.removeEventListener('abort', abort);
    if (nativeCancelDeadline) clearTimeout(nativeCancelDeadline);
    registry.clearRun(options.runId, cancelled ? 'cancelled' : error ? 'failed' : 'expired',
      cancelled ? 'run_cancelled' : error instanceof CodexAppServerDetachedError ? 'native_detached'
        : error ? 'provider_failed' : 'turn_completed', options.profileId);
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error ?? new Error('Codex app-server connection closed'));
    }
    pending.clear();
    // Never retain diagnostic stdout/stderr: native requests may contain secrets.
    buffer = '';
    unclaimedChildRequests.clear();
    unclaimedChildBytes = 0;
    recoveryRequests = [];
    recoveryTerminalTurns.clear();
    recoveryRequestBytes = 0;
    recoveryResolvedRequests.clear();
    recoveryResolvedBytes = 0;
    child.stdin.end();
    if (error) {
      terminateProviderProcessTree(child);
      void submissionPersistence.then(() => rejectCompletion(error), () => rejectCompletion(new CodexAppServerDetachedError(submission())));
    } else if (result) {
      // EOF lets native session writers flush before queue completion is reported.
      // Process cleanup is not the turn outcome: turn/completed already proved
      // success. In particular, inherited pipes can delay `close` after exit.
      const finishCleanup = () => {
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        child.removeListener('close', finishCleanup);
        void submissionPersistence.then(() => resolveCompletion(result), () => rejectCompletion(new CodexAppServerDetachedError(submission())));
      };
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminateProviderProcessTree(child, 500);
      }, 3_000);
      const deadline = setTimeout(() => {
        // Release only this run's disposable process/stdio handles. A shared
        // native owner is outside this child process group and stays running.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        console.warn('Codex completed turn transport cleanup exceeded its deadline; preserving completed outcome');
        finishCleanup();
      }, 5_000);
      forceTimer.unref?.();
      deadline.unref?.();
      child.once('close', finishCleanup);
    }
  }

  function interruptionOutcome(): Error {
    if (modelRetry?.turnId === turnId && !options.signal?.aborted) return new CodexAppServerRetryStoppedError(modelRetry);
    cancelled = true;
    return new CodexAppServerCancelledError();
  }

  async function interruptForModelRetry(kind: CodexModelRetry['kind']): Promise<void> {
    if (!options.onModelRetry || stopped || aborting || retryInterruptSent || !ownTurnKnown || !turnId
        || reconcilingSharedSubmission || options.signal?.aborted) return;
    retryInterruptSent = true;
    const progressBeforeClaim = nativeProgressGeneration;
    if (modelRetry?.turnId !== turnId) {
      const detectedAt = new Date().toISOString();
      modelRetry = { turnId, kind, detectedAt, retryAt: new Date(Date.parse(detectedAt) + 60_000).toISOString() };
    }
    try {
      // Persist BEFORE interruption. Lost acknowledgements reconcile the SAME
      // native turn and can never create another prompt or replace a user stop.
      await options.onModelRetry(modelRetry);
      if (stopped || options.signal?.aborted) return;
      if (nativeProgressGeneration !== progressBeforeClaim) {
        modelRetry = null; retryInterruptSent = false;
        await options.onModelRetry(null);
        return;
      }
      await request('turn/interrupt', { threadId: sessionId, turnId });
      if (!stopped) {
        nativeCancelDeadline = setTimeout(() => stop(new CodexAppServerDetachedError(submission())), options.requestTimeoutMs ?? 60_000);
        nativeCancelDeadline.unref?.();
      }
    } catch { if (!stopped) stop(new CodexAppServerDetachedError(submission())); }
  }

  async function probeModelRetry(): Promise<void> {
    if (!options.onModelRetry || stopped || aborting || retryInterruptSent || retryProbeBusy
        || !ownTurnKnown || !turnId || reconcilingSharedSubmission) return;
    if (modelRetry?.turnId === turnId) { await interruptForModelRetry(modelRetry.kind); return; }
    if (!options.readModelRetry) return;
    retryProbeBusy = true;
    const expectedTurn = turnId;
    try {
      const observed = await options.readModelRetry(sessionId, expectedTurn);
      if (observed?.turnId === turnId && turnId === expectedTurn
          && Date.parse(observed.observedAt) + 1000 >= lastNativeProgressAt) await interruptForModelRetry(observed.kind);
    } finally { retryProbeBusy = false; }
  }

  function scheduleQueuedRecovery(): void {
    if (!options.sharedTransport?.recoverQueuedInput || stopped || aborting || ownTurnKnown || !queuedSubmissionId || queuedRecoveryBusy) return;
    queuedRecoveryBusy = true;
    void options.sharedTransport.recoverQueuedInput(sessionId, queuedSubmissionId, clientUserMessageId)
      .catch(() => { if (!stopped) stop(new CodexAppServerDetachedError(submission())); })
      .finally(() => {
        queuedRecoveryBusy = false;
        if (!stopped && !ownTurnKnown) {
          queuedRecoveryTimer = setTimeout(scheduleQueuedRecovery, 2000);
          queuedRecoveryTimer.unref?.();
        }
      });
  }

  function send(frame: unknown): Promise<void> {
    if (stopped || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(failure ?? new Error('Codex app-server connection closed'));
    }
    let line: string;
    try { line = JSON.stringify(frame) + '\n'; }
    catch { return Promise.reject(new Error('Invalid Codex app-server message')); }
    if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) return Promise.reject(new Error('Codex app-server message exceeds the size limit'));
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(line, error => error ? reject(new Error('Could not send Codex app-server message')) : resolve());
    });
  }

  function request(method: string, params: unknown, requestOptions?: { nonFatal?: boolean; timeoutMs?: number }): Promise<unknown> {
    if (stopped) return Promise.reject(failure ?? new Error('Codex app-server connection closed'));
    const id = `code-ai:${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Codex app-server ${method} timed out`);
        if (requestOptions?.nonFatal) {
          pending.delete(id);
          reject(error);
        } else stop(error);
      }, requestOptions?.timeoutMs ?? options.requestTimeoutMs ?? Math.max(60_000, nativeRpcTimeoutMs(method) + 30_000));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      void send({ id, method, params }).catch(error => {
        if (requestOptions?.nonFatal) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        } else stop(error);
      });
    });
  }

  function observeProgressGuard(params: Record<string, unknown>): void {
    if (!progressGuard || stopped || aborting || reconcilingSharedSubmission || !ownTurnKnown || !turnId
        || params.threadId !== sessionId || params.turnId !== turnId
        || (options.sharedTransport && deliveryPhase !== 'running')) return;
    const warning = progressGuard.observeItem(params.item);
    if (!warning) return;
    const expectedTurnId = turnId;
    const claim: CodexProgressGuardClaim = { kind: 'repeated_failure', fingerprint: warning.fingerprint,
      count: warning.count, turnId: expectedTurnId };
    void (async () => {
      let intervention: CodexProgressGuardWarning['intervention'] = 'unavailable';
      try {
        // Claim must be persisted by the queue. Missing/denied/failed claims
        // never steer; repeated events/reconnects cannot create a second nudge.
        if (await options.onProgressGuardClaim?.(claim)) {
          if (!stopped && !aborting && !reconcilingSharedSubmission && ownTurnKnown && turnId === expectedTurnId
              && (!options.sharedTransport || deliveryPhase === 'running')) {
            const result = await request('turn/steer', { threadId: sessionId, expectedTurnId,
              input: [{ type: 'text', text: warning.instruction, text_elements: [] }],
            }, { nonFatal: true, timeoutMs: options.requestTimeoutMs ?? 15_000 });
            if (object(result) && result.turnId === expectedTurnId) intervention = 'applied';
          }
        } else return;
      } catch {
        // Optional guidance is best-effort, never a reason to detach/cancel a
        // healthy native run. A lost ACK is not permission to resend the steer.
      }
      await options.onProgressGuardWarning?.({ ...claim, intervention });
    })().catch(() => undefined);
  }

  async function abortShared(): Promise<void> {
    if (aborting || stopped) return;
    aborting = true;
    try {
      // Wait for the enqueue acknowledgement: cancelling before it arrives must
      // not leave a queued input behind or guess another client's turn ID.
      while (!stopped && !queuedSubmissionId && !ownTurnKnown && nativeSubmissionPossible) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (stopped) return;
      if (!ownTurnKnown && queuedSubmissionId) {
        const deleted = await request('thread/queue/delete', { threadId: sessionId, queuedSubmissionId });
        if (object(deleted) && deleted.deleted === true) {
          nativeSubmissionPossible = false;
          deliveryPhase = 'cancelled';
          await persistSubmission();
          cancelled = true;
          stop(new CodexAppServerCancelledError());
          return;
        }
        // Auto-dispatch may have beaten deletion. Only a userMessage carrying
        // OUR client ID proves which native turn may now be interrupted.
        if (!ownTurnKnown) {
          const turns = await readSharedHistoryTurns(request, sessionId, clientUserMessageId);
          {
            for (const turn of turns) {
              if (object(turn) && typeof turn.id === 'string' && Array.isArray(turn.items)
                  && turn.items.some(item => object(item) && item.type === 'userMessage' && item.clientId === clientUserMessageId)) {
                turnId = turn.id;
                ownTurnKnown = true;
                deliveryPhase = 'running';
                await persistSubmission();
                if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
                  nativeSubmissionPossible = false;
                  deliveryPhase = turn.status === 'interrupted' ? 'cancelled' : 'completed';
                  await persistSubmission();
                  if (turn.status === 'interrupted') {
                    stop(interruptionOutcome());
                  } else if (turn.status === 'failed') stop(new CodexAppServerTurnFailedError(turn.error));
                  else {
                    let message = '', final = '';
                    for (const item of turn.items) {
                      if (object(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
                        message = item.text;
                        if (item.phase === 'final_answer') final = item.text;
                      }
                    }
                    stop(undefined, { sessionId, threadPath, lastMessage: final || message });
                  }
                  return;
                }
                break;
              }
            }
          }
        }
      }
      if (ownTurnKnown && turnId) {
        await request('turn/interrupt', { threadId: sessionId, turnId });
        // An interrupt ACK is not proof of termination. Keep native custody
        // until the own-turn terminal notification or explicit reconciliation.
        if (!stopped) {
          nativeCancelDeadline = setTimeout(() => stop(new CodexAppServerDetachedError(submission())), options.requestTimeoutMs ?? 60_000);
          nativeCancelDeadline.unref?.();
        }
      } else if (!nativeSubmissionPossible) {
        deliveryPhase = 'cancelled';
        await persistSubmission();
        cancelled = true;
        stop(new CodexAppServerCancelledError());
      } else stop(new CodexAppServerDetachedError(submission()));
    } catch {
      if (!stopped) stop(new CodexAppServerDetachedError(submission()));
    }
  }

  function abort(): void {
    if (stopped) return;
    if (options.sharedTransport) { void abortShared(); return; }
    cancelled = true;
    // Best-effort native interruption preserves the turn's native interrupted status.
    // External cancellation still owns process-tree termination as a finite fallback.
    if (sessionId && turnId) {
      void send({ id: `code-ai:interrupt:${++nextId}`, method: 'turn/interrupt', params: { threadId: sessionId, turnId } })
        .then(() => stop(new CodexAppServerCancelledError()), () => stop(new CodexAppServerCancelledError()));
      const timer = setTimeout(() => stop(new CodexAppServerCancelledError()), 500);
      timer.unref?.();
    } else stop(new CodexAppServerCancelledError());
  }

  async function handleServerRequest(frame: RpcFrame): Promise<void> {
    if (!rpcId(frame.id)) throw new Error('Invalid Codex server request ID');
    const id = frame.id;
    switch (frame.method) {
      case 'item/tool/requestUserInput':
        if (!sessionId) throw new Error('Codex requested user input before starting a session');
        {
          const params = object(frame.params) ? frame.params : {};
          const provenOwnRequest = ownTurnKnown && ((params.threadId === sessionId && params.turnId === turnId)
            || (typeof params.threadId === 'string' && ownedChildThreads.has(params.threadId)));
          registry.register(scope(), id, frame.params, response => send({ id, result: response }), {
            reattachDetached: Boolean(options.sharedTransport?.resumeSubmission && provenOwnRequest),
          });
        }
        return;
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        await send({ id, result: { decision: 'decline' } });
        options.onApprovalDenied?.(frame.method);
        return;
      case 'item/permissions/requestApproval':
        await send({ id, result: { permissions: {}, scope: 'turn' } });
        options.onApprovalDenied?.(frame.method);
        return;
      case 'execCommandApproval':
      case 'applyPatchApproval':
        await send({ id, result: { decision: { denied: { rejection: 'Approval is not available in this client.' } } } });
        options.onApprovalDenied?.(frame.method);
        return;
      case 'mcpServer/elicitation/request':
        await send({ id, result: { action: 'decline' } });
        return;
      case 'item/tool/call':
        await send({ id, result: { success: false, contentItems: [{ type: 'inputText', text: 'This client does not support dynamic tools.' }] } });
        return;
      default:
        await send({ id, error: { code: -32601, message: 'This client does not support this server request.' } });
    }
  }

  function finishSharedReconciliation(replayOwnRequests: boolean): void {
    reconcilingSharedSubmission = false;
    const requests = recoveryRequests;
    recoveryRequests = [];
    recoveryRequestBytes = 0;
    if (replayOwnRequests) for (const frame of requests) handleFrame(frame);
  }

  function recoveryRequestKey(threadId: unknown, requestId: unknown): string | null {
    return typeof threadId === 'string' && rpcId(requestId)
      ? JSON.stringify([threadId, typeof requestId, requestId]) : null;
  }

  function recordRecoveryResolution(threadId: string, requestId: CodexRpcRequestId): void {
    const key = recoveryRequestKey(threadId, requestId)!;
    if (recoveryResolvedRequests.has(key)) return;
    // A resolution may race the history proof or the parent's spawn proof.
    // Keep metadata only; never resolve an unproven foreign registry request.
    recoveryRequests = recoveryRequests.filter(frame => {
      const params = object(frame.params) ? frame.params : {};
      if (recoveryRequestKey(params.threadId, frame.id) !== key) return true;
      recoveryRequestBytes -= Buffer.byteLength(JSON.stringify(frame));
      return false;
    });
    const children = unclaimedChildRequests.get(threadId);
    if (children) {
      const remaining = children.filter(frame => {
        if (recoveryRequestKey(threadId, frame.id) !== key) return true;
        unclaimedChildBytes -= Buffer.byteLength(JSON.stringify(frame));
        return false;
      });
      if (remaining.length) unclaimedChildRequests.set(threadId, remaining);
      else unclaimedChildRequests.delete(threadId);
    }
    const bytes = Buffer.byteLength(key);
    if (recoveryResolvedRequests.size + recoveryRequests.length >= 64
        || recoveryResolvedBytes + recoveryRequestBytes + bytes > maxFrameBytes) {
      stop(new Error('Codex shared recovery resolution metadata exceeds the size limit')); return;
    }
    recoveryResolvedRequests.add(key);
    recoveryResolvedBytes += bytes;
  }

  function registerOwnedSpawn(item: Record<string, unknown>, senderThreadId: string): void {
    if (item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent' || item.senderThreadId !== senderThreadId
        || !Array.isArray(item.receiverThreadIds)) return;
    for (const id of item.receiverThreadIds) {
      if (typeof id !== 'string' || id === sessionId) continue;
      if (!ownedChildThreads.has(id) && ownedChildThreads.size >= 256) {
        stop(new Error('Codex shared child custody exceeds the size limit')); return;
      }
      ownedChildThreads.add(id);
      const waiting = unclaimedChildRequests.get(id) ?? [];
      unclaimedChildRequests.delete(id);
      for (const childFrame of waiting) {
        unclaimedChildBytes -= Buffer.byteLength(JSON.stringify(childFrame));
        handleFrame(childFrame);
      }
    }
  }

  async function recoverOwnedChildren(items: unknown[]): Promise<void> {
    for (const item of items) if (object(item)) registerOwnedSpawn(item, sessionId);
    const resumed = new Set<string>();
    for (const id of ownedChildThreads) {
      if (stopped || resumed.has(id)) continue;
      resumed.add(id);
      // Parent request replay is thread-scoped. Resume only children whose
      // native spawn item belongs to OUR proven root turn; never new threads.
      await request('thread/resume', { threadId: id, excludeTurns: true });
      if (stopped) return;
      const turns = await readSharedHistoryTurns(request, id);
      for (const turn of turns) {
        if (object(turn) && Array.isArray(turn.items)) for (const item of turn.items) {
          if (object(item)) registerOwnedSpawn(item, id);
        }
      }
    }
  }

  function handleFrame(raw: unknown): void {
    if (!object(raw)) { stop(new Error('Invalid Codex app-server frame')); return; }
    const frame = raw as RpcFrame;
    // A shared owner can publish events for the desktop client's active turn.
    // Do not adopt its turn ID, answer its questions, or cancel/complete its run.
    // The native queue is atomic start-if-idle; turn/start is NOT: it steers an
    // already-active turn. Ownership comes only from our userMessage.clientId.
    if (options.sharedTransport && typeof frame.method === 'string') {
      const params = object(frame.params) ? frame.params : {};
      const item = object(params.item) ? params.item : {};
      if (reconcilingSharedSubmission && params.threadId === sessionId && frame.method === 'turn/completed'
          && object(params.turn) && typeof params.turn.id === 'string'
          && typeof params.turn.status === 'string' && ['completed', 'failed', 'interrupted'].includes(params.turn.status)) {
        if (recoveryTerminalTurns.size >= 32) { stop(new Error('Shared reconciliation event capacity exceeded')); return; }
        // Preserve terminal metadata only; history supplies messages after exact
        // client-ID custody is proved. No foreign completion is adopted here.
        recoveryTerminalTurns.set(params.turn.id, {id:params.turn.id,status:params.turn.status,error:params.turn.error});
      }
      if (options.sharedTransport.resumeSubmission && frame.method === 'serverRequest/resolved'
          && typeof params.threadId === 'string' && rpcId(params.requestId)
          && (reconcilingSharedSubmission || params.threadId === sessionId
            || ownedChildThreads.has(params.threadId) || unclaimedChildRequests.has(params.threadId))) {
        recordRecoveryResolution(params.threadId, params.requestId);
        if (stopped) return;
      }
      const replayKey = Object.hasOwn(frame, 'id') ? recoveryRequestKey(params.threadId, frame.id) : null;
      if (replayKey && recoveryResolvedRequests.has(replayKey)) return;
      if (!ownTurnKnown && params.threadId === sessionId
          && (frame.method === 'item/started' || frame.method === 'item/completed')
          && item.type === 'userMessage' && item.clientId === clientUserMessageId
          && typeof params.turnId === 'string' && params.turnId) {
        turnId = params.turnId;
        deliveryPhase = 'running';
        ownTurnKnown = true;
        void persistSubmission().catch(() => stop(new CodexAppServerDetachedError(submission())));
        finishSharedReconciliation(true);
      }
      if (!ownTurnKnown) {
        // Resume replays unresolved native requests before history reconciliation
        // can prove our stable client ID. Retain only bounded parent requests;
        // foreign turns are never answered and are discarded after reconciliation.
        if (reconcilingSharedSubmission && Object.hasOwn(frame, 'id') && typeof params.threadId === 'string'
            && typeof params.turnId === 'string') {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (recoveryRequestBytes + recoveryResolvedBytes + bytes > maxFrameBytes
              || recoveryRequests.length + recoveryResolvedRequests.size >= 64) {
            stop(new Error('Codex shared recovery request buffer exceeds the size limit')); return;
          }
          recoveryRequestBytes += bytes;
          recoveryRequests.push(frame);
        }
        // Foreign notifications/questions can continue for hours while our
        // input waits. Do not retain their contents or answer their requests.
        return;
      }
      const eventTurnId = typeof params.turnId === 'string' ? params.turnId
        : object(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : null;
      const isOwnParent = params.threadId === sessionId && (eventTurnId === turnId
        || (eventTurnId === null && !Object.hasOwn(frame, 'id')));
      const isOwnedChild = typeof params.threadId === 'string' && ownedChildThreads.has(params.threadId);
      if (!isOwnParent && !isOwnedChild) {
        // A spawned child's request may race the parent's spawn-completed item.
        // Retain a bounded request only; never answer it until the native spawn
        // event from OUR turn proves custody. Foreign thread events are dropped.
        if (Object.hasOwn(frame, 'id') && typeof params.threadId === 'string' && params.threadId !== sessionId
            && eventTurnId !== null) {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (unclaimedChildBytes + bytes > maxFrameBytes || unclaimedChildRequests.size >= 32) {
            stop(new Error('Codex shared child request buffer exceeds the size limit')); return;
          }
          unclaimedChildBytes += bytes;
          const waiting = unclaimedChildRequests.get(params.threadId) ?? [];
          waiting.push(frame);
          unclaimedChildRequests.set(params.threadId, waiting);
        }
        return;
      }
      if (typeof params.threadId === 'string') registerOwnedSpawn(item, params.threadId);
    }
    if (typeof frame.method === 'string' && Object.hasOwn(frame, 'id')) {
      void handleServerRequest(frame).catch(error => stop(error));
      return;
    }
    if (Object.hasOwn(frame, 'id')) {
      const call = typeof frame.id === 'string' ? pending.get(frame.id) : undefined;
      if (!call) return;
      pending.delete(frame.id as string);
      clearTimeout(call.timer);
      if (frame.error) {
        // Do not include native payloads or error details that may echo secrets.
        const code = typeof frame.error.code === 'number' && Number.isInteger(frame.error.code) ? frame.error.code : 'unknown';
        const data = object(frame.error.data) ? frame.error.data : {};
        const admission = options.sharedTransport?.managedOwner
          && (data.codeAiAdmission === 'notAccepted' || data.codeAiAdmission === 'uncertain') ? data.codeAiAdmission : null;
        const retryable = admission === 'notAccepted' && typeof data.reason === 'string'
          && ['thread-admission-reserved', 'foreign-queue-pending', 'owner-settings-reserved',
            'own-turn-settings-reserved', 'reservation-journal-unavailable'].includes(data.reason);
        const diagnostic = validatePublicRpcDiagnostic(data.codeAiDiagnostic)
          ?? publicRpcDiagnostic('other', code, frame.error.message);
        call.reject(new CodexRpcRejectedError(code, admission, retryable, diagnostic));
      } else if (Object.hasOwn(frame, 'result')) call.resolve(frame.result);
      else call.reject(new Error('Invalid Codex app-server response'));
      return;
    }
    if (typeof frame.method !== 'string') { stop(new Error('Invalid Codex app-server notification')); return; }
    const params = object(frame.params) ? frame.params : {};
    if (frame.method === 'serverRequest/resolved' && typeof params.threadId === 'string' && rpcId(params.requestId)) {
      registry.resolveNative(scope(), params.requestId, params.threadId);
    }
    const ownThread = params.threadId === sessionId;
    if (ownThread && params.turnId === turnId && (frame.method.includes('/delta')
        || ['item/started','item/completed'].includes(frame.method) && object(params.item) && params.item.type !== 'userMessage')) {
      lastNativeProgressAt = Date.now();
      nativeProgressGeneration++;
    }
    if (ownThread && frame.method === 'item/completed') observeProgressGuard(params);
    if (ownThread && frame.method === 'error' && params.turnId === turnId && params.willRetry === true) {
      const failure = codexNativeTurnFailure(params.error);
      if (failure.kind === 'rate_limit' || failure.kind === 'model_capacity') void interruptForModelRetry(failure.kind);
    }
    if (ownThread && (frame.method === 'turn/started' || frame.method === 'turn/completed') && object(params.turn)
        && typeof params.turn.id === 'string') {
      if (!turnId) turnId = params.turn.id;
    }
    if (ownThread && frame.method === 'item/completed' && object(params.item)
        && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
      const text = params.item.text.trim();
      lastMessage = text;
      if (params.item.phase === 'final_answer') finalMessage = text;
    }
    if (ownThread && frame.method === 'turn/completed' && object(params.turn)
        && (!turnId || params.turn.id === turnId)) {
      nativeSubmissionPossible = false;
      if (options.sharedTransport) {
        deliveryPhase = params.turn.status === 'interrupted' ? 'cancelled' : 'completed';
        void persistSubmission().catch(() => undefined);
      }
      const status = params.turn.status;
      if (status === 'completed') {
        stop(undefined, { sessionId, lastMessage: finalMessage || lastMessage, threadPath });
      } else if (status === 'interrupted') {
        stop(interruptionOutcome());
      } else if (status === 'failed') stop(new CodexAppServerTurnFailedError(params.turn.error));
      else stop(new Error('Invalid Codex native terminal turn status'));
      return;
    }
    // A recoverable model error notification may be followed by a successful retry.
    // Only turn/completed or a transport failure decides the final outcome.
    options.onNotification?.(frame.method, frame.params);
  }

  child.stdout.setEncoding('utf8');
  child.stderr.resume();
  child.stdout.on('data', (chunk: string) => {
    if (stopped) return;
    buffer += chunk;
    let newline: number;
    while (!stopped && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) { stop(new Error('Codex app-server frame exceeds the size limit')); return; }
      if (!line.trim()) continue;
      try { handleFrame(JSON.parse(line)); }
      catch { stop(new Error('Invalid Codex app-server JSON frame')); return; }
    }
    if (!stopped && Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) stop(new Error('Codex app-server frame exceeds the size limit'));
  });
  child.on('error', error => stop(new Error('Could not start Codex app-server' + safeSpawnErrorSuffix(error))));
  child.stdin.on('error', () => { if (!stopped) stop(new Error('Codex app-server input closed')); });
  child.on('close', () => {
    if (!stopped) stop(options.sharedTransport && nativeSubmissionPossible ? new CodexAppServerDetachedError(submission())
      : cancelled ? new CodexAppServerCancelledError() : new Error('Codex app-server exited before turn completion'));
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.onModelRetry) {
    retryProbe = setInterval(() => { void probeModelRetry().catch(() => undefined); }, 5000);
    retryProbe.unref?.();
  }

  try {
    options.onSpawn?.(child);
    if (options.signal?.aborted) abort();
    const initialized = await request('initialize', {
      clientInfo: { name: 'code-ai', title: 'Code AI', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (options.sharedTransport?.managedOwner && (!object(initialized)
        || !object(initialized.codeAiSharedOwner) || initialized.codeAiSharedOwner.version !== 1
        || initialized.codeAiSharedOwner.turnSettings !== true)) {
      throw new Error('The qualified shared Codex owner is unavailable; no input was submitted');
    }
    await send({ method: 'initialized', params: {} });
    // A new managed thread has no earlier per-thread execution settings to
    // restore. Seed only its selected model/effort before admission; keep native
    // permissions and every existing thread's settings unchanged.
    const initialSharedSettings = !sessionId && options.sharedTransport?.managedOwner
      ? options.sharedTransport.expectedOwnerSettings : null;
    const threadResult = await request(sessionId ? 'thread/resume' : 'thread/start', {
      ...(!options.sharedTransport ? options.threadOptions : {}), cwd: options.cwd,
      ...(initialSharedSettings ? {
        model: initialSharedSettings.model,
        ...(initialSharedSettings.reasoningEffort ? { config: {
          model_reasoning_effort: initialSharedSettings.reasoningEffort,
        } } : {}),
      } : {}),
      ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false }),
    });
    if (!object(threadResult) || !object(threadResult.thread) || typeof threadResult.thread.id !== 'string'
        || !threadResult.thread.id.trim()) throw new Error('Codex app-server did not return a thread ID');
    sessionId = threadResult.thread.id;
    threadPath = typeof threadResult.thread.path === 'string' ? threadResult.thread.path : null;
    await options.onSessionStarted?.(sessionId);
    if (options.sharedTransport?.expectedOwnerSettings && !options.sharedTransport.managedOwner && !options.sharedTransport.resumeSubmission
        && !ownerSettingsMatch(options.sharedTransport.expectedOwnerSettings, threadResult)) {
      throw new CodexSharedOwnerSettingsMismatchError();
    }
    if (options.signal?.aborted) { abort(); return await completion; }
    if (options.sharedTransport) {
      if (options.sharedTransport.resumeSubmission) {
        nativeSubmissionPossible = true;
        // Reconnection is custody transfer, never a blind resend. Reconcile the
        // stable client ID against native durable history and the native queue.
        // Pending custody is cheap to prove even for a very large old thread.
        if (!options.sharedTransport.resumeSubmission.turnId) {
          const queue = await request('thread/queue/list', { threadId: sessionId, limit: 100 });
          const pendingOwn = object(queue) && Array.isArray(queue.data)
            ? queue.data.find(item => object(item) && item.clientUserMessageId === clientUserMessageId) : null;
          if (object(pendingOwn) && typeof pendingOwn.id === 'string') {
            queuedSubmissionId = pendingOwn.id; deliveryPhase = 'queued';
            await persistSubmission(); finishSharedReconciliation(false); scheduleQueuedRecovery();
            return await completion;
          }
        }
        const recoveredTurns = await readSharedHistoryTurns(request, sessionId, clientUserMessageId,
          options.sharedTransport.resumeSubmission.turnId || undefined);
        for (const turn of recoveredTurns) {
          if (!object(turn) || typeof turn.id !== 'string' || !Array.isArray(turn.items)
              || !turn.items.some(item => object(item) && item.type === 'userMessage' && item.clientId === clientUserMessageId)) continue;
          const terminal = recoveryTerminalTurns.get(turn.id);
          if (terminal) Object.assign(turn, terminal);
          turnId = turn.id;
          ownTurnKnown = true;
          deliveryPhase = 'running';
          for (const item of turn.items) if (object(item)) registerOwnedSpawn(item, sessionId);
          await persistSubmission();
          finishSharedReconciliation(turn.status !== 'completed' && turn.status !== 'interrupted' && turn.status !== 'failed');
          if (turn.status === 'completed') {
            let message = '';
            let final = '';
            for (const item of turn.items) {
              if (object(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
                message = item.text;
                if (item.phase === 'final_answer') final = item.text;
              }
            }
            stop(undefined, { sessionId, threadPath, lastMessage: final || message });
          } else if (turn.status === 'interrupted') {
            nativeSubmissionPossible = false;
            deliveryPhase = 'cancelled';
            await persistSubmission();
            stop(interruptionOutcome());
          } else if (turn.status === 'failed') {
            nativeSubmissionPossible = false;
            deliveryPhase = 'completed';
            await persistSubmission();
            throw new CodexAppServerTurnFailedError(turn.error, true);
          }
          if (!stopped) await probeModelRetry();
          if (!stopped) await recoverOwnedChildren(turn.items);
          return await completion;
        }
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const list = await request('thread/queue/list', { threadId: sessionId, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!object(list) || !Array.isArray(list.data)) throw new CodexAppServerDetachedError(submission());
          const queued = list.data.find(item => object(item) && item.clientUserMessageId === clientUserMessageId);
          if (object(queued) && typeof queued.id === 'string') {
            queuedSubmissionId = queued.id;
            deliveryPhase = 'queued';
            await persistSubmission();
            finishSharedReconciliation(false);
            scheduleQueuedRecovery();
            return await completion;
          }
          if (typeof list.nextCursor !== 'string' || !list.nextCursor) break;
          cursor = list.nextCursor;
        }
        // An enqueue acknowledgement can be lost while auto-dispatch is between
        // dequeue and history notification. Absence is not proof of no delivery.
        throw new CodexAppServerDetachedError(submission());
      }
      await persistSubmission();
      nativeSubmissionPossible = true;
      let queued: unknown;
      try {
        queued = await request('thread/queue/add', {
          threadId: sessionId, clientUserMessageId,
          ...(options.sharedTransport.managedOwner && options.sharedTransport.expectedOwnerSettings ? {
            codeAiExpectedCollaborationMode: 'default',
            codeAiTurnSettings: {
              model: options.sharedTransport.expectedOwnerSettings.model,
              effort: options.sharedTransport.expectedOwnerSettings.reasoningEffort,
              cwd: options.sharedTransport.expectedOwnerSettings.cwd,
              approvalPolicy: options.sharedTransport.expectedOwnerSettings.approvalPolicy,
              sandboxPolicy: options.sharedTransport.expectedOwnerSettings.sandbox,
            },
          } : {}),
          input: [
            { type: 'text', text: options.prompt, text_elements: [] },
            ...(options.imagePaths ?? []).map(imagePath => ({ type: 'localImage', path: imagePath })),
          ],
        });
      } catch (error) {
        if (error instanceof CodexRpcRejectedError) {
          if (!options.sharedTransport.managedOwner || error.admission === 'notAccepted') {
            nativeSubmissionPossible = false;
          }
          if (options.sharedTransport.managedOwner && error.admission === 'notAccepted') {
            throw new CodexSharedAdmissionRejectedError(error.retryableAdmission);
          }
        }
        throw error;
      }
      if (!object(queued) || !object(queued.queuedSubmission) || typeof queued.queuedSubmission.id !== 'string'
          || queued.queuedSubmission.clientUserMessageId !== clientUserMessageId) {
        throw new CodexAppServerDetachedError(submission());
      }
      queuedSubmissionId = queued.queuedSubmission.id;
      if (!ownTurnKnown) deliveryPhase = 'queued';
      await persistSubmission();
      // Enqueue may stay paused after interruption. Recover only this reserved
      // input via native's atomic idle-only start; never resend or steer.
      scheduleQueuedRecovery();
      return await completion;
    }
    const turnResult = await request('turn/start', {
      ...options.turnOptions, threadId: sessionId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...(options.imagePaths ?? []).map(imagePath => ({ type: 'localImage', path: imagePath })),
      ],
    });
    if (!object(turnResult) || !object(turnResult.turn) || typeof turnResult.turn.id !== 'string') {
      throw new Error('Codex app-server did not return a turn ID');
    }
    turnId = turnResult.turn.id;
    ownTurnKnown = true;
    return await completion;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Codex app-server failed');
    stop(normalizedError);
    // Completion can win a race with the turn/start response on a very short turn.
    return await completion;
  }
}
