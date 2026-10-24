import { isCodexModelCapacityMessage } from './codexCapacity.mjs';
export type CodexFailureKind = 'model_capacity' | 'model_unavailable' | 'usage_limit' | 'rate_limit' | 'context_limit' | 'provider_failure';

export function failureKindLabel(kind?: CodexFailureKind | null): string {
  switch (kind) {
    case 'model_capacity': return 'המודל עמוס כרגע ולא ניתן להשלים את ההרצה איתו; אפשר לבחור מודל אחר ולהמשיך.';
    case 'model_unavailable': return 'המודל אינו זמין; אפשר לבחור מודל אחר ולהמשיך.';
    case 'usage_limit': return 'מכסת השימוש במודל הושגה; אפשר לבחור מודל אחר או להמתין לחידוש המכסה.';
    case 'rate_limit': return 'הספק הגביל זמנית את קצב הבקשות.';
    case 'context_limit': return 'מגבלת ההקשר הושגה.';
    default: return 'ההרצה נעצרה לפני השלמה. פירוט השגיאה מופיע בהודעה שבתור.';
  }
}

// Compatibility with recorded authoritative queue errors, never assistant prose.
export function queueFailureKind(item: { status: string; failureKind?: CodexFailureKind | null; error?: string | null }): CodexFailureKind | null {
  if (item.status !== 'failed') return null;
  if (item.failureKind) return item.failureKind;
  if (isCodexModelCapacityMessage(item.error)) return 'model_capacity';
  const code = item.error?.match(/^Codex turn failed \((usageLimitExceeded|modelNotFound|modelNotAvailable|contextWindowExceeded|httpConnectionFailed)\)$/)?.[1];
  if (code === 'usageLimitExceeded') return 'usage_limit';
  if (code === 'modelNotFound' || code === 'modelNotAvailable') return 'model_unavailable';
  if (code === 'contextWindowExceeded') return 'context_limit';
  return null;
}

export interface NativeTimelineOutcomeEntry {
  id: string; entryType: string; timestamp: string;
  status?: string | null; role?: string; kind?: string; subtitle?: string | null;
}

/** Only server-projected status entries, not assistant/error-looking prose. */
export function latestNativeTimelineFailure(timeline: readonly NativeTimelineOutcomeEntry[]) {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry.entryType === 'status' && entry.status === 'failed') return {
      entryId: entry.id, timestamp: entry.timestamp, reason: entry.subtitle || null,
      failureKind: isCodexModelCapacityMessage(entry.subtitle) ? 'model_capacity' as const : null,
    };
    // A later turn/result supersedes an old failure, including a new prompt
    // whose answer has not yet arrived. A quoted error in a final is success.
    if (entry.entryType === 'message' && (entry.role === 'user' || (entry.role === 'assistant' && entry.kind === 'final')))
      return null;
    if (entry.entryType === 'status' && ['completed', 'running', 'inProgress', 'aborted', 'cancelled'].includes(entry.status || ''))
      return null;
  }
  return null;
}
