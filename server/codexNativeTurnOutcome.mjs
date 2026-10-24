/** Native terminal metadata only. Assistant text and transient error notices are
 * deliberately not inputs: only the owner's failed turn proves noncompletion.
 */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
import { isCodexModelCapacityMessage } from '../shared/codexCapacity.mjs';

const SIMPLE_CODES = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
  'flexUnavailable', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials',
  'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other',
]);
const HTTP_CODES = [
  'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts',
];

/** @typedef {'model_capacity' | 'model_unavailable' | 'usage_limit' | 'rate_limit' | 'context_limit' | 'provider_failure'} CodexNativeTurnFailureKind */
/** @typedef {{version: 1, kind: CodexNativeTurnFailureKind, code: string | null, httpStatusCode: number | null}} CodexNativeTurnFailure */

/** Returns a closed public contract, never the native message/additionalDetails.
 * @param {unknown} error
 * @returns {Readonly<CodexNativeTurnFailure>}
 */
export function codexNativeTurnFailure(error) {
  const info = object(error) ? error.codexErrorInfo : undefined;
  let code = null;
  let httpStatusCode = null;
  if (typeof info === 'string' && SIMPLE_CODES.has(info)) code = info;
  else if (object(info)) {
    for (const category of HTTP_CODES) {
      if (!object(info[category])) continue;
      code = category;
      const status = info[category].httpStatusCode;
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) httpStatusCode = status;
      break;
    }
  }
  /** @type {CodexNativeTurnFailureKind} */
  const kind = isCodexModelCapacityMessage(object(error) ? error.message : null) || code === 'serverOverloaded' ? 'model_capacity'
    : code === 'flexUnavailable' ? 'model_unavailable'
    : code === 'usageLimitExceeded' || code === 'sessionBudgetExceeded' ? 'usage_limit'
      : code === 'rateLimitExceeded' ? 'rate_limit'
        : code === 'contextWindowExceeded' ? 'context_limit' : 'provider_failure';
  return Object.freeze({ version: 1, kind, code, httpStatusCode });
}

/** Used only after an authoritative native failed terminal state. A notification
 * with willRetry=true/false alone must never construct this terminal error.
 */
export class CodexAppServerTurnFailedError extends Error {
  /** @param {unknown} nativeError @param {boolean} [recovered] */
  constructor(nativeError, recovered = false) {
    const failure = codexNativeTurnFailure(nativeError);
    const suffix = failure.code ? ` (${failure.code}${failure.httpStatusCode === null ? '' : `; HTTP ${failure.httpStatusCode}`})` : '';
    super(`${recovered ? 'Codex recovered native turn failed' : 'Codex turn failed'}${suffix}`);
    this.name = 'CodexAppServerTurnFailedError';
    this.failure = failure;
  }
}

/** @param {unknown} error @returns {error is CodexAppServerTurnFailedError} */
export function isCodexAppServerTurnFailedError(error) {
  return error instanceof CodexAppServerTurnFailedError;
}
