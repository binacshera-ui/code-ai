import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeClientMessageId, normalizeNativeSubmission, nativeSubmissionNeedsReconciliation, recoverNativeSubmission } from './codexSharedSubmission.mjs';
const prepared = { clientUserMessageId: 'code-ai:run-1', queuedSubmissionId: null, turnId: null, deliveryPhase: 'prepared' };
test('stable queue identity is generated before enqueue and contains only custody metadata', () => {
  assert.equal(nativeClientMessageId('run-1'), prepared.clientUserMessageId);
  assert.deepEqual(normalizeNativeSubmission({ ...prepared, prompt: 'not retained', credential: 'synthetic' }, 'run-1'), prepared);
});
test('all potentially accepted phases recover as detached without resubmission', () => {
  for (const phase of ['prepared', 'queued', 'running', 'detached']) {
    const recovered = recoverNativeSubmission({ ...prepared, deliveryPhase: phase }, 'run-1');
    assert.equal(recovered.deliveryPhase, 'detached');
    assert.equal(nativeSubmissionNeedsReconciliation(recovered), true);
  }
  const completed = recoverNativeSubmission({ ...prepared, deliveryPhase: 'completed' }, 'run-1');
  assert.equal(completed.deliveryPhase, 'completed');
  assert.equal(nativeSubmissionNeedsReconciliation(completed), false);
  const cancelled = recoverNativeSubmission({ ...prepared, deliveryPhase: 'cancelled' }, 'run-1');
  assert.equal(cancelled.deliveryPhase, 'cancelled');
  assert.equal(nativeSubmissionNeedsReconciliation(cancelled), false);
});
test('foreign or corrupt custody fails closed rather than dropping the ID', () => {
  for (const value of [{ ...prepared, clientUserMessageId: 'foreign' }, { ...prepared, turnId: {} },
    { ...prepared, queuedSubmissionId: 'bad\nidentity' }, { ...prepared, deliveryPhase: 'retry' }]) {
    assert.throws(() => normalizeNativeSubmission(value, 'run-1'), /refusing replay/);
  }
  assert.equal(normalizeNativeSubmission(undefined, 'run-1'), null);
  assert.throws(() => nativeClientMessageId('bad\nrun'), /Invalid/);
});
