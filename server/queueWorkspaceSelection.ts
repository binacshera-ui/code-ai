import { nativeSubmissionNeedsReconciliation } from './codexSharedSubmission.mjs';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface QueueWorkspaceRecord {
  id: string;
  status: string;
  queueKey: string;
  sessionId: string | null;
  updatedAt: string;
  createdAt: string;
  nativeSubmission?: { deliveryPhase: string } | null;
  capacityRetryPendingAt?: string | null;
  stopPolicy?: { status: string } | null;
}

export interface QueueHistorySummary {
  totalTerminal: number;
  returnedTerminal: number;
  hasMoreTerminal: boolean;
  relatedTerminal: number;
  returnedRelatedTerminal: number;
  hasMoreRelatedTerminal: boolean;
}

export function isQueueWorkspaceRelated(
  item: QueueWorkspaceRecord,
  queueKey: string | null,
  resolvedSessionId: string | null,
): boolean {
  const keys = [queueKey, resolvedSessionId].filter(Boolean);
  return keys.includes(item.queueKey) || Boolean(item.sessionId && keys.includes(item.sessionId));
}

function updatedTime(item: QueueWorkspaceRecord): number {
  const updated = Date.parse(item.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(item.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function newestFirst(left: QueueWorkspaceRecord, right: QueueWorkspaceRecord): number {
  return updatedTime(right) - updatedTime(left) || right.id.localeCompare(left.id);
}

function boundedLimit(input: number | undefined, fallback: number, max = 200): number {
  return Number.isFinite(input) ? Math.max(0, Math.min(max, Math.trunc(input!))) : fallback;
}

/** Terminal history is bounded, never executing work or uncertain native custody. */
export function selectQueueWorkspaceView<T extends QueueWorkspaceRecord>(
  items: readonly T[],
  queueKey: string | null,
  resolvedSessionId: string | null,
  options: { recentTerminalLimit?: number; relatedTerminalLimit?: number } = {},
): { items: T[]; history: QueueHistorySummary } {
  const terminal = items.filter(item => TERMINAL_STATUSES.has(item.status)).sort(newestFirst);
  const relatedTerminal = terminal.filter(item => isQueueWorkspaceRelated(item, queueKey, resolvedSessionId));
  const selected = new Set<string>();
  for (const item of items) {
    if (!TERMINAL_STATUSES.has(item.status)
      || nativeSubmissionNeedsReconciliation(item.nativeSubmission)
      || item.capacityRetryPendingAt
      || item.stopPolicy?.status === 'awaiting-decision'
      || item.stopPolicy?.status === 'stopping') {
      selected.add(item.id);
    }
  }
  for (const item of terminal.slice(0, boundedLimit(options.recentTerminalLimit, 20))) selected.add(item.id);
  // Always retain the current conversation's latest attempt, even when the
  // caller intentionally requests no recent global history.
  const relatedLimit = Math.max(1, boundedLimit(options.relatedTerminalLimit, 50));
  for (const item of relatedTerminal.slice(0, relatedLimit)) selected.add(item.id);
  const returnedTerminal = terminal.filter(item => selected.has(item.id)).length;
  const returnedRelatedTerminal = relatedTerminal.filter(item => selected.has(item.id)).length;
  return {
    items: items.filter(item => selected.has(item.id)),
    history: {
      totalTerminal: terminal.length,
      returnedTerminal,
      hasMoreTerminal: returnedTerminal < terminal.length,
      relatedTerminal: relatedTerminal.length,
      returnedRelatedTerminal,
      hasMoreRelatedTerminal: returnedRelatedTerminal < relatedTerminal.length,
    },
  };
}

interface QueueHistoryCursor { version: 1; updatedTime: number; id: string }

function decodeCursor(cursor: string): QueueHistoryCursor {
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value?.version !== 1 || !Number.isFinite(value.updatedTime)
      || typeof value.id !== 'string' || !value.id || value.id.length > 240) throw new Error();
    return value;
  } catch {
    throw new Error('Invalid queue history cursor');
  }
}

/** Stable keyset pagination keeps archived failures available without polling them. */
export function selectQueueHistoryPage<T extends QueueWorkspaceRecord>(
  items: readonly T[],
  options: { queueKey?: string | null; resolvedSessionId?: string | null; limit?: number; cursor?: string | null } = {},
): { items: T[]; nextCursor: string | null; total: number } {
  const scoped = Boolean(options.queueKey || options.resolvedSessionId);
  const terminal = items.filter(item => TERMINAL_STATUSES.has(item.status)
    && (!scoped || isQueueWorkspaceRelated(item, options.queueKey || null, options.resolvedSessionId || null)))
    .sort(newestFirst);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const remaining = cursor ? terminal.filter(item => updatedTime(item) < cursor.updatedTime
    || (updatedTime(item) === cursor.updatedTime && item.id.localeCompare(cursor.id) < 0)) : terminal;
  const limit = Math.max(1, boundedLimit(options.limit, 50));
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    total: terminal.length,
    nextCursor: last && remaining.length > page.length
      ? Buffer.from(JSON.stringify({ version: 1, updatedTime: updatedTime(last), id: last.id })).toString('base64url')
      : null,
  };
}
