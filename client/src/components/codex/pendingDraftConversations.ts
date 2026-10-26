export interface PendingDraftQueueItem {
  id: string;
  queueKey: string;
  sessionId: string | null;
  cwd: string | null;
  prompt: string;
  promptPreview: string;
  status: 'draft' | 'scheduled' | 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
}

function timestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * A provider session does not exist during the first moments of a new run, so
 * the queue item is the durable conversation placeholder. Keep only the newest
 * attempt for each draft key and remove it once the real session is catalogued.
 */
export function selectPendingDraftConversations<T extends PendingDraftQueueItem>(
  items: readonly T[],
  knownSessionIds: ReadonlySet<string>,
  search = ''
): T[] {
  const latestByDraftKey = new Map<string, T>();
  const newestFirst = [...items].sort((left, right) => (
    timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || timestamp(right.createdAt) - timestamp(left.createdAt)
  ));

  for (const item of newestFirst) {
    if (!item.queueKey.startsWith('draft-') || latestByDraftKey.has(item.queueKey)) {
      continue;
    }
    latestByDraftKey.set(item.queueKey, item);
  }

  const normalizedSearch = search.trim().toLowerCase();
  return [...latestByDraftKey.values()].filter((item) => {
    // A bound terminal attempt is not a conversation awaiting creation, even
    // when its real session is outside a partial/stale catalog response.
    if (item.sessionId && (knownSessionIds.has(item.sessionId)
      || ['completed', 'failed', 'cancelled'].includes(item.status))) {
      return false;
    }
    if (!normalizedSearch) {
      return true;
    }

    return [
      item.promptPreview,
      item.prompt,
      item.queueKey,
      item.sessionId || '',
      item.cwd || '',
      item.status,
    ].join('\n').toLowerCase().includes(normalizedSearch);
  });
}
