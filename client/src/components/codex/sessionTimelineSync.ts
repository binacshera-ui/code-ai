export interface VersionedSessionSnapshot {
  id: string;
  updatedAt: string;
  totalTimelineEntries: number;
  timelineWindowEnd?: number;
}

function parseSnapshotTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * A session can be refreshed by both the live SSE stream and an HTTP fallback.
 * HTTP responses are allowed to finish out of order, so accepting them based on
 * request order alone can roll the visible timeline backwards. This predicate
 * is the final monotonicity gate shared by both update paths.
 *
 * A genuinely newer filesystem revision may contain fewer entries after a
 * compaction/rewrite, therefore timestamp freshness takes precedence over the
 * entry count. Entry/window counts are used as a safe fallback when timestamps
 * are equal or unavailable.
 */
export function shouldAcceptSessionSnapshot(
  current: VersionedSessionSnapshot | null | undefined,
  incoming: VersionedSessionSnapshot
): boolean {
  if (!current || current.id !== incoming.id) {
    return true;
  }

  const currentTimestamp = parseSnapshotTimestamp(current.updatedAt);
  const incomingTimestamp = parseSnapshotTimestamp(incoming.updatedAt);
  if (currentTimestamp !== null && incomingTimestamp !== null) {
    if (incomingTimestamp < currentTimestamp) {
      return false;
    }
    if (incomingTimestamp > currentTimestamp) {
      return true;
    }
  }

  if (incoming.totalTimelineEntries < current.totalTimelineEntries) {
    return false;
  }
  if (incoming.totalTimelineEntries > current.totalTimelineEntries) {
    return true;
  }

  const currentWindowEnd = current.timelineWindowEnd ?? current.totalTimelineEntries;
  const incomingWindowEnd = incoming.timelineWindowEnd ?? incoming.totalTimelineEntries;
  return incomingWindowEnd >= currentWindowEnd;
}
