import { isCodexModelCapacityMessage } from '../shared/codexCapacity.mjs';
import { nativeSubmissionNeedsReconciliation } from './codexSharedSubmission.mjs';

export const MAX_CAPACITY_FAILURES = 2;
export const CAPACITY_CONTINUATION_DELAY_MS = 60_000;
// Exact same task-continuation instruction as the existing UI action.
export const CAPACITY_CONTINUATION_PROMPT = 'Continue from the exact point where the previous turn was aborted. Continue the same task without restarting, do not repeat completed work, and finish the response fully until the task is complete.';

export function isCapacityContinuationEligible(item, now = Date.now()) {
  const failed = item.status === 'failed' || (item.scheduleMode === 'recurring' && item.status === 'scheduled' && item.lastRunStatus === 'failed');
  const failuresSoFar = 1 + (item.capacityRetry?.attempt || 0);
  return Boolean(failed && failuresSoFar < MAX_CAPACITY_FAILURES && item.sessionId && !item.nativeCancellationRequestedAt && !item.stopDecisionForItemId
    && (['model_capacity','rate_limit'].includes(item.failureKind) || (!item.failureKind && isCodexModelCapacityMessage(item.error)))
    && !nativeSubmissionNeedsReconciliation(item.nativeSubmission)
    && (!item.stopPolicy || (Date.parse(item.stopPolicy.stopAt) > now
      && ['armed', 'not-needed'].includes(item.stopPolicy.status))));
}

export function capacityContinuationPlan(source) {
  const failedAt = source.capacityRetryPendingAt;
  if (!Number.isFinite(Date.parse(failedAt)) || !isCapacityContinuationEligible(source)) return null;
  return {
    clientRequestId: `capacity-continue:${source.id}:${failedAt}`,
    scheduledAt: source.modelRetry?.retryAt || new Date(Date.parse(failedAt) + CAPACITY_CONTINUATION_DELAY_MS).toISOString(),
    prompt: CAPACITY_CONTINUATION_PROMPT,
    promptPreview: `המשך אוטומטי אחרי עומס במודל · ניסיון ${(source.capacityRetry?.attempt || 0) + 1}`,
    capacityRetry: {
      sourceItemId: source.id, rootItemId: source.capacityRetry?.rootItemId || source.id,
      sourceStartedAt: source.startedAt, failedAt,
      sourceWorkModeRunId: source.workModeRunId || null,
      attempt: (source.capacityRetry?.attempt || 0) + 1,
    },
  };
}

export function sameCapacityConversation(a, b) {
  return a.profileId === b.profileId && (a.queueKey === b.queueKey
    || Boolean(a.sessionId && b.sessionId && a.sessionId === b.sessionId));
}

export function capacityContinuationObsolete(item, source, rows) {
  const retry = item.capacityRetry;
  if (!source || source.status === 'cancelled' || source.startedAt !== retry.sourceStartedAt) return true;
  return rows.some(other => other.id !== item.id && other.id !== source.id && !other.capacityRetry
    && sameCapacityConversation(item, other) && !['draft', 'cancelled'].includes(other.status)
    && (Date.parse(other.createdAt) >= Date.parse(retry.failedAt)
      || (['queued', 'running', 'cancelling'].includes(other.status)
        && Date.parse(other.scheduledAt) <= Date.parse(item.scheduledAt))));
}

export function nativeActivityAfterCapacityFailure(timeline, failedAt) {
  return timeline.some(entry => Date.parse(entry.timestamp) > Date.parse(failedAt)
    && (entry.entryType === 'message' && (entry.role === 'user' || entry.kind === 'final')
      || entry.entryType === 'tool'
      || entry.entryType === 'status' && ['running', 'inProgress', 'completed', 'cancelled', 'aborted'].includes(entry.status)));
}

export function capacityFailureHoldCanResume(run, item) {
  return run.runId === item.capacityRetry?.sourceWorkModeRunId
    && run.profileId === (item.sourceProfileId || item.profileId)
    && [item.sessionId, item.queueKey].includes(run.sessionKey)
    && run.status === 'incomplete' && run.outcome === 'failed';
}
