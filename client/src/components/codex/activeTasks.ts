export interface ActiveTaskItem {
  id: string;
  profileId: string;
  sessionId: string | null;
  queueKey: string;
  status: string;
  startedAt: string | null;
  promptPreview: string;
}

/** Scheduled/queued work is not executing yet; cancelled work must disappear. */
export function selectRunningTasks<T extends ActiveTaskItem>(items: readonly T[], profileId: string): T[] {
  return items.filter(item => item.profileId === profileId && ['running', 'cancelling'].includes(item.status))
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.id.localeCompare(b.id));
}

export function activeTaskLabel(item: ActiveTaskItem, titles: ReadonlyMap<string, string>): string {
  const title = titles.get(item.sessionId || item.queueKey)?.trim();
  return (title || item.promptPreview || 'שיחה חדשה').replace(/\s+/g, ' ').trim().slice(0, 180) || 'שיחה חדשה';
}
