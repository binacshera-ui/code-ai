import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  CODEX_USER_INPUT_LIMITS,
  type CodexUserInputAnswerResult,
  type CodexUserInputAnswers,
  type CodexUserInputQuestion,
  type CodexUserInputRequest,
  type CodexUserInputResponse,
  type CodexUserInputSnapshot,
  type CodexUserInputStatus,
} from '../shared/codexUserInput.js';

export type CodexRpcRequestId = string | number;

export interface CodexUserInputScope {
  profileId: string;
  sessionId: string;
  runId: string;
}

/** Version-matched native request. autoResolutionMs is deprecated: never auto-answer. */
export interface CodexNativeUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs?: number | null;
}

export class CodexUserInputError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = 'CodexUserInputError';
  }
}

interface RegistryEntry {
  request: CodexUserInputRequest;
  nativeId: CodexRpcRequestId;
  nativeThreadId: string;
  send?: (response: CodexUserInputResponse) => void | Promise<void>;
  submission?: Promise<void>;
  digest?: string;
  // Private, process-local comparison only; never persist secret question text.
  paramsDigest: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new CodexUserInputError('invalid_request', `Invalid ${name}`);
  }
  return value;
}

function nativeKey(scope: CodexUserInputScope, nativeThreadId: string, id: CodexRpcRequestId): string {
  return JSON.stringify([scope.profileId, scope.sessionId, scope.runId, nativeThreadId, typeof id, id]);
}

function cloneRequest(request: CodexUserInputRequest): CodexUserInputRequest {
  return structuredClone(request);
}

function parseParams(raw: unknown): CodexNativeUserInputParams {
  if (!object(raw)) throw new CodexUserInputError('invalid_request', 'Invalid user input request');
  const threadId = requiredString(raw.threadId, 'threadId');
  const turnId = requiredString(raw.turnId, 'turnId');
  const itemId = requiredString(raw.itemId, 'itemId');
  if (typeof raw.isBlocking !== 'boolean' || !Array.isArray(raw.questions)
      || raw.questions.length < 1 || raw.questions.length > CODEX_USER_INPUT_LIMITS.questions) {
    throw new CodexUserInputError('invalid_request', 'Invalid user input questions');
  }
  const seen = new Set<string>();
  const questions = raw.questions.map((rawQuestion): CodexUserInputQuestion => {
    if (!object(rawQuestion)) throw new CodexUserInputError('invalid_request', 'Invalid question');
    const id = requiredString(rawQuestion.id, 'question id');
    if (seen.has(id)) throw new CodexUserInputError('invalid_request', 'Duplicate question id');
    seen.add(id);
    const header = requiredString(rawQuestion.header, 'question header', 1_000);
    const question = requiredString(rawQuestion.question, 'question text', CODEX_USER_INPUT_LIMITS.questionText);
    if (typeof rawQuestion.isOther !== 'boolean' || typeof rawQuestion.isSecret !== 'boolean') {
      throw new CodexUserInputError('invalid_request', 'Invalid question flags');
    }
    let options: CodexUserInputQuestion['options'] = null;
    if (rawQuestion.options !== null) {
      if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length > CODEX_USER_INPUT_LIMITS.optionsPerQuestion) {
        throw new CodexUserInputError('invalid_request', 'Invalid question options');
      }
      const labels = new Set<string>();
      options = rawQuestion.options.map((rawOption) => {
        if (!object(rawOption)) throw new CodexUserInputError('invalid_request', 'Invalid option');
        const label = requiredString(rawOption.label, 'option label', CODEX_USER_INPUT_LIMITS.optionText);
        if (labels.has(label) || typeof rawOption.description !== 'string'
            || rawOption.description.length > CODEX_USER_INPUT_LIMITS.optionText) {
          throw new CodexUserInputError('invalid_request', 'Invalid option description or duplicate label');
        }
        labels.add(label);
        return { label, description: rawOption.description };
      });
    }
    return { id, header, question, isOther: rawQuestion.isOther, isSecret: rawQuestion.isSecret, options };
  });
  const params = { threadId, turnId, itemId, questions, isBlocking: raw.isBlocking };
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > CODEX_USER_INPUT_LIMITS.requestBytes) {
    throw new CodexUserInputError('invalid_request', 'User input request exceeds the size limit', 413);
  }
  return params;
}

function validateAnswers(questions: CodexUserInputQuestion[], raw: unknown): CodexUserInputAnswers {
  if (!object(raw) || Object.keys(raw).length !== questions.length) {
    throw new CodexUserInputError('invalid_answers', 'Answer every question exactly once');
  }
  const answers: CodexUserInputAnswers = Object.create(null);
  for (const question of questions) {
    const value = Object.hasOwn(raw, question.id) ? raw[question.id] : undefined;
    if (!object(value) || Object.keys(value).some(key => key !== 'answers') || !Array.isArray(value.answers)
        || value.answers.length !== 1) {
      throw new CodexUserInputError('invalid_answers', 'Each question requires one answer');
    }
    const answer = value.answers[0];
    if (typeof answer !== 'string' || !answer.trim() || answer.length > CODEX_USER_INPUT_LIMITS.answerText) {
      throw new CodexUserInputError('invalid_answers', 'Answer must be non-empty and within the length limit');
    }
    if (question.options?.length && !question.isOther && !question.options.some(option => option.label === answer)) {
      throw new CodexUserInputError('invalid_answers', 'Select one of the available options');
    }
    answers[question.id] = { answers: [answer] };
  }
  if (Buffer.byteLength(JSON.stringify(answers), 'utf8') > CODEX_USER_INPUT_LIMITS.answerBytes) {
    throw new CodexUserInputError('invalid_answers', 'Answers exceed the size limit', 413);
  }
  return answers;
}

/** In-memory control plane only. Native Codex owns durable conversation history. */
export class CodexUserInputRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly nativeIds = new Map<string, string>();
  private readonly hashKey = randomBytes(32);

  constructor(private readonly limits: {
    maxEntries?: number;
    maxPendingPerRun?: number;
    resolvedTtlMs?: number;
    maxResolvedPerSession?: number;
    now?: () => number;
  } = {}) {}

  private now(): number { return this.limits.now?.() ?? Date.now(); }

  private prune(): void {
    const oldestAllowed = this.now() - (this.limits.resolvedTtlMs ?? 3_600_000);
    const perSession = new Map<string, number>();
    for (const [id, entry] of [...this.entries].reverse()) {
      if (entry.request.status === 'pending') continue;
      const key = JSON.stringify([entry.request.profileId, entry.request.sessionId]);
      const count = (perSession.get(key) ?? 0) + 1;
      perSession.set(key, count);
      if (Date.parse(entry.request.resolvedAt!) < oldestAllowed || count > (this.limits.maxResolvedPerSession ?? 100)) {
        this.remove(id, entry);
      }
    }
  }

  private remove(id: string, entry: RegistryEntry): void {
    this.entries.delete(id);
    this.nativeIds.delete(nativeKey(entry.request, entry.nativeThreadId, entry.nativeId));
  }

  register(scope: CodexUserInputScope, nativeId: CodexRpcRequestId, rawParams: unknown,
    sendResponse: (response: CodexUserInputResponse) => void | Promise<void>,
    options: { reattachDetached?: boolean } = {}): CodexUserInputRequest {
    requiredString(scope.profileId, 'profileId');
    requiredString(scope.sessionId, 'sessionId');
    requiredString(scope.runId, 'runId');
    if ((typeof nativeId !== 'string' && typeof nativeId !== 'number')
        || (typeof nativeId === 'number' && !Number.isSafeInteger(nativeId))
        || (typeof nativeId === 'string' && nativeId.length > 1_000)) {
      throw new CodexUserInputError('invalid_request', 'Invalid native request ID');
    }
    const params = parseParams(rawParams);
    const paramsDigest = createHmac('sha256', this.hashKey).update(JSON.stringify(params)).digest('hex');
    const key = nativeKey(scope, params.threadId, nativeId);
    const existing = this.nativeIds.get(key);
    if (existing) {
      const entry = this.entries.get(existing)!;
      // The transport may rebind only an unattempted question from its own
      // proven native turn. Answer delivery uncertainty is never replay-safe.
      if (options.reattachDetached && entry.request.status === 'failed'
          && entry.request.resolutionReason === 'native_detached'
          && !entry.digest && !entry.submission && !entry.send) {
        if (paramsDigest !== entry.paramsDigest) {
          throw new CodexUserInputError('request_conflict', 'Recovered user input does not match the original request', 409);
        }
        this.requirePendingCapacity(scope);
        entry.send = sendResponse;
        entry.request.status = 'pending';
        entry.request.resolvedAt = null;
        delete entry.request.resolutionReason;
        entry.request.questions = params.questions;
      }
      return cloneRequest(entry.request);
    }
    this.prune();
    const maxEntries = this.limits.maxEntries ?? 512;
    for (const [id, entry] of this.entries) {
      if (this.entries.size < maxEntries) break;
      if (entry.request.status !== 'pending') this.remove(id, entry);
    }
    if (this.entries.size >= maxEntries) {
      throw new CodexUserInputError('request_capacity', 'Too many pending user input requests', 503);
    }
    this.requirePendingCapacity(scope);
    const request: CodexUserInputRequest = {
      ...scope, id: randomUUID(), turnId: params.turnId, itemId: params.itemId,
      isBlocking: params.isBlocking, questions: params.questions, status: 'pending',
      createdAt: new Date(this.now()).toISOString(), resolvedAt: null,
    };
    this.entries.set(request.id, { request, nativeId, nativeThreadId: params.threadId, send: sendResponse, paramsDigest });
    this.nativeIds.set(key, request.id);
    return cloneRequest(request);
  }

  private requirePendingCapacity(scope: CodexUserInputScope): void {
    const pendingInRun = [...this.entries.values()].filter(entry => entry.request.status === 'pending'
      && entry.request.profileId === scope.profileId && entry.request.runId === scope.runId).length;
    if (pendingInRun >= (this.limits.maxPendingPerRun ?? 32)) {
      throw new CodexUserInputError('request_capacity', 'Too many pending user input requests', 503);
    }
  }

  list(profileId: string, sessionId: string): CodexUserInputSnapshot {
    this.prune();
    const requests = [...this.entries.values()].filter(entry => entry.request.profileId === profileId
      && entry.request.sessionId === sessionId).map(entry => cloneRequest(entry.request));
    return { requests, pendingCount: requests.filter(request => request.status === 'pending').length };
  }

  async answer(input: { profileId: string; sessionId: string; requestId: string; answers: unknown }): Promise<CodexUserInputAnswerResult> {
    this.prune();
    const entry = this.entries.get(input.requestId);
    if (!entry || entry.request.profileId !== input.profileId || entry.request.sessionId !== input.sessionId) {
      throw new CodexUserInputError('request_not_found', 'User input request not found', 404);
    }
    // Secret question text is scrubbed on resolution, but its ID/flags/options remain for retry validation.
    const answers = validateAnswers(entry.request.questions, input.answers);
    const digest = createHmac('sha256', this.hashKey).update(JSON.stringify(answers)).digest('hex');
    if (entry.digest) {
      if (entry.digest !== digest) throw new CodexUserInputError('answer_conflict', 'This request has already received a different answer', 409);
      await entry.submission;
      if (entry.request.status === 'failed') throw new CodexUserInputError('answer_failed', 'The provider could not receive the answer', 409);
      return { request: cloneRequest(entry.request), duplicate: true };
    }
    if (entry.request.status !== 'pending' || !entry.send) {
      throw new CodexUserInputError('request_expired', 'This user input request is no longer active', 409);
    }
    const send = entry.send;
    entry.digest = digest;
    entry.submission = Promise.resolve().then(() => send({ answers })).then(() => {
      if (entry.request.status !== 'pending') {
        throw new CodexUserInputError('request_expired', 'This user input request is no longer active', 409);
      }
      const safeAnswers: CodexUserInputAnswers = Object.create(null);
      for (const question of entry.request.questions) {
        safeAnswers[question.id] = { answers: question.isSecret ? ['[redacted]'] : [...answers[question.id].answers] };
      }
      entry.request.answers = safeAnswers;
      this.finish(entry, 'answered', 'user_answered');
    }, () => {
      if (entry.request.status === 'pending') this.finish(entry, 'failed', 'answer_delivery_failed');
      throw new CodexUserInputError('answer_failed', 'The provider could not receive the answer', 409);
    });
    await entry.submission;
    return { request: cloneRequest(entry.request), duplicate: false };
  }

  private finish(entry: RegistryEntry, status: Exclude<CodexUserInputStatus, 'pending'>, reason: string): void {
    entry.request.status = status;
    entry.request.resolvedAt = new Date(this.now()).toISOString();
    entry.request.resolutionReason = reason;
    entry.send = undefined;
    // Neither secret prompts nor their actual answers survive in resolved product history.
    entry.request.questions = entry.request.questions.map(question => question.isSecret
      ? { ...question, header: '[redacted]', question: '[redacted]', options: question.options?.map(option => ({ label: option.label, description: '' })) ?? null }
      : question);
  }

  resolveNative(scope: CodexUserInputScope, nativeId: CodexRpcRequestId, nativeThreadId = scope.sessionId): void {
    const id = this.nativeIds.get(nativeKey(scope, nativeThreadId, nativeId));
    const entry = id ? this.entries.get(id) : undefined;
    if (entry?.request.status === 'pending') this.finish(entry, 'expired', 'provider_resolved');
  }

  clearRun(runId: string, status: Exclude<CodexUserInputStatus, 'pending' | 'answered'> = 'expired',
    reason = 'run_ended', profileId?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.request.runId === runId && (!profileId || entry.request.profileId === profileId)
          && entry.request.status === 'pending') this.finish(entry, status, reason);
    }
    this.prune();
  }
}

export const codexUserInputRegistry = new CodexUserInputRegistry();
