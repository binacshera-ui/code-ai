import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAcceptSessionSnapshot } from './sessionTimelineSync.js';

test('rejects an HTTP detail that completes after a newer live snapshot', () => {
  const liveSnapshot = {
    id: 'session-1',
    updatedAt: '2026-08-10T13:06:03.300Z',
    totalTimelineEntries: 19_320,
    timelineWindowEnd: 19_320,
  };
  const delayedHttpDetail = {
    id: 'session-1',
    updatedAt: '2026-08-10T13:06:02.900Z',
    totalTimelineEntries: 19_317,
    timelineWindowEnd: 19_317,
  };

  assert.equal(shouldAcceptSessionSnapshot(liveSnapshot, delayedHttpDetail), false);
});

test('keeps timeline progress monotonic across the reproduced SSE/HTTP race', () => {
  const snapshots = [
    {
      id: 'session-1',
      updatedAt: '2026-08-10T13:06:03.300Z',
      totalTimelineEntries: 19_320,
      timelineWindowEnd: 19_320,
    },
    {
      id: 'session-1',
      updatedAt: '2026-08-10T13:06:02.900Z',
      totalTimelineEntries: 19_317,
      timelineWindowEnd: 19_317,
    },
    {
      id: 'session-1',
      updatedAt: '2026-08-10T13:06:03.700Z',
      totalTimelineEntries: 19_321,
      timelineWindowEnd: 19_321,
    },
    {
      id: 'session-1',
      updatedAt: '2026-08-10T13:06:02.700Z',
      totalTimelineEntries: 19_315,
      timelineWindowEnd: 19_315,
    },
  ];

  const acceptedTotals: number[] = [];
  let current = snapshots[0];
  acceptedTotals.push(current.totalTimelineEntries);
  for (const incoming of snapshots.slice(1)) {
    if (shouldAcceptSessionSnapshot(current, incoming)) {
      current = incoming;
      acceptedTotals.push(current.totalTimelineEntries);
    }
  }

  assert.deepEqual(acceptedTotals, [19_320, 19_321]);
});

test('accepts a newer compaction even when it contains fewer timeline entries', () => {
  const beforeCompaction = {
    id: 'session-1',
    updatedAt: '2026-08-10T13:06:03.300Z',
    totalTimelineEntries: 20_000,
    timelineWindowEnd: 20_000,
  };
  const afterCompaction = {
    id: 'session-1',
    updatedAt: '2026-08-10T13:07:00.000Z',
    totalTimelineEntries: 8_000,
    timelineWindowEnd: 8_000,
  };

  assert.equal(shouldAcceptSessionSnapshot(beforeCompaction, afterCompaction), true);
});

test('falls back to timeline positions when timestamps are equal or invalid', () => {
  const current = {
    id: 'session-1',
    updatedAt: 'not-a-date',
    totalTimelineEntries: 500,
    timelineWindowEnd: 500,
  };

  assert.equal(shouldAcceptSessionSnapshot(current, { ...current, totalTimelineEntries: 499, timelineWindowEnd: 499 }), false);
  assert.equal(shouldAcceptSessionSnapshot(current, { ...current, totalTimelineEntries: 501, timelineWindowEnd: 501 }), true);
});
