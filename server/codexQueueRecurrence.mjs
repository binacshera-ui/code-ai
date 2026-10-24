import { randomUUID } from 'node:crypto';
import { nativeClientMessageId, normalizeNativeSubmission, nativeSubmissionNeedsReconciliation } from './codexSharedSubmission.mjs';

// A schedule is a stable UI/cancellation identity, not a native input identity.
// Rotate only at a confirmed occurrence boundary; ambiguous input keeps custody.
export function advanceRecurringNativeSubmission(item, runId = randomUUID()) {
  nativeClientMessageId(runId);
  const previous = normalizeNativeSubmission(item.nativeSubmission, item.nativeRunId || item.id);
  if (nativeSubmissionNeedsReconciliation(previous)) {
    throw new Error('Cannot advance recurring input with unresolved native custody');
  }
  if (previous) item.lastRunNativeSubmission = { runId: item.nativeRunId || item.id, ...previous };
  item.nativeRunId = runId;
  item.nativeSubmission = null;
  item.nativeReconcileAfter = null;
  item.nativeCancellationRequestedAt = null;
  item.progressGuardWarning = null;
}

export function repairLegacyRecurringNativeSubmission(item) {
  if (item.scheduleMode !== 'recurring' || item.nativeRunId
      || !['scheduled', 'queued'].includes(item.status) || !item.nativeSubmission
      || nativeSubmissionNeedsReconciliation(item.nativeSubmission)
      || !Number.isFinite(Date.parse(item.lastRunAt))
      || !(Date.parse(item.scheduledAt) > Date.parse(item.lastRunAt))) return false;
  // Old releases advanced the date but retained the previous completed input.
  // The next date + final outcome are proof this is a different occurrence.
  advanceRecurringNativeSubmission(item);
  return true;
}
