// Durable custody metadata only. No prompt, settings, credentials or native
// response object may enter this record. Unknown custody must not be replayed.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const PHASES = new Set(['prepared', 'queued', 'running', 'completed', 'cancelled', 'detached']);

export function nativeClientMessageId(runId) {
  if (typeof runId !== 'string' || !SAFE_ID.test(runId) || runId.length > 128) {
    throw new Error('Invalid durable native run identity');
  }
  return `code-ai:${runId}`;
}

export function normalizeNativeSubmission(value, runId) {
  if (value == null) return null;
  const expected = nativeClientMessageId(runId);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.clientUserMessageId !== expected || !PHASES.has(value.deliveryPhase)
    || ![value.queuedSubmissionId, value.turnId].every(id => id === null || (typeof id === 'string' && SAFE_ID.test(id)))) {
    throw new Error('Native submission custody metadata is invalid; refusing replay');
  }
  return {
    clientUserMessageId: expected,
    queuedSubmissionId: value.queuedSubmissionId,
    turnId: value.turnId,
    deliveryPhase: value.deliveryPhase,
  };
}

export function nativeSubmissionNeedsReconciliation(value) {
  return Boolean(value && value.deliveryPhase !== 'completed' && value.deliveryPhase !== 'cancelled');
}

export function recoverNativeSubmission(value, runId) {
  const record = normalizeNativeSubmission(value, runId);
  return record ? { ...record, deliveryPhase: nativeSubmissionNeedsReconciliation(record) ? 'detached' : record.deliveryPhase } : null;
}
