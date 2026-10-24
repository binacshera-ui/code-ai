// projects/code-ai/ops/fleet-update-20261014/diagnostic-codexAppServer.ts
import { spawn } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/codexUserInput.ts
import { createHmac, randomBytes, randomUUID } from "node:crypto";

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/shared/codexUserInput.ts
var CODEX_USER_INPUT_LIMITS = {
  questions: 3,
  optionsPerQuestion: 20,
  questionText: 16e3,
  optionText: 2e3,
  answerText: 32e3,
  answerBytes: 128e3,
  requestBytes: 128e3
};

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/codexUserInput.ts
var CodexUserInputError = class extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "CodexUserInputError";
  }
};
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requiredString(value, name, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new CodexUserInputError("invalid_request", `Invalid ${name}`);
  }
  return value;
}
function nativeKey(scope, nativeThreadId, id) {
  return JSON.stringify([scope.profileId, scope.sessionId, scope.runId, nativeThreadId, typeof id, id]);
}
function cloneRequest(request) {
  return structuredClone(request);
}
function parseParams(raw) {
  if (!object(raw)) throw new CodexUserInputError("invalid_request", "Invalid user input request");
  const threadId = requiredString(raw.threadId, "threadId");
  const turnId = requiredString(raw.turnId, "turnId");
  const itemId = requiredString(raw.itemId, "itemId");
  if (typeof raw.isBlocking !== "boolean" || !Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > CODEX_USER_INPUT_LIMITS.questions) {
    throw new CodexUserInputError("invalid_request", "Invalid user input questions");
  }
  const seen = /* @__PURE__ */ new Set();
  const questions = raw.questions.map((rawQuestion) => {
    if (!object(rawQuestion)) throw new CodexUserInputError("invalid_request", "Invalid question");
    const id = requiredString(rawQuestion.id, "question id");
    if (seen.has(id)) throw new CodexUserInputError("invalid_request", "Duplicate question id");
    seen.add(id);
    const header = requiredString(rawQuestion.header, "question header", 1e3);
    const question = requiredString(rawQuestion.question, "question text", CODEX_USER_INPUT_LIMITS.questionText);
    if (typeof rawQuestion.isOther !== "boolean" || typeof rawQuestion.isSecret !== "boolean") {
      throw new CodexUserInputError("invalid_request", "Invalid question flags");
    }
    let options = null;
    if (rawQuestion.options !== null) {
      if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length > CODEX_USER_INPUT_LIMITS.optionsPerQuestion) {
        throw new CodexUserInputError("invalid_request", "Invalid question options");
      }
      const labels = /* @__PURE__ */ new Set();
      options = rawQuestion.options.map((rawOption) => {
        if (!object(rawOption)) throw new CodexUserInputError("invalid_request", "Invalid option");
        const label = requiredString(rawOption.label, "option label", CODEX_USER_INPUT_LIMITS.optionText);
        if (labels.has(label) || typeof rawOption.description !== "string" || rawOption.description.length > CODEX_USER_INPUT_LIMITS.optionText) {
          throw new CodexUserInputError("invalid_request", "Invalid option description or duplicate label");
        }
        labels.add(label);
        return { label, description: rawOption.description };
      });
    }
    return { id, header, question, isOther: rawQuestion.isOther, isSecret: rawQuestion.isSecret, options };
  });
  const params = { threadId, turnId, itemId, questions, isBlocking: raw.isBlocking };
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > CODEX_USER_INPUT_LIMITS.requestBytes) {
    throw new CodexUserInputError("invalid_request", "User input request exceeds the size limit", 413);
  }
  return params;
}
function validateAnswers(questions, raw) {
  if (!object(raw) || Object.keys(raw).length !== questions.length) {
    throw new CodexUserInputError("invalid_answers", "Answer every question exactly once");
  }
  const answers = /* @__PURE__ */ Object.create(null);
  for (const question of questions) {
    const value = Object.hasOwn(raw, question.id) ? raw[question.id] : void 0;
    if (!object(value) || Object.keys(value).some((key) => key !== "answers") || !Array.isArray(value.answers) || value.answers.length !== 1) {
      throw new CodexUserInputError("invalid_answers", "Each question requires one answer");
    }
    const answer = value.answers[0];
    if (typeof answer !== "string" || !answer.trim() || answer.length > CODEX_USER_INPUT_LIMITS.answerText) {
      throw new CodexUserInputError("invalid_answers", "Answer must be non-empty and within the length limit");
    }
    if (question.options?.length && !question.isOther && !question.options.some((option) => option.label === answer)) {
      throw new CodexUserInputError("invalid_answers", "Select one of the available options");
    }
    answers[question.id] = { answers: [answer] };
  }
  if (Buffer.byteLength(JSON.stringify(answers), "utf8") > CODEX_USER_INPUT_LIMITS.answerBytes) {
    throw new CodexUserInputError("invalid_answers", "Answers exceed the size limit", 413);
  }
  return answers;
}
var CodexUserInputRegistry = class {
  constructor(limits = {}) {
    this.limits = limits;
  }
  entries = /* @__PURE__ */ new Map();
  nativeIds = /* @__PURE__ */ new Map();
  hashKey = randomBytes(32);
  now() {
    return this.limits.now?.() ?? Date.now();
  }
  prune() {
    const oldestAllowed = this.now() - (this.limits.resolvedTtlMs ?? 36e5);
    const perSession = /* @__PURE__ */ new Map();
    for (const [id, entry] of [...this.entries].reverse()) {
      if (entry.request.status === "pending") continue;
      const key = JSON.stringify([entry.request.profileId, entry.request.sessionId]);
      const count = (perSession.get(key) ?? 0) + 1;
      perSession.set(key, count);
      if (Date.parse(entry.request.resolvedAt) < oldestAllowed || count > (this.limits.maxResolvedPerSession ?? 100)) {
        this.remove(id, entry);
      }
    }
  }
  remove(id, entry) {
    this.entries.delete(id);
    this.nativeIds.delete(nativeKey(entry.request, entry.nativeThreadId, entry.nativeId));
  }
  register(scope, nativeId, rawParams, sendResponse, options = {}) {
    requiredString(scope.profileId, "profileId");
    requiredString(scope.sessionId, "sessionId");
    requiredString(scope.runId, "runId");
    if (typeof nativeId !== "string" && typeof nativeId !== "number" || typeof nativeId === "number" && !Number.isSafeInteger(nativeId) || typeof nativeId === "string" && nativeId.length > 1e3) {
      throw new CodexUserInputError("invalid_request", "Invalid native request ID");
    }
    const params = parseParams(rawParams);
    const paramsDigest = createHmac("sha256", this.hashKey).update(JSON.stringify(params)).digest("hex");
    const key = nativeKey(scope, params.threadId, nativeId);
    const existing = this.nativeIds.get(key);
    if (existing) {
      const entry = this.entries.get(existing);
      if (options.reattachDetached && entry.request.status === "failed" && entry.request.resolutionReason === "native_detached" && !entry.digest && !entry.submission && !entry.send) {
        if (paramsDigest !== entry.paramsDigest) {
          throw new CodexUserInputError("request_conflict", "Recovered user input does not match the original request", 409);
        }
        this.requirePendingCapacity(scope);
        entry.send = sendResponse;
        entry.request.status = "pending";
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
      if (entry.request.status !== "pending") this.remove(id, entry);
    }
    if (this.entries.size >= maxEntries) {
      throw new CodexUserInputError("request_capacity", "Too many pending user input requests", 503);
    }
    this.requirePendingCapacity(scope);
    const request = {
      ...scope,
      id: randomUUID(),
      turnId: params.turnId,
      itemId: params.itemId,
      isBlocking: params.isBlocking,
      questions: params.questions,
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      resolvedAt: null
    };
    this.entries.set(request.id, { request, nativeId, nativeThreadId: params.threadId, send: sendResponse, paramsDigest });
    this.nativeIds.set(key, request.id);
    return cloneRequest(request);
  }
  requirePendingCapacity(scope) {
    const pendingInRun = [...this.entries.values()].filter((entry) => entry.request.status === "pending" && entry.request.profileId === scope.profileId && entry.request.runId === scope.runId).length;
    if (pendingInRun >= (this.limits.maxPendingPerRun ?? 32)) {
      throw new CodexUserInputError("request_capacity", "Too many pending user input requests", 503);
    }
  }
  list(profileId, sessionId) {
    this.prune();
    const requests = [...this.entries.values()].filter((entry) => entry.request.profileId === profileId && entry.request.sessionId === sessionId).map((entry) => cloneRequest(entry.request));
    return { requests, pendingCount: requests.filter((request) => request.status === "pending").length };
  }
  async answer(input) {
    this.prune();
    const entry = this.entries.get(input.requestId);
    if (!entry || entry.request.profileId !== input.profileId || entry.request.sessionId !== input.sessionId) {
      throw new CodexUserInputError("request_not_found", "User input request not found", 404);
    }
    const answers = validateAnswers(entry.request.questions, input.answers);
    const digest = createHmac("sha256", this.hashKey).update(JSON.stringify(answers)).digest("hex");
    if (entry.digest) {
      if (entry.digest !== digest) throw new CodexUserInputError("answer_conflict", "This request has already received a different answer", 409);
      await entry.submission;
      if (entry.request.status === "failed") throw new CodexUserInputError("answer_failed", "The provider could not receive the answer", 409);
      return { request: cloneRequest(entry.request), duplicate: true };
    }
    if (entry.request.status !== "pending" || !entry.send) {
      throw new CodexUserInputError("request_expired", "This user input request is no longer active", 409);
    }
    const send = entry.send;
    entry.digest = digest;
    entry.submission = Promise.resolve().then(() => send({ answers })).then(() => {
      if (entry.request.status !== "pending") {
        throw new CodexUserInputError("request_expired", "This user input request is no longer active", 409);
      }
      const safeAnswers = /* @__PURE__ */ Object.create(null);
      for (const question of entry.request.questions) {
        safeAnswers[question.id] = { answers: question.isSecret ? ["[redacted]"] : [...answers[question.id].answers] };
      }
      entry.request.answers = safeAnswers;
      this.finish(entry, "answered", "user_answered");
    }, () => {
      if (entry.request.status === "pending") this.finish(entry, "failed", "answer_delivery_failed");
      throw new CodexUserInputError("answer_failed", "The provider could not receive the answer", 409);
    });
    await entry.submission;
    return { request: cloneRequest(entry.request), duplicate: false };
  }
  finish(entry, status, reason) {
    entry.request.status = status;
    entry.request.resolvedAt = new Date(this.now()).toISOString();
    entry.request.resolutionReason = reason;
    entry.send = void 0;
    entry.request.questions = entry.request.questions.map((question) => question.isSecret ? { ...question, header: "[redacted]", question: "[redacted]", options: question.options?.map((option) => ({ label: option.label, description: "" })) ?? null } : question);
  }
  resolveNative(scope, nativeId, nativeThreadId = scope.sessionId) {
    const id = this.nativeIds.get(nativeKey(scope, nativeThreadId, nativeId));
    const entry = id ? this.entries.get(id) : void 0;
    if (entry?.request.status === "pending") this.finish(entry, "expired", "provider_resolved");
  }
  clearRun(runId, status = "expired", reason = "run_ended", profileId) {
    for (const entry of this.entries.values()) {
      if (entry.request.runId === runId && (!profileId || entry.request.profileId === profileId) && entry.request.status === "pending") this.finish(entry, status, reason);
    }
    this.prune();
  }
};
var codexUserInputRegistry = new CodexUserInputRegistry();

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/providerProcessLifecycle.ts
import { spawnSync } from "child_process";
var DEFAULT_FORCE_KILL_DELAY_MS = 3e3;
function getProviderProcessSpawnOptions() {
  return {
    // A dedicated process group lets code-ai terminate provider wrappers and
    // their native CLI children together during cancellation or shutdown.
    detached: process.platform !== "win32"
  };
}
function signalPosixProcessGroup(child, signal) {
  if (!child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    }
    return false;
  }
}
function terminateWindowsProcessTree(child) {
  if (!child.pid) {
    return false;
  }
  const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}
function terminateProviderProcessTree(child, forceKillDelayMs = DEFAULT_FORCE_KILL_DELAY_MS) {
  if (!child.pid) {
    return false;
  }
  if (process.platform === "win32") {
    return terminateWindowsProcessTree(child);
  }
  const signalled = signalPosixProcessGroup(child, "SIGTERM");
  const forceKillTimer = setTimeout(() => {
    signalPosixProcessGroup(child, "SIGKILL");
  }, Math.max(0, forceKillDelayMs));
  forceKillTimer.unref();
  return signalled;
}

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/codexSharedHistory.mjs
var object2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var MAX_ITEM_PAGES = 1e3;
var MAX_TURN_ITEM_BYTES = 128 * 1024 * 1024;
async function readSharedHistoryTurns(rpc, threadId, clientId, turnId) {
  const meta = await rpc("thread/read", { threadId, includeTurns: false });
  if (!object2(meta) || !object2(meta.thread) || meta.thread.id != null && meta.thread.id !== threadId) throw Error("Shared history metadata unavailable");
  if (meta.thread.historyMode !== "paginated") {
    const legacy = await rpc("thread/read", { threadId, includeTurns: true });
    if (!object2(legacy) || !object2(legacy.thread) || !Array.isArray(legacy.thread.turns)) throw Error("Shared history unavailable");
    return legacy.thread.turns;
  }
  let cursor = null;
  const result = [], seen = /* @__PURE__ */ new Set();
  for (let page = 0; page < 100; page++) {
    const response = await rpc("thread/turns/list", { threadId, cursor, limit: 20, itemsView: "notLoaded", sortDirection: "desc" });
    if (!object2(response) || !Array.isArray(response.data)) throw Error("Shared turn page unavailable");
    for (const turn of response.data) {
      if (!object2(turn) || typeof turn.id !== "string") throw Error("Shared turn identity unavailable");
      if (turnId && turn.id !== turnId) continue;
      let itemCursor = null, itemBytes = 0;
      const items = [], itemCursors = /* @__PURE__ */ new Set();
      for (let itemPage = 0; itemPage < MAX_ITEM_PAGES; itemPage++) {
        const part = await rpc("thread/items/list", { threadId, turnId: turn.id, cursor: itemCursor, limit: 20, sortDirection: "asc" });
        if (!object2(part) || !Array.isArray(part.data)) throw Error("Shared item page unavailable");
        for (const entry of part.data) {
          if (!object2(entry) || !object2(entry.item) || entry.turnId !== turn.id) throw Error("Shared item custody unavailable");
          itemBytes += Buffer.byteLength(JSON.stringify(entry.item));
          if (itemBytes > MAX_TURN_ITEM_BYTES) throw Error("Shared history exceeds recovery budget");
          items.push(entry.item);
        }
        if (!part.nextCursor) break;
        if (typeof part.nextCursor !== "string" || itemCursors.has(part.nextCursor) || itemPage === MAX_ITEM_PAGES - 1) throw Error("Shared item pagination unavailable");
        itemCursors.add(part.nextCursor);
        itemCursor = part.nextCursor;
      }
      if (!clientId || items.some((i) => object2(i) && i.type === "userMessage" && i.clientId === clientId)) {
        result.push({ ...turn, items });
        if (clientId || turnId) return result;
      }
    }
    if (!response.nextCursor) return result;
    if (typeof response.nextCursor !== "string" || seen.has(response.nextCursor)) throw Error("Shared history pagination unavailable");
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw Error("Shared history exceeds reconciliation bound");
}

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/codexNativeTransport.mjs
var NATIVE_FRAME_BYTES = 64 * 1024 * 1024;
var NATIVE_BUFFER_BYTES = 128 * 1024 * 1024;

// ../mnt/hdd/code-ai-builds/fleet-update-source-r6-wao72zcg/payload/server/codexRpcDiagnostic.mjs
var slowReads = /* @__PURE__ */ new Set(["thread/resume", "thread/read", "thread/turns/list", "thread/items/list"]);
var operations = /* @__PURE__ */ new Set([
  ...slowReads,
  "initialize",
  "thread/start",
  "thread/queue/list",
  "thread/queue/add",
  "thread/settings/update",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "config/read",
  "configRequirements/read",
  "account/read"
]);
var rpcDiagnosticReasons = /* @__PURE__ */ new Set([
  "native-read-timeout",
  "native-write-timeout",
  "native-rejected",
  "native-connection-lost",
  "native-capacity-unavailable",
  "settings-observation-unavailable",
  "workspace-requirements",
  "configuration-invalid",
  "authentication-refresh",
  "thread-writer-conflict",
  "custody-unresolved",
  "history-recovery-limit"
]);
function nativeRpcTimeoutMs(method) {
  return slowReads.has(method) ? 12e4 : 15e3;
}
function publicRpcDiagnostic(method, code, message, elapsedMs = 0) {
  const text = typeof message === "string" ? message.toLowerCase() : "";
  const reason = /history.*(?:pagination|recovery budget)/.test(text) ? "history-recovery-limit" : /workspace requirements/.test(text) ? "workspace-requirements" : /invalid type|failed to parse.*config|failed to deserialize.*config/.test(text) ? "configuration-invalid" : /token.*refresh|logged out|sign in again/.test(text) ? "authentication-refresh" : /active writer|already.*writer|another codex process/.test(text) ? "thread-writer-conflict" : /acknowledgement unavailable|request timed out/.test(text) ? slowReads.has(method) ? "native-read-timeout" : "native-write-timeout" : /connection lost/.test(text) ? "native-connection-lost" : /capacity unavailable/.test(text) ? "native-capacity-unavailable" : /settings.*observation/.test(text) ? "settings-observation-unavailable" : Number.isInteger(code) ? "native-rejected" : "custody-unresolved";
  return {
    version: 1,
    operation: operations.has(method) ? method : "other",
    reason,
    nativeCode: Number.isInteger(code) ? code : null,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.min(36e5, Math.round(elapsedMs))) : 0
  };
}
function validatePublicRpcDiagnostic(value) {
  if (!value || value.version !== 1 || !(operations.has(value.operation) || value.operation === "other") || !rpcDiagnosticReasons.has(value.reason)) return null;
  return {
    version: 1,
    operation: value.operation,
    reason: value.reason,
    nativeCode: Number.isInteger(value.nativeCode) ? value.nativeCode : null,
    elapsedMs: Number.isFinite(value.elapsedMs) ? Math.max(0, Math.min(36e5, Math.round(value.elapsedMs))) : 0
  };
}

// projects/code-ai/ops/fleet-update-20261014/diagnostic-codexAppServer.ts
function isCodexSharedSubmissionTerminal(submission) {
  return submission.deliveryPhase === "completed" || submission.deliveryPhase === "cancelled";
}
var CodexAppServerCancelledError = class extends Error {
  constructor() {
    super("Codex run was cancelled");
    this.name = "CodexAppServerCancelledError";
  }
};
var CodexAppServerDetachedError = class extends Error {
  constructor(submission) {
    super("Codex shared connection lost; accepted native work must be reconciled before retry");
    this.submission = submission;
    this.name = "CodexAppServerDetachedError";
  }
};
var CodexSharedOwnerSettingsMismatchError = class extends Error {
  constructor() {
    super("Shared native owner settings do not match the requested configuration; no prompt was enqueued");
    this.name = "CodexSharedOwnerSettingsMismatchError";
  }
};
var CodexSharedAdmissionRejectedError = class extends Error {
  constructor(retryable) {
    super(retryable ? "Shared native turn is waiting for its admission boundary; no input was accepted" : "Shared native submission was refused before accepting input");
    this.retryable = retryable;
    this.name = "CodexSharedAdmissionRejectedError";
  }
};
function isCodexSharedOwnerSettingsMismatchError(error) {
  return error instanceof CodexSharedOwnerSettingsMismatchError;
}
var CodexRpcRejectedError = class extends Error {
  constructor(code, admission = null, retryableAdmission = false, diagnostic = null) {
    super(`Codex app-server request failed (${code})${diagnostic ? ` [${diagnostic.operation}: ${diagnostic.reason}]` : ""}`);
    this.code = code;
    this.admission = admission;
    this.retryableAdmission = retryableAdmission;
    this.diagnostic = diagnostic;
  }
};
function object3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rpcId(value) {
  return typeof value === "string" && value.length <= 1e3 || typeof value === "number" && Number.isSafeInteger(value);
}
function samePublicSetting(expected, actual, depth = 0) {
  if (depth > 16) return false;
  if (expected === actual) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => samePublicSetting(value, actual[index], depth + 1));
  if (!object3(expected) || !object3(actual)) return false;
  const keys = Object.keys(expected).sort();
  return keys.length === Object.keys(actual).length && keys.every((key) => Object.hasOwn(actual, key) && samePublicSetting(expected[key], actual[key], depth + 1));
}
function ownerSettingsMatch(expected, response) {
  const required = ["model", "cwd", "approvalPolicy", "sandbox", "reasoningEffort"];
  const optional = ["modelProvider", "serviceTier"];
  return required.every((key) => Object.hasOwn(expected, key) && Object.hasOwn(response, key) && samePublicSetting(expected[key], response[key])) && optional.every((key) => !Object.hasOwn(expected, key) || Object.hasOwn(response, key) && samePublicSetting(expected[key], response[key])) && Object.keys(expected).every((key) => [...required, ...optional].includes(key));
}
function safeSpawnErrorSuffix(error) {
  const code = object3(error) ? error.code : void 0;
  const allowed = /* @__PURE__ */ new Set(["ENOENT", "EACCES", "EPERM", "EINVAL", "ETXTBSY", "ENOEXEC", "EMFILE", "ENFILE", "ENOMEM", "ENOSYS"]);
  return typeof code === "string" && allowed.has(code) ? ` (${code})` : "";
}
function safeTurnErrorSuffix(error) {
  const info = object3(error) ? error.codexErrorInfo : void 0;
  const simple = /* @__PURE__ */ new Set([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "rateLimitExceeded",
    "flexUnavailable",
    "serverOverloaded",
    "cyberPolicy",
    "misalignmentPolicyViolation",
    "tooManyDenials",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other"
  ]);
  if (typeof info === "string" && simple.has(info)) return ` (${info})`;
  if (object3(info)) {
    for (const category of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
      const detail = info[category];
      if (!object3(detail)) continue;
      const status = detail.httpStatusCode;
      const http = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? `; HTTP ${status}` : "";
      return ` (${category}${http})`;
    }
  }
  return "";
}
async function runCodexAppServerTurn(options) {
  if (!options.args.includes("app-server")) throw new Error("Codex app-server invocation is required");
  if (!options.prompt.trim()) throw new Error("Prompt must not be empty");
  if (options.signal?.aborted) {
    const recovered = options.sharedTransport?.resumeSubmission;
    if (recovered && !isCodexSharedSubmissionTerminal(recovered)) {
      throw new CodexAppServerDetachedError({ ...recovered, deliveryPhase: "detached" });
    }
    throw new CodexAppServerCancelledError();
  }
  if (options.sharedTransport?.resumeSubmission?.deliveryPhase === "cancelled") throw new CodexAppServerCancelledError();
  if (options.sharedTransport?.managedOwner && !options.sharedTransport.expectedOwnerSettings && !options.sharedTransport.resumeSubmission) {
    throw new Error("Managed native submission requires explicit per-turn settings");
  }
  if (options.sharedTransport && !options.sharedTransport.managedOwner && !options.sharedTransport.inheritOwnerSettings && (Object.keys(options.turnOptions ?? {}).length || Object.keys(options.threadOptions ?? {}).length || options.args.some((arg) => arg === "-c" || arg === "--config" || arg.startsWith("--config=")))) {
    throw new Error("Shared native queue requires explicit owner-settings inheritance; per-turn configuration was not submitted");
  }
  const registry = options.registry ?? codexUserInputRegistry;
  const maxFrameBytes = options.maxFrameBytes ?? NATIVE_FRAME_BYTES;
  const child = spawn(
    options.sharedTransport ? process.execPath : options.bin,
    options.sharedTransport ? [options.sharedTransport.bridgePath, options.sharedTransport.socketPath] : options.args,
    {
      ...getProviderProcessSpawnOptions(),
      ...options.spawnOptions,
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let sessionId = options.sessionId?.trim() || "";
  let threadPath = null;
  let turnId = "";
  let lastMessage = "";
  let finalMessage = "";
  let nextId = 0;
  let ownTurnKnown = !options.sharedTransport;
  const clientUserMessageId = options.sharedTransport?.resumeSubmission?.clientUserMessageId ?? options.sharedTransport?.clientUserMessageId ?? `code-ai:${randomUUID2()}`;
  let queuedSubmissionId = options.sharedTransport?.resumeSubmission?.queuedSubmissionId ?? null;
  let deliveryPhase = options.sharedTransport?.resumeSubmission?.deliveryPhase ?? "prepared";
  let nativeSubmissionPossible = Boolean(options.sharedTransport?.resumeSubmission);
  let aborting = false;
  let nativeCancelDeadline = null;
  let queuedRecoveryTimer = null;
  let queuedRecoveryBusy = false;
  let submissionPersistence = Promise.resolve();
  const ownedChildThreads = /* @__PURE__ */ new Set();
  let reconcilingSharedSubmission = Boolean(options.sharedTransport?.resumeSubmission);
  const recoveryTerminalTurns = /* @__PURE__ */ new Map();
  let recoveryRequests = [];
  let recoveryRequestBytes = 0;
  const recoveryResolvedRequests = /* @__PURE__ */ new Set();
  let recoveryResolvedBytes = 0;
  const unclaimedChildRequests = /* @__PURE__ */ new Map();
  let unclaimedChildBytes = 0;
  let buffer = "";
  let stopped = false;
  let cancelled = false;
  let failure = null;
  const pending = /* @__PURE__ */ new Map();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => void 0);
  function scope() {
    return { profileId: options.profileId, sessionId, runId: options.runId };
  }
  function submission() {
    return { clientUserMessageId, queuedSubmissionId, turnId: turnId || null, deliveryPhase };
  }
  function persistSubmission() {
    const metadata = submission();
    submissionPersistence = submissionPersistence.then(() => options.sharedTransport?.onSubmissionChanged?.(metadata));
    return submissionPersistence;
  }
  function stop(error, result) {
    if (error && !stopped) process.stderr.write(JSON.stringify({ probe: "CPU-only accepted-input recovery", errorName: error.name, publicReason: /^(MODE_[A-Z_]+|Codex app-server request failed \(.*\)|Codex shared connection lost.*)$/.test(error.message) ? error.message : null, stackSite: error.stack?.split("\n")[1]?.replace(/.*at /, "") }) + "\n");
    if (stopped) return;
    if (queuedRecoveryTimer) clearTimeout(queuedRecoveryTimer);
    if (options.sharedTransport && nativeSubmissionPossible && error && !(error instanceof CodexAppServerCancelledError)) {
      deliveryPhase = "detached";
      error = new CodexAppServerDetachedError(submission());
      void persistSubmission().catch(() => void 0);
    } else if (options.sharedTransport && result) {
      deliveryPhase = "completed";
      void persistSubmission().catch(() => void 0);
    }
    stopped = true;
    failure = error ?? null;
    options.signal?.removeEventListener("abort", abort);
    if (nativeCancelDeadline) clearTimeout(nativeCancelDeadline);
    registry.clearRun(
      options.runId,
      cancelled ? "cancelled" : error ? "failed" : "expired",
      cancelled ? "run_cancelled" : error instanceof CodexAppServerDetachedError ? "native_detached" : error ? "provider_failed" : "turn_completed",
      options.profileId
    );
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error ?? new Error("Codex app-server connection closed"));
    }
    pending.clear();
    buffer = "";
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
      let closed = false;
      const forceTimer = setTimeout(() => terminateProviderProcessTree(child, 500), 3e3);
      const deadline = setTimeout(() => {
        if (!closed) rejectCompletion(new Error("Codex app-server did not shut down after turn completion"));
      }, 5e3);
      forceTimer.unref?.();
      deadline.unref?.();
      child.once("close", () => {
        closed = true;
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        void submissionPersistence.then(() => resolveCompletion(result), () => rejectCompletion(new CodexAppServerDetachedError(submission())));
      });
    }
  }
  function scheduleQueuedRecovery() {
    if (!options.sharedTransport?.recoverQueuedInput || stopped || aborting || ownTurnKnown || !queuedSubmissionId || queuedRecoveryBusy) return;
    queuedRecoveryBusy = true;
    void options.sharedTransport.recoverQueuedInput(sessionId, queuedSubmissionId, clientUserMessageId).catch(() => {
      if (!stopped) stop(new CodexAppServerDetachedError(submission()));
    }).finally(() => {
      queuedRecoveryBusy = false;
      if (!stopped && !ownTurnKnown) {
        queuedRecoveryTimer = setTimeout(scheduleQueuedRecovery, 2e3);
        queuedRecoveryTimer.unref?.();
      }
    });
  }
  function send(frame) {
    if (stopped || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(failure ?? new Error("Codex app-server connection closed"));
    }
    let line;
    try {
      line = JSON.stringify(frame) + "\n";
    } catch {
      return Promise.reject(new Error("Invalid Codex app-server message"));
    }
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) return Promise.reject(new Error("Codex app-server message exceeds the size limit"));
    return new Promise((resolve, reject) => {
      child.stdin.write(line, (error) => error ? reject(new Error("Could not send Codex app-server message")) : resolve());
    });
  }
  function request(method, params) {
    if (stopped) return Promise.reject(failure ?? new Error("Codex app-server connection closed"));
    const id = `code-ai:${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop(new Error(`Codex app-server ${method} timed out`));
      }, options.requestTimeoutMs ?? Math.max(6e4, nativeRpcTimeoutMs(method) + 3e4));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      void send({ id, method, params }).catch((error) => stop(error));
    });
  }
  async function abortShared() {
    if (aborting || stopped) return;
    aborting = true;
    try {
      while (!stopped && !queuedSubmissionId && !ownTurnKnown && nativeSubmissionPossible) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (stopped) return;
      if (!ownTurnKnown && queuedSubmissionId) {
        const deleted = await request("thread/queue/delete", { threadId: sessionId, queuedSubmissionId });
        if (object3(deleted) && deleted.deleted === true) {
          nativeSubmissionPossible = false;
          deliveryPhase = "cancelled";
          await persistSubmission();
          cancelled = true;
          stop(new CodexAppServerCancelledError());
          return;
        }
        if (!ownTurnKnown) {
          const turns = await readSharedHistoryTurns(request, sessionId, clientUserMessageId);
          {
            for (const turn of turns) {
              if (object3(turn) && typeof turn.id === "string" && Array.isArray(turn.items) && turn.items.some((item) => object3(item) && item.type === "userMessage" && item.clientId === clientUserMessageId)) {
                turnId = turn.id;
                ownTurnKnown = true;
                deliveryPhase = "running";
                await persistSubmission();
                if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") {
                  nativeSubmissionPossible = false;
                  deliveryPhase = turn.status === "interrupted" ? "cancelled" : "completed";
                  await persistSubmission();
                  if (turn.status === "interrupted") {
                    cancelled = true;
                    stop(new CodexAppServerCancelledError());
                  } else if (turn.status === "failed") stop(new Error("Codex turn failed" + safeTurnErrorSuffix(turn.error)));
                  else {
                    let message = "", final = "";
                    for (const item of turn.items) {
                      if (object3(item) && item.type === "agentMessage" && typeof item.text === "string") {
                        message = item.text;
                        if (item.phase === "final_answer") final = item.text;
                      }
                    }
                    stop(void 0, { sessionId, threadPath, lastMessage: final || message });
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
        await request("turn/interrupt", { threadId: sessionId, turnId });
        if (!stopped) {
          nativeCancelDeadline = setTimeout(() => stop(new CodexAppServerDetachedError(submission())), options.requestTimeoutMs ?? 6e4);
          nativeCancelDeadline.unref?.();
        }
      } else if (!nativeSubmissionPossible) {
        deliveryPhase = "cancelled";
        await persistSubmission();
        cancelled = true;
        stop(new CodexAppServerCancelledError());
      } else stop(new CodexAppServerDetachedError(submission()));
    } catch {
      if (!stopped) stop(new CodexAppServerDetachedError(submission()));
    }
  }
  function abort() {
    if (stopped) return;
    if (options.sharedTransport) {
      void abortShared();
      return;
    }
    cancelled = true;
    if (sessionId && turnId) {
      void send({ id: `code-ai:interrupt:${++nextId}`, method: "turn/interrupt", params: { threadId: sessionId, turnId } }).then(() => stop(new CodexAppServerCancelledError()), () => stop(new CodexAppServerCancelledError()));
      const timer = setTimeout(() => stop(new CodexAppServerCancelledError()), 500);
      timer.unref?.();
    } else stop(new CodexAppServerCancelledError());
  }
  async function handleServerRequest(frame) {
    if (!rpcId(frame.id)) throw new Error("Invalid Codex server request ID");
    const id = frame.id;
    switch (frame.method) {
      case "item/tool/requestUserInput":
        if (!sessionId) throw new Error("Codex requested user input before starting a session");
        {
          const params = object3(frame.params) ? frame.params : {};
          const provenOwnRequest = ownTurnKnown && (params.threadId === sessionId && params.turnId === turnId || typeof params.threadId === "string" && ownedChildThreads.has(params.threadId));
          registry.register(scope(), id, frame.params, (response) => send({ id, result: response }), {
            reattachDetached: Boolean(options.sharedTransport?.resumeSubmission && provenOwnRequest)
          });
        }
        return;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        await send({ id, result: { decision: "decline" } });
        options.onApprovalDenied?.(frame.method);
        return;
      case "item/permissions/requestApproval":
        await send({ id, result: { permissions: {}, scope: "turn" } });
        options.onApprovalDenied?.(frame.method);
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        await send({ id, result: { decision: { denied: { rejection: "Approval is not available in this client." } } } });
        options.onApprovalDenied?.(frame.method);
        return;
      case "mcpServer/elicitation/request":
        await send({ id, result: { action: "decline" } });
        return;
      case "item/tool/call":
        await send({ id, result: { success: false, contentItems: [{ type: "inputText", text: "This client does not support dynamic tools." }] } });
        return;
      default:
        await send({ id, error: { code: -32601, message: "This client does not support this server request." } });
    }
  }
  function finishSharedReconciliation(replayOwnRequests) {
    reconcilingSharedSubmission = false;
    const requests = recoveryRequests;
    recoveryRequests = [];
    recoveryRequestBytes = 0;
    if (replayOwnRequests) for (const frame of requests) handleFrame(frame);
  }
  function recoveryRequestKey(threadId, requestId) {
    return typeof threadId === "string" && rpcId(requestId) ? JSON.stringify([threadId, typeof requestId, requestId]) : null;
  }
  function recordRecoveryResolution(threadId, requestId) {
    const key = recoveryRequestKey(threadId, requestId);
    if (recoveryResolvedRequests.has(key)) return;
    recoveryRequests = recoveryRequests.filter((frame) => {
      const params = object3(frame.params) ? frame.params : {};
      if (recoveryRequestKey(params.threadId, frame.id) !== key) return true;
      recoveryRequestBytes -= Buffer.byteLength(JSON.stringify(frame));
      return false;
    });
    const children = unclaimedChildRequests.get(threadId);
    if (children) {
      const remaining = children.filter((frame) => {
        if (recoveryRequestKey(threadId, frame.id) !== key) return true;
        unclaimedChildBytes -= Buffer.byteLength(JSON.stringify(frame));
        return false;
      });
      if (remaining.length) unclaimedChildRequests.set(threadId, remaining);
      else unclaimedChildRequests.delete(threadId);
    }
    const bytes = Buffer.byteLength(key);
    if (recoveryResolvedRequests.size + recoveryRequests.length >= 64 || recoveryResolvedBytes + recoveryRequestBytes + bytes > maxFrameBytes) {
      stop(new Error("Codex shared recovery resolution metadata exceeds the size limit"));
      return;
    }
    recoveryResolvedRequests.add(key);
    recoveryResolvedBytes += bytes;
  }
  function registerOwnedSpawn(item, senderThreadId) {
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent" || item.senderThreadId !== senderThreadId || !Array.isArray(item.receiverThreadIds)) return;
    for (const id of item.receiverThreadIds) {
      if (typeof id !== "string" || id === sessionId) continue;
      if (!ownedChildThreads.has(id) && ownedChildThreads.size >= 256) {
        stop(new Error("Codex shared child custody exceeds the size limit"));
        return;
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
  async function recoverOwnedChildren(items) {
    for (const item of items) if (object3(item)) registerOwnedSpawn(item, sessionId);
    const resumed = /* @__PURE__ */ new Set();
    for (const id of ownedChildThreads) {
      if (stopped || resumed.has(id)) continue;
      resumed.add(id);
      await request("thread/resume", { threadId: id, excludeTurns: true });
      if (stopped) return;
      const turns = await readSharedHistoryTurns(request, id);
      for (const turn of turns) {
        if (object3(turn) && Array.isArray(turn.items)) for (const item of turn.items) {
          if (object3(item)) registerOwnedSpawn(item, id);
        }
      }
    }
  }
  function handleFrame(raw) {
    if (!object3(raw)) {
      stop(new Error("Invalid Codex app-server frame"));
      return;
    }
    const frame = raw;
    if (options.sharedTransport && typeof frame.method === "string") {
      const params2 = object3(frame.params) ? frame.params : {};
      const item = object3(params2.item) ? params2.item : {};
      if (reconcilingSharedSubmission && params2.threadId === sessionId && frame.method === "turn/completed" && object3(params2.turn) && typeof params2.turn.id === "string" && ["completed", "failed", "interrupted"].includes(params2.turn.status)) {
        if (recoveryTerminalTurns.size >= 32) {
          stop(new Error("Shared reconciliation event capacity exceeded"));
          return;
        }
        recoveryTerminalTurns.set(params2.turn.id, { id: params2.turn.id, status: params2.turn.status, error: params2.turn.error });
      }
      if (options.sharedTransport.resumeSubmission && frame.method === "serverRequest/resolved" && typeof params2.threadId === "string" && rpcId(params2.requestId) && (reconcilingSharedSubmission || params2.threadId === sessionId || ownedChildThreads.has(params2.threadId) || unclaimedChildRequests.has(params2.threadId))) {
        recordRecoveryResolution(params2.threadId, params2.requestId);
        if (stopped) return;
      }
      const replayKey = Object.hasOwn(frame, "id") ? recoveryRequestKey(params2.threadId, frame.id) : null;
      if (replayKey && recoveryResolvedRequests.has(replayKey)) return;
      if (!ownTurnKnown && params2.threadId === sessionId && (frame.method === "item/started" || frame.method === "item/completed") && item.type === "userMessage" && item.clientId === clientUserMessageId && typeof params2.turnId === "string" && params2.turnId) {
        turnId = params2.turnId;
        deliveryPhase = "running";
        ownTurnKnown = true;
        void persistSubmission().catch(() => stop(new CodexAppServerDetachedError(submission())));
        finishSharedReconciliation(true);
      }
      if (!ownTurnKnown) {
        if (reconcilingSharedSubmission && Object.hasOwn(frame, "id") && typeof params2.threadId === "string" && typeof params2.turnId === "string") {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (recoveryRequestBytes + recoveryResolvedBytes + bytes > maxFrameBytes || recoveryRequests.length + recoveryResolvedRequests.size >= 64) {
            stop(new Error("Codex shared recovery request buffer exceeds the size limit"));
            return;
          }
          recoveryRequestBytes += bytes;
          recoveryRequests.push(frame);
        }
        return;
      }
      const eventTurnId = typeof params2.turnId === "string" ? params2.turnId : object3(params2.turn) && typeof params2.turn.id === "string" ? params2.turn.id : null;
      const isOwnParent = params2.threadId === sessionId && (eventTurnId === turnId || eventTurnId === null && !Object.hasOwn(frame, "id"));
      const isOwnedChild = typeof params2.threadId === "string" && ownedChildThreads.has(params2.threadId);
      if (!isOwnParent && !isOwnedChild) {
        if (Object.hasOwn(frame, "id") && typeof params2.threadId === "string" && params2.threadId !== sessionId && eventTurnId !== null) {
          const bytes = Buffer.byteLength(JSON.stringify(frame));
          if (unclaimedChildBytes + bytes > maxFrameBytes || unclaimedChildRequests.size >= 32) {
            stop(new Error("Codex shared child request buffer exceeds the size limit"));
            return;
          }
          unclaimedChildBytes += bytes;
          const waiting = unclaimedChildRequests.get(params2.threadId) ?? [];
          waiting.push(frame);
          unclaimedChildRequests.set(params2.threadId, waiting);
        }
        return;
      }
      if (typeof params2.threadId === "string") registerOwnedSpawn(item, params2.threadId);
    }
    if (typeof frame.method === "string" && Object.hasOwn(frame, "id")) {
      void handleServerRequest(frame).catch((error) => stop(error));
      return;
    }
    if (Object.hasOwn(frame, "id")) {
      const call = typeof frame.id === "string" ? pending.get(frame.id) : void 0;
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.error) {
        const code = typeof frame.error.code === "number" && Number.isInteger(frame.error.code) ? frame.error.code : "unknown";
        const data = object3(frame.error.data) ? frame.error.data : {};
        const admission = options.sharedTransport?.managedOwner && (data.codeAiAdmission === "notAccepted" || data.codeAiAdmission === "uncertain") ? data.codeAiAdmission : null;
        const retryable = admission === "notAccepted" && typeof data.reason === "string" && [
          "thread-admission-reserved",
          "foreign-queue-pending",
          "owner-settings-reserved",
          "own-turn-settings-reserved",
          "reservation-journal-unavailable"
        ].includes(data.reason);
        const diagnostic = validatePublicRpcDiagnostic(data.codeAiDiagnostic) ?? publicRpcDiagnostic("other", code, frame.error.message);
        call.reject(new CodexRpcRejectedError(code, admission, retryable, diagnostic));
      } else if (Object.hasOwn(frame, "result")) call.resolve(frame.result);
      else call.reject(new Error("Invalid Codex app-server response"));
      return;
    }
    if (typeof frame.method !== "string") {
      stop(new Error("Invalid Codex app-server notification"));
      return;
    }
    const params = object3(frame.params) ? frame.params : {};
    if (frame.method === "serverRequest/resolved" && typeof params.threadId === "string" && rpcId(params.requestId)) {
      registry.resolveNative(scope(), params.requestId, params.threadId);
    }
    const ownThread = params.threadId === sessionId;
    if (ownThread && (frame.method === "turn/started" || frame.method === "turn/completed") && object3(params.turn) && typeof params.turn.id === "string") {
      if (!turnId) turnId = params.turn.id;
    }
    if (ownThread && frame.method === "item/completed" && object3(params.item) && params.item.type === "agentMessage" && typeof params.item.text === "string") {
      const text = params.item.text.trim();
      lastMessage = text;
      if (params.item.phase === "final_answer") finalMessage = text;
    }
    if (ownThread && frame.method === "turn/completed" && object3(params.turn) && (!turnId || params.turn.id === turnId)) {
      nativeSubmissionPossible = false;
      if (options.sharedTransport) {
        deliveryPhase = params.turn.status === "interrupted" ? "cancelled" : "completed";
        void persistSubmission().catch(() => void 0);
      }
      const status = params.turn.status;
      if (status === "completed") {
        stop(void 0, { sessionId, lastMessage: finalMessage || lastMessage, threadPath });
      } else if (status === "interrupted") {
        cancelled = true;
        stop(new CodexAppServerCancelledError());
      } else stop(new Error("Codex turn failed" + safeTurnErrorSuffix(params.turn.error)));
      return;
    }
    options.onNotification?.(frame.method, frame.params);
  }
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    if (stopped) return;
    buffer += chunk;
    let newline;
    while (!stopped && (newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
        stop(new Error("Codex app-server frame exceeds the size limit"));
        return;
      }
      if (!line.trim()) continue;
      try {
        handleFrame(JSON.parse(line));
      } catch {
        stop(new Error("Invalid Codex app-server JSON frame"));
        return;
      }
    }
    if (!stopped && Buffer.byteLength(buffer, "utf8") > maxFrameBytes) stop(new Error("Codex app-server frame exceeds the size limit"));
  });
  child.on("error", (error) => stop(new Error("Could not start Codex app-server" + safeSpawnErrorSuffix(error))));
  child.stdin.on("error", () => {
    if (!stopped) stop(new Error("Codex app-server input closed"));
  });
  child.on("close", () => {
    if (!stopped) stop(options.sharedTransport && nativeSubmissionPossible ? new CodexAppServerDetachedError(submission()) : cancelled ? new CodexAppServerCancelledError() : new Error("Codex app-server exited before turn completion"));
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.onSpawn?.(child);
    if (options.signal?.aborted) abort();
    const initialized = await request("initialize", {
      clientInfo: { name: "code-ai", title: "Code AI", version: "1.0.0" },
      capabilities: { experimentalApi: true }
    });
    if (options.sharedTransport?.managedOwner && (!object3(initialized) || !object3(initialized.codeAiSharedOwner) || initialized.codeAiSharedOwner.version !== 1 || initialized.codeAiSharedOwner.turnSettings !== true)) {
      throw new Error("The qualified shared Codex owner is unavailable; no input was submitted");
    }
    await send({ method: "initialized", params: {} });
    const initialSharedSettings = !sessionId && options.sharedTransport?.managedOwner ? options.sharedTransport.expectedOwnerSettings : null;
    const threadResult = await request(sessionId ? "thread/resume" : "thread/start", {
      ...!options.sharedTransport ? options.threadOptions : {},
      cwd: options.cwd,
      ...initialSharedSettings ? {
        model: initialSharedSettings.model,
        ...initialSharedSettings.reasoningEffort ? { config: {
          model_reasoning_effort: initialSharedSettings.reasoningEffort
        } } : {}
      } : {},
      ...sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false }
    });
    if (!object3(threadResult) || !object3(threadResult.thread) || typeof threadResult.thread.id !== "string" || !threadResult.thread.id.trim()) throw new Error("Codex app-server did not return a thread ID");
    sessionId = threadResult.thread.id;
    threadPath = typeof threadResult.thread.path === "string" ? threadResult.thread.path : null;
    await options.onSessionStarted?.(sessionId);
    if (options.sharedTransport?.expectedOwnerSettings && !options.sharedTransport.managedOwner && !options.sharedTransport.resumeSubmission && !ownerSettingsMatch(options.sharedTransport.expectedOwnerSettings, threadResult)) {
      throw new CodexSharedOwnerSettingsMismatchError();
    }
    if (options.signal?.aborted) {
      abort();
      return await completion;
    }
    if (options.sharedTransport) {
      if (options.sharedTransport.resumeSubmission) {
        nativeSubmissionPossible = true;
        if (!options.sharedTransport.resumeSubmission.turnId) {
          const queue = await request("thread/queue/list", { threadId: sessionId, limit: 100 });
          const pendingOwn = object3(queue) && Array.isArray(queue.data) ? queue.data.find((item) => object3(item) && item.clientUserMessageId === clientUserMessageId) : null;
          if (object3(pendingOwn) && typeof pendingOwn.id === "string") {
            queuedSubmissionId = pendingOwn.id;
            deliveryPhase = "queued";
            await persistSubmission();
            finishSharedReconciliation(false);
            scheduleQueuedRecovery();
            return await completion;
          }
        }
        const recoveredTurns = await readSharedHistoryTurns(
          request,
          sessionId,
          clientUserMessageId,
          options.sharedTransport.resumeSubmission.turnId || void 0
        );
        for (const turn of recoveredTurns) {
          if (!object3(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items) || !turn.items.some((item) => object3(item) && item.type === "userMessage" && item.clientId === clientUserMessageId)) continue;
          const terminal = recoveryTerminalTurns.get(turn.id);
          if (terminal) Object.assign(turn, terminal);
          turnId = turn.id;
          ownTurnKnown = true;
          deliveryPhase = "running";
          for (const item of turn.items) if (object3(item)) registerOwnedSpawn(item, sessionId);
          await persistSubmission();
          finishSharedReconciliation(turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed");
          if (turn.status === "completed") {
            let message = "";
            let final = "";
            for (const item of turn.items) {
              if (object3(item) && item.type === "agentMessage" && typeof item.text === "string") {
                message = item.text;
                if (item.phase === "final_answer") final = item.text;
              }
            }
            stop(void 0, { sessionId, threadPath, lastMessage: final || message });
          } else if (turn.status === "interrupted") {
            nativeSubmissionPossible = false;
            deliveryPhase = "cancelled";
            await persistSubmission();
            cancelled = true;
            stop(new CodexAppServerCancelledError());
          } else if (turn.status === "failed") {
            nativeSubmissionPossible = false;
            deliveryPhase = "completed";
            await persistSubmission();
            throw new Error("Codex recovered native turn failed" + safeTurnErrorSuffix(turn.error));
          }
          if (!stopped) await recoverOwnedChildren(turn.items);
          return await completion;
        }
        let cursor;
        for (let page = 0; page < 100; page++) {
          const list = await request("thread/queue/list", { threadId: sessionId, limit: 100, ...cursor ? { cursor } : {} });
          if (!object3(list) || !Array.isArray(list.data)) throw new CodexAppServerDetachedError(submission());
          const queued2 = list.data.find((item) => object3(item) && item.clientUserMessageId === clientUserMessageId);
          if (object3(queued2) && typeof queued2.id === "string") {
            queuedSubmissionId = queued2.id;
            deliveryPhase = "queued";
            await persistSubmission();
            finishSharedReconciliation(false);
            scheduleQueuedRecovery();
            return await completion;
          }
          if (typeof list.nextCursor !== "string" || !list.nextCursor) break;
          cursor = list.nextCursor;
        }
        throw new CodexAppServerDetachedError(submission());
      }
      await persistSubmission();
      nativeSubmissionPossible = true;
      let queued;
      try {
        queued = await request("thread/queue/add", {
          threadId: sessionId,
          clientUserMessageId,
          ...options.sharedTransport.managedOwner && options.sharedTransport.expectedOwnerSettings ? {
            codeAiExpectedCollaborationMode: "default",
            codeAiTurnSettings: {
              model: options.sharedTransport.expectedOwnerSettings.model,
              effort: options.sharedTransport.expectedOwnerSettings.reasoningEffort,
              cwd: options.sharedTransport.expectedOwnerSettings.cwd,
              approvalPolicy: options.sharedTransport.expectedOwnerSettings.approvalPolicy,
              sandboxPolicy: options.sharedTransport.expectedOwnerSettings.sandbox
            }
          } : {},
          input: [
            { type: "text", text: options.prompt, text_elements: [] },
            ...(options.imagePaths ?? []).map((imagePath) => ({ type: "localImage", path: imagePath }))
          ]
        });
      } catch (error) {
        if (error instanceof CodexRpcRejectedError) {
          if (!options.sharedTransport.managedOwner || error.admission === "notAccepted") {
            nativeSubmissionPossible = false;
          }
          if (options.sharedTransport.managedOwner && error.admission === "notAccepted") {
            throw new CodexSharedAdmissionRejectedError(error.retryableAdmission);
          }
        }
        throw error;
      }
      if (!object3(queued) || !object3(queued.queuedSubmission) || typeof queued.queuedSubmission.id !== "string" || queued.queuedSubmission.clientUserMessageId !== clientUserMessageId) {
        throw new CodexAppServerDetachedError(submission());
      }
      queuedSubmissionId = queued.queuedSubmission.id;
      if (!ownTurnKnown) deliveryPhase = "queued";
      await persistSubmission();
      scheduleQueuedRecovery();
      return await completion;
    }
    const turnResult = await request("turn/start", {
      ...options.turnOptions,
      threadId: sessionId,
      input: [
        { type: "text", text: options.prompt, text_elements: [] },
        ...(options.imagePaths ?? []).map((imagePath) => ({ type: "localImage", path: imagePath }))
      ]
    });
    if (!object3(turnResult) || !object3(turnResult.turn) || typeof turnResult.turn.id !== "string") {
      throw new Error("Codex app-server did not return a turn ID");
    }
    turnId = turnResult.turn.id;
    ownTurnKnown = true;
    return await completion;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error("Codex app-server failed");
    stop(normalizedError);
    return await completion;
  }
}
export {
  CodexAppServerCancelledError,
  CodexAppServerDetachedError,
  CodexSharedAdmissionRejectedError,
  CodexSharedOwnerSettingsMismatchError,
  isCodexSharedOwnerSettingsMismatchError,
  isCodexSharedSubmissionTerminal,
  runCodexAppServerTurn
};
