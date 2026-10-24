import assert from 'node:assert/strict';
import test from 'node:test';
import { codexNativeTurnFailure, CodexAppServerTurnFailedError, isCodexAppServerTurnFailedError } from './codexNativeTurnOutcome.mjs';

for (const [code, kind] of [
  ['flexUnavailable', 'model_unavailable'],
  ['serverOverloaded', 'model_capacity'],
  ['usageLimitExceeded', 'usage_limit'],
  ['sessionBudgetExceeded', 'usage_limit'],
  ['rateLimitExceeded', 'rate_limit'],
  ['contextWindowExceeded', 'context_limit'],
  ['unauthorized', 'provider_failure'],
  ['badRequest', 'provider_failure'],
]) {
  test(`native ${code} has a stable terminal failure kind without private text`, () => {
    const error = new CodexAppServerTurnFailedError({ codexErrorInfo: code, message: 'PRIVATE_MESSAGE', additionalDetails: 'PRIVATE_DETAILS' });
    assert.deepEqual(error.failure, { version: 1, kind, code, httpStatusCode: null });
    assert.equal(isCodexAppServerTurnFailedError(error), true);
    assert.equal(Object.isFrozen(error.failure), true);
    assert.equal(JSON.stringify(error).includes('PRIVATE'), false);
    assert.equal(error.message.includes('PRIVATE'), false);
  });
}

test('the exact observed native capacity message is not a quota exhaustion', () => {
  const error = new CodexAppServerTurnFailedError({ message: 'Selected model is at capacity. Please try a different model.' });
  assert.equal(error.failure.kind, 'model_capacity');
  assert.equal(error.message.includes('PRIVATE'), false);
});

test('HTTP detail keeps only the known category and an integer HTTP status', () => {
  const error = new CodexAppServerTurnFailedError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503, message: 'PRIVATE' } } }, true);
  assert.deepEqual(error.failure, { version: 1, kind: 'provider_failure', code: 'httpConnectionFailed', httpStatusCode: 503 });
  assert.equal(error.message, 'Codex recovered native turn failed (httpConnectionFailed; HTTP 503)');
  for (const status of [-1, 600, 503.1, '503', null]) {
    assert.equal(codexNativeTurnFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } }).httpStatusCode, null);
  }
});

test('unknown codes, arbitrary assistant prose and quoted errors never supply failure classification', () => {
  for (const value of [
    'This model is unavailable. Try another model.',
    { message: 'This model is unavailable. Try another model.' },
    { codexErrorInfo: 'PRIVATE_NEW_CODE', message: 'PRIVATE_MESSAGE' },
    { codexErrorInfo: { PRIVATE_CODE: { httpStatusCode: 429 } } },
    { codexErrorInfo: { httpConnectionFailed: 'PRIVATE' } },
    null,
  ]) {
    assert.deepEqual(codexNativeTurnFailure(value), { version: 1, kind: 'provider_failure', code: null, httpStatusCode: null });
    assert.equal(isCodexAppServerTurnFailedError(value), false);
  }
  assert.equal(isCodexAppServerTurnFailedError(new Error('Codex turn failed (usageLimitExceeded)')), false);
});
