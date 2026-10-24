import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CODEX_APP_CONFIG } from './config.js';
import type { CodexRationalRun } from '../shared/codexWorkModes.js';

export type { CodexRationalAction, CodexRationalRun, CodexRationalTask } from '../shared/codexWorkModes.js';

export interface StartRationalRunInput {
  runId: string;
  profileId: string;
  sessionKey: string;
  enabled?: boolean;
  startedAt?: string;
}

interface StoredRun extends CodexRationalRun { tokenHash: string }
interface RationalState { version: 1; runs: Record<string, StoredRun> }

// Only guards a model that never declares its own budget. This is not the
// planning estimate: the model sets that once through the run capability.
const BUDGET_DECLARATION_TIMEOUT_MS = 2 * 60_000;

export class CodexRationalModeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'CodexRationalModeError';
  }
}

function reject(code: string, message: string): never {
  throw new CodexRationalModeError(code, message);
}

function boundedText(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return reject('INVALID_INPUT', `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

function minutes(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 240) {
    return reject('INVALID_INPUT', `${label} must be between 1 and 240 minutes.`);
  }
  return value;
}

function publicRun(run: StoredRun): CodexRationalRun {
  const { tokenHash: _secret, ...result } = run;
  return structuredClone(result);
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function authenticate(run: StoredRun, token: unknown): void {
  if (typeof token !== 'string' || token.length > 512
    || !timingSafeEqual(digest(token), Buffer.from(run.tokenHash, 'hex'))) {
    reject('FORBIDDEN', 'This capability does not belong to this run.');
  }
}

function firstPending(run: StoredRun) {
  return run.tasks.find((task) => task.status === 'pending');
}

function reconcile(run: StoredRun, now: number): void {
  if (!run.enabled || run.finishedAt || !['planning', 'running'].includes(run.status)) return;
  const pending = firstPending(run);
  run.currentTaskId = pending?.id || null;
  run.deadlineAt = pending?.deadlineAt || (run.plannedAt ? null : run.planningDeadlineAt || run.budgetDeclarationDeadlineAt || null);
  if (run.deadlineAt && now >= Date.parse(run.deadlineAt)) {
    run.status = 'expired';
    run.expiredAt = new Date(now).toISOString();
  }
}

/** Single-writer file state: mutation + persistence are serialized, failed writes never commit memory. */
export function createRationalModeStore(options: { storageFile: string; now?: () => number }) {
  const clock = options.now || Date.now;
  let state: RationalState = { version: 1, runs: {} };
  let loadPromise: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  async function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const parsed = JSON.parse(await fs.readFile(options.storageFile, 'utf8')) as RationalState;
          if (parsed.version !== 1 || !parsed.runs || typeof parsed.runs !== 'object' || Array.isArray(parsed.runs)) {
            throw new Error('Invalid rational-mode state.');
          }
          for (const [id, run] of Object.entries(parsed.runs)) {
            if (!run || run.runId !== id || !/^[a-f0-9]{64}$/.test(run.tokenHash) || !Array.isArray(run.tasks)) {
              throw new Error('Invalid rational-mode run state.');
            }
          }
          state = parsed;
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      })().catch((error) => { loadPromise = null; throw error; });
    }
    await loadPromise;
  }

  async function persist(next: RationalState) {
    const directory = path.dirname(options.storageFile);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = `${options.storageFile}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, options.storageFile);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function transaction<T>(operation: (next: RationalState, now: number) => T): Promise<T> {
    const result = tail.catch(() => undefined).then(async () => {
      await load();
      const next = structuredClone(state);
      const before = JSON.stringify(next);
      let failure: unknown;
      let value!: T;
      try { value = operation(next, clock()); } catch (error) { failure = error; }
      // In particular, a rejected late checkmark must still durably record expiry.
      if (JSON.stringify(next) !== before) {
        await persist(next);
        state = next;
      }
      if (failure) throw failure;
      return value;
    });
    tail = result;
    return result;
  }

  function required(next: RationalState, runId: string): StoredRun {
    const run = Object.hasOwn(next.runs, runId) ? next.runs[runId] : null;
    return run || reject('NOT_FOUND', 'Rational run not found.');
  }

  function startRationalRun(input: StartRationalRunInput): Promise<{ run: CodexRationalRun; token: string | null }> {
    return transaction((next, now) => {
      const runId = boundedText(input.runId, 'runId', 200);
      const profileId = boundedText(input.profileId, 'profileId', 200);
      const sessionKey = boundedText(input.sessionKey, 'sessionKey', 300);
      const existing = Object.hasOwn(next.runs, runId) ? next.runs[runId] : null;
      if (existing) {
        if (existing.profileId !== profileId || existing.sessionKey !== sessionKey) {
          reject('RUN_CONFLICT', 'This run already belongs to another conversation.');
        }
        reconcile(existing, now);
        return { run: publicRun(existing), token: null };
      }
      const started = input.startedAt === undefined ? now : Date.parse(input.startedAt);
      if (!Number.isFinite(started) || started > now) reject('INVALID_INPUT', 'startedAt cannot be invalid or in the future.');
      const token = randomBytes(32).toString('base64url');
      const enabled = input.enabled !== false;
      const run: StoredRun = {
        runId, attemptId: randomUUID(), profileId, sessionKey, enabled,
        status: enabled ? 'planning' : 'running',
        startedAt: new Date(started).toISOString(),
        timingSource: 'model', planningMinutes: null, planningDeadlineAt: null,
        budgetDeclarationDeadlineAt: enabled ? new Date(started + BUDGET_DECLARATION_TIMEOUT_MS).toISOString() : null,
        plannedAt: null, deadlineAt: null, currentTaskId: null, taskMinutes: null,
        tasks: [], expiredAt: null, holdReleasedAt: null, finishedAt: null, outcome: null,
        tokenHash: digest(token).toString('hex'),
      };
      reconcile(run, now);
      Object.defineProperty(next.runs, runId, { value: run, enumerable: true, writable: true, configurable: true });
      return { run: publicRun(run), token };
    });
  }

  function getRationalRun(runId: string): Promise<CodexRationalRun | null> {
    return transaction((next, now) => {
      if (!Object.hasOwn(next.runs, runId)) return null;
      const run = next.runs[runId];
      reconcile(run, now);
      return publicRun(run);
    });
  }

  function authenticateRationalRun(runId: string, token: string): Promise<CodexRationalRun> {
    return transaction((next, now) => {
      const run = required(next, runId);
      authenticate(run, token);
      reconcile(run, now);
      return publicRun(run);
    });
  }

  function listRationalRuns(profileId: string, sessionKey: string): Promise<CodexRationalRun[]> {
    return transaction((next, now) => Object.values(next.runs)
      .filter((run) => run.profileId === profileId && run.sessionKey === sessionKey)
      .map((run) => { reconcile(run, now); return publicRun(run); })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  function mutateRationalRun(runId: string, token: string, action: unknown): Promise<CodexRationalRun> {
    return transaction((next, now) => {
      const run = required(next, runId);
      authenticate(run, token);
      reconcile(run, now);
      if (!action || typeof action !== 'object' || Array.isArray(action)) reject('INVALID_INPUT', 'An action is required.');
      const input = action as Record<string, unknown>;
      if (input.action === 'status') return publicRun(run);
      if (run.status === 'expired') reject('BUDGET_EXPIRED', 'The allotted time has expired; the run must stop.');
      if (run.finishedAt || run.status === 'incomplete') reject('RUN_FINISHED', 'This run has ended.');
      if (!run.enabled) reject('BUDGET_DISABLED', 'Task budgeting is not enabled for this run.');

      if (input.action === 'budget') {
        const planningMinutes = minutes(input.planningMinutes, 'planningMinutes');
        if (planningMinutes > 30) reject('INVALID_INPUT', 'Planning estimate must be at most 30 minutes.');
        if (run.timingSource !== 'model') reject('BUDGET_FROZEN', 'An existing run keeps its original budget.');
        if (run.planningMinutes != null) {
          if (run.planningMinutes === planningMinutes) return publicRun(run);
          reject('BUDGET_FROZEN', 'The model’s saved planning budget cannot be extended or replaced.');
        }
        run.planningMinutes = planningMinutes;
        run.planningDeadlineAt = new Date(now + planningMinutes * 60_000).toISOString();
        reconcile(run, now);
        return publicRun(run);
      }

      if (input.action === 'plan') {
        if (run.timingSource === 'model' && run.planningMinutes == null) {
          reject('BUDGET_REQUIRED', 'Declare your own planning estimate with the budget action before planning.');
        }
        if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 30) {
          reject('INVALID_INPUT', 'A plan must contain between 1 and 30 tasks.');
        }
        const tasks = input.tasks.map((candidate: unknown) => {
          if (!candidate || typeof candidate !== 'object') reject('INVALID_INPUT', 'Invalid task.');
          const task = candidate as Record<string, unknown>;
          const estimatedMinutes = minutes(task.estimatedMinutes, 'estimatedMinutes');
          // Preserve already-running historical budgets; no session preference
          // caps estimates chosen by the model for a new run.
          if (run.taskMinutes != null && estimatedMinutes > run.taskMinutes) reject('INVALID_INPUT', 'Task estimate exceeds this run’s task limit.');
          return { title: boundedText(task.title, 'title'), estimatedMinutes };
        });
        if (run.plannedAt) {
          const old = run.tasks.map(({ title, estimatedMinutes }) => ({ title, estimatedMinutes }));
          if (JSON.stringify(old) === JSON.stringify(tasks)) return publicRun(run);
          reject('PLAN_FROZEN', 'The saved plan cannot be changed or extended.');
        }
        let deadline = now;
        run.tasks = tasks.map((task) => {
          deadline += task.estimatedMinutes * 60_000;
          return { ...task, id: randomUUID(), status: 'pending', deadlineAt: new Date(deadline).toISOString(), completedAt: null, evidence: null };
        });
        run.plannedAt = new Date(now).toISOString();
        run.status = 'running';
        reconcile(run, now);
        return publicRun(run);
      }

      if (input.action === 'complete') {
        const taskId = boundedText(input.taskId, 'taskId', 200);
        const evidence = boundedText(input.evidence, 'evidence', 4_000);
        const task = run.tasks.find((candidate) => candidate.id === taskId);
        if (!task) reject('NOT_FOUND', 'Task not found in this run.');
        if (task.status === 'completed') {
          if (task.evidence !== evidence) reject('TASK_FROZEN', 'Completed task evidence cannot be rewritten.');
          return publicRun(run);
        }
        if (firstPending(run)?.id !== task.id) reject('TASK_ORDER', 'Complete the current task first.');
        task.status = 'completed';
        task.completedAt = new Date(now).toISOString();
        task.evidence = evidence;
        if (!firstPending(run)) {
          run.status = 'completed';
          run.currentTaskId = null;
          run.deadlineAt = null;
        } else reconcile(run, now);
        return publicRun(run);
      }
      return reject('INVALID_INPUT', 'Unknown rational-mode action.');
    });
  }

  function dueRationalRuns(now?: number): Promise<CodexRationalRun[]> {
    return transaction((next, current) => {
      if (now !== undefined && !Number.isFinite(now)) reject('INVALID_INPUT', 'Invalid deadline clock.');
      return Object.values(next.runs).flatMap((run) => {
        reconcile(run, now ?? current);
        return run.status === 'expired' && !run.finishedAt ? [publicRun(run)] : [];
      });
    });
  }

  function finishRationalRun(runId: string, outcome: string): Promise<CodexRationalRun | null> {
    return transaction((next, now) => {
      if (!Object.hasOwn(next.runs, runId)) return null;
      const run = next.runs[runId];
      if (run.finishedAt) return publicRun(run);
      const cleanOutcome = boundedText(outcome, 'outcome', 100);
      reconcile(run, now);
      if (run.status !== 'expired') {
        run.status = (!run.enabled || (run.plannedAt && !firstPending(run))) && cleanOutcome === 'completed'
          ? 'completed' : 'incomplete';
      }
      run.finishedAt = new Date(now).toISOString();
      run.outcome = cleanOutcome;
      return publicRun(run);
    });
  }

  function rebindRationalRun(runId: string, sessionKey: string): Promise<CodexRationalRun | null> {
    return transaction((next, now) => {
      const cleanSession = boundedText(sessionKey, 'sessionKey', 300);
      if (!Object.hasOwn(next.runs, runId)) return null;
      const run = next.runs[runId];
      run.sessionKey = cleanSession;
      reconcile(run, now);
      return publicRun(run);
    });
  }

  function listRationalHolds(): Promise<CodexRationalRun[]> {
    return transaction((next, now) => Object.values(next.runs).flatMap((run) => {
      reconcile(run, now);
      return run.enabled && !run.holdReleasedAt && ['expired', 'incomplete'].includes(run.status)
        ? [publicRun(run)] : [];
    }));
  }

  /** Trusted owner route only: model capability tokens intentionally cannot release a hold. */
  function releaseRationalRun(runId: string, profileId: string, sessionKey: string): Promise<CodexRationalRun> {
    return transaction((next, now) => {
      const run = required(next, runId);
      if (run.profileId !== profileId || run.sessionKey !== sessionKey) {
        reject('FORBIDDEN', 'This run does not belong to this conversation.');
      }
      reconcile(run, now);
      if (!run.enabled || !['expired', 'incomplete'].includes(run.status)) {
        reject('INVALID_STATE', 'Only an expired or incomplete budget can be released.');
      }
      run.holdReleasedAt ||= new Date(now).toISOString();
      return publicRun(run);
    });
  }

  return { startRationalRun, getRationalRun, listRationalRuns, authenticateRationalRun,
    mutateRationalRun, dueRationalRuns, finishRationalRun, rebindRationalRun, listRationalHolds, releaseRationalRun };
}

const store = createRationalModeStore({
  storageFile: path.join(CODEX_APP_CONFIG.storageRoot, 'local', 'rational-mode', 'runs.json'),
});
export const { startRationalRun, getRationalRun, listRationalRuns, authenticateRationalRun,
  mutateRationalRun, dueRationalRuns, finishRationalRun, rebindRationalRun, listRationalHolds, releaseRationalRun } = store;
