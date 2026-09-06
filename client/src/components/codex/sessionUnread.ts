export interface SessionCompletion {
  completedAt: number;
  startedAt: number;
}

export interface SessionActivity {
  busy: boolean;
  latestStartedAt: number;
  latestInterruptedAt: number;
  latestUpdatedAt: number;
}

export function collectSessionActivity(items: readonly {
  profileId: string;
  sessionId: string | null;
  queueKey: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}[], profileId: string): Record<string, SessionActivity> {
  const activity: Record<string, SessionActivity> = Object.create(null);
  for (const item of items) {
    if (item.profileId !== profileId) continue;
    for (const id of new Set([item.sessionId, item.queueKey].filter((id): id is string => Boolean(id)))) {
      const current = activity[id] ||= { busy: false, latestStartedAt: 0, latestInterruptedAt: 0, latestUpdatedAt: 0 };
      current.busy ||= ['queued', 'running', 'cancelling'].includes(item.status);
      current.latestStartedAt = Math.max(current.latestStartedAt, Date.parse(item.startedAt || '') || 0);
      current.latestUpdatedAt = Math.max(current.latestUpdatedAt, Date.parse(item.updatedAt) || 0);
      if (['failed', 'cancelled'].includes(item.status)) {
        current.latestInterruptedAt = Math.max(current.latestInterruptedAt, Date.parse(item.completedAt || item.updatedAt) || 0);
      }
    }
  }
  return activity;
}

export function mergeSessionActivity(fetched: Record<string, SessionActivity>, live: Record<string, SessionActivity>): Record<string, SessionActivity> {
  const result = { ...fetched };
  for (const [id, next] of Object.entries(live)) {
    // Sidebar polling can be fresher than the paused transcript's queue state.
    if (!result[id] || next.latestUpdatedAt > result[id].latestUpdatedAt) result[id] = next;
  }
  return result;
}

export function hasUnreadCompletion(completion: SessionCompletion | undefined, viewedThrough = 0, activity?: SessionActivity): boolean {
  return Boolean(completion && completion.completedAt > viewedThrough && !activity?.busy
    && completion.completedAt >= (activity?.latestStartedAt || 0)
    && completion.completedAt > (activity?.latestInterruptedAt || 0));
}

export function canAcknowledgeCompletion(input: {
  visible: boolean;
  focused: boolean;
  blocked: boolean;
  atBottom: boolean;
  renderedFinalAt: number;
  completion: SessionCompletion;
}): boolean {
  return input.visible && input.focused && !input.blocked && input.atBottom
    && input.renderedFinalAt >= input.completion.startedAt;
}
