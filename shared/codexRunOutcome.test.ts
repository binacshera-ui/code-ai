import assert from 'node:assert/strict';
import test from 'node:test';
import { queueFailureKind, failureKindLabel, latestNativeTimelineFailure } from './codexRunOutcome.ts';
test('native custody completion never overrides failed run; quota errors have actionable copy', () => {
  assert.equal(queueFailureKind({ status: 'failed', error: 'Codex turn failed (usageLimitExceeded)' }), 'usage_limit');
  assert.match(failureKindLabel('usage_limit'), /מודל אחר/);
  assert.equal(queueFailureKind({ status: 'completed', error: 'Codex turn failed (usageLimitExceeded)' }), null);
  assert.equal(queueFailureKind({ status: 'failed', error: 'The assistant quoted usageLimitExceeded' }), null);
});

test('a GUI-native failed status at capacity is incomplete without any queue row', () => {
  const reason = 'Selected model is at capacity. Please try a different model.';
  const failure = { id: 'native-failed', timestamp: '2026-10-20T08:03:44.099Z', entryType: 'status', status: 'failed', subtitle: reason };
  assert.equal(latestNativeTimelineFailure([failure])?.failureKind, 'model_capacity');
  assert.match(failureKindLabel('model_capacity'), /עמוס/);
  assert.equal(queueFailureKind({ status: 'failed', error: reason }), 'model_capacity');
  for (const later of [
    { id: 'new', timestamp: 'later', entryType: 'message', role: 'user' },
    { id: 'final', timestamp: 'later', entryType: 'message', role: 'assistant', kind: 'final', subtitle: reason },
    { id: 'done', timestamp: 'later', entryType: 'status', status: 'completed' },
  ]) assert.equal(latestNativeTimelineFailure([failure, later]), null);
  assert.equal(latestNativeTimelineFailure([{ ...failure, entryType: 'message', role: 'assistant', kind: 'final' }]), null);
});
