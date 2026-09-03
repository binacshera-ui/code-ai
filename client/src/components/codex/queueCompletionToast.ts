export type QueueLifecycleStatus =
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type QueueTerminalStatus = 'completed' | 'failed' | 'cancelled';

interface QueueLifecycleItem {
  id: string;
  status: QueueLifecycleStatus;
}

const ACTIVE_STATUSES = new Set<QueueLifecycleStatus>([
  'scheduled',
  'queued',
  'running',
  'cancelling',
]);

const TERMINAL_STATUSES = new Set<QueueLifecycleStatus>([
  'completed',
  'failed',
  'cancelled',
]);

export function observeQueueStatusTransitions<T extends QueueLifecycleItem>(
  previousStatuses: Readonly<Record<string, QueueLifecycleStatus>>,
  items: readonly T[],
): {
  nextStatuses: Record<string, QueueLifecycleStatus>;
  newTerminalItems: Array<T & { status: QueueTerminalStatus }>;
} {
  // Keep statuses for items that temporarily disappear when the user switches
  // conversations. Reintroducing old terminal history must not look like a new
  // completion event.
  const nextStatuses = { ...previousStatuses };
  const newTerminalItems: Array<T & { status: QueueTerminalStatus }> = [];

  for (const item of items) {
    const previousStatus = previousStatuses[item.id];
    nextStatuses[item.id] = item.status;

    if (
      previousStatus
      && ACTIVE_STATUSES.has(previousStatus)
      && TERMINAL_STATUSES.has(item.status)
    ) {
      newTerminalItems.push(item as T & { status: QueueTerminalStatus });
    }
  }

  return { nextStatuses, newTerminalItems };
}
