import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTranscriptMutation,
  mergeEarlierTimelineEntries,
  resolveScrollTopAfterTimelineChange,
  resolveTranscriptScrollIntent,
  shouldRequestEarlierTimeline,
} from './transcriptScrollPolicy.js';

test('the first upward movement leaves live-follow mode even while still near the bottom', () => {
  assert.deepEqual(resolveTranscriptScrollIntent({
    mode: 'follow-live',
    previousScrollTop: 1_000,
    scrollTop: 990,
    distanceFromBottom: 10,
  }), {
    mode: 'reading-history',
    enteredReadingMode: true,
  });
});

test('reading mode resumes live-follow only after returning to the bottom', () => {
  assert.equal(resolveTranscriptScrollIntent({
    mode: 'reading-history',
    previousScrollTop: 980,
    scrollTop: 980,
    distanceFromBottom: 20,
  }).mode, 'reading-history');
  assert.equal(resolveTranscriptScrollIntent({
    mode: 'reading-history',
    previousScrollTop: 500,
    scrollTop: 550,
    distanceFromBottom: 300,
  }).mode, 'reading-history');
  assert.equal(resolveTranscriptScrollIntent({
    mode: 'reading-history',
    previousScrollTop: 950,
    scrollTop: 990,
    distanceFromBottom: 10,
  }).mode, 'follow-live');
});

test('history prefetch starts on reading intent and repeats near the visible top', () => {
  assert.equal(shouldRequestEarlierTimeline({
    mode: 'reading-history',
    enteredReadingMode: true,
    scrollTop: 4_000,
    clientHeight: 800,
    hasEarlierTimeline: true,
    isLoading: false,
  }), true);
  assert.equal(shouldRequestEarlierTimeline({
    mode: 'reading-history',
    enteredReadingMode: false,
    scrollTop: 900,
    clientHeight: 800,
    hasEarlierTimeline: true,
    isLoading: false,
  }), true);
});

test('new live content does not move a reader, while prepended history preserves the visual anchor', () => {
  assert.equal(resolveScrollTopAfterTimelineChange({
    mode: 'reading-history',
    mutation: 'append-or-update',
    previousScrollTop: 700,
    previousScrollHeight: 2_000,
    nextScrollHeight: 2_400,
    clientHeight: 600,
  }), 700);
  assert.equal(resolveScrollTopAfterTimelineChange({
    mode: 'reading-history',
    mutation: 'prepend',
    previousScrollTop: 700,
    previousScrollHeight: 2_000,
    nextScrollHeight: 2_400,
    clientHeight: 600,
  }), 1_100);
});

test('prepend detection and merge retain fresh current entries during a live-update race', () => {
  assert.equal(classifyTranscriptMutation({
    previousConversationKey: 'session-1',
    nextConversationKey: 'session-1',
    previousFirstEntryId: 'entry-3',
    nextFirstEntryId: 'entry-1',
    previousFirstEntryStillRendered: true,
  }), 'prepend');

  const merged = mergeEarlierTimelineEntries(
    [{ id: 'entry-1', text: 'old 1' }, { id: 'entry-2', text: 'old 2' }, { id: 'entry-3', text: 'stale overlap' }],
    [{ id: 'entry-3', text: 'fresh overlap' }, { id: 'entry-4', text: 'live append' }],
  );
  assert.deepEqual(merged, [
    { id: 'entry-1', text: 'old 1' },
    { id: 'entry-2', text: 'old 2' },
    { id: 'entry-3', text: 'fresh overlap' },
    { id: 'entry-4', text: 'live append' },
  ]);
});
