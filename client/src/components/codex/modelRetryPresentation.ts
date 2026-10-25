import { normalizeCodexModelRetry, type CodexModelRetry } from '../../../../shared/codexModelRetry';

export interface ModelRetryItem {
  id: string;
  status: string;
  scheduledAt: string;
  createdAt: string;
  modelRetry?: CodexModelRetry | null;
  capacityRetry?: { attempt: number } | null;
  nativeSubmission?: { turnId: string | null; deliveryPhase: string } | null;
}

export interface ModelRetryNoticeState {
  itemId: string;
  retryAt: string;
  confirmingStop: boolean;
  attempt: number | null;
}

export function modelRetryNotice(item: ModelRetryItem): ModelRetryNoticeState | null {
  if (item.capacityRetry && ['scheduled', 'queued'].includes(item.status) && Number.isFinite(Date.parse(item.scheduledAt))) {
    return { itemId: item.id, retryAt: item.scheduledAt, confirmingStop: false, attempt: item.capacityRetry.attempt };
  }
  const retry = normalizeCodexModelRetry(item.modelRetry);
  if (item.status === 'running' && retry && retry.turnId === item.nativeSubmission?.turnId) {
    return { itemId: item.id, retryAt: retry.retryAt, confirmingStop: true, attempt: null };
  }
  return null;
}

export function latestModelRetryNotice(items: ModelRetryItem[]): ModelRetryNoticeState | null {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(modelRetryNotice).find(Boolean) || null;
}

export function modelRetryMessage(notice: ModelRetryNoticeState, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(notice.retryAt) - now) / 1000));
  if (notice.confirmingStop) return seconds > 0
    ? `ניסיון המודל נכשל — מאמת עצירה בטוחה; ניסיון חוזר בעוד ${seconds} שניות לאחר אימות העצירה.`
    : 'ניסיון המודל נכשל — ממתין לאימות עצירה בטוחה לפני ניסיון חוזר.';
  return seconds > 0 ? `ניסיון המודל נכשל — מנסה שוב בעוד ${seconds} שניות.` : 'ניסיון המודל נכשל — ממתין להפעלת הניסיון הבא.';
}
