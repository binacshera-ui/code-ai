import {
  validateSubscriptionQuotaStopSettings,
  type SubscriptionQuotaStopSettings,
  type SubscriptionQuotaStopSnapshot,
  type SubscriptionQuotaWindow,
} from '../../../../shared/subscriptionQuotaStop';

export interface SubscriptionQuotaStopDraft {
  enabled: boolean;
  stopAtUsedPercent: string;
  window: SubscriptionQuotaWindow;
}
export type SubscriptionQuotaStopSave = SubscriptionQuotaStopSettings & { accountScope?: string | null };

export function subscriptionQuotaStopDraft(snapshot: SubscriptionQuotaStopSettings): SubscriptionQuotaStopDraft {
  return { enabled: snapshot.enabled, stopAtUsedPercent: String(snapshot.stopAtUsedPercent), window: snapshot.window };
}

export function subscriptionQuotaStopSettings(draft: SubscriptionQuotaStopDraft): SubscriptionQuotaStopSettings {
  // Number('') would silently choose zero; an incomplete number remains invalid.
  if (!draft.stopAtUsedPercent.trim()) throw new Error('יש להזין אחוז ניצול לעצירה.');
  return validateSubscriptionQuotaStopSettings({ ...draft, stopAtUsedPercent: Number(draft.stopAtUsedPercent) });
}

/** The binding is supplied by the draft owner, not the most recent poll. */
export function subscriptionQuotaStopSavePayload(draft: SubscriptionQuotaStopDraft, accountScope: string | null | undefined): SubscriptionQuotaStopSave {
  return { ...subscriptionQuotaStopSettings(draft), accountScope };
}

export function subscriptionQuotaStopStateLabel(snapshot: SubscriptionQuotaStopSnapshot | null): string {
  if (!snapshot) return 'טוען את סף העצירה…';
  return {
    disabled: 'סף העצירה כבוי',
    armed: 'ההגבלה פעילה · עוקבת אחר המכסה',
    blocked: 'סף העצירה הושג · השיחות חסומות',
    unavailable: 'אין כרגע מדידת מכסה עדכנית',
    unsupported: 'סף מנוי אינו זמין בחיבור הזה',
  }[snapshot.state];
}

export function formatQuotaStopPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'לא ידוע' : `${value.toLocaleString('he-IL', { maximumFractionDigits: 2 })}%`;
}

/** resetsAt uses the provider's epoch seconds. This is reset time, never an ETA
 * to reaching the selected threshold: token usage has no predictable rate. */
export function quotaResetCountdown(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.ceil((resetsAt * 1_000 - nowMs) / 1_000);
  if (seconds <= 0) return 'מועד האיפוס הגיע · ממתין לנתוני הספק';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainingSeconds = seconds % 60;
  const clock = [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':');
  return days ? `${days === 1 ? 'יום אחד' : `${days} ימים`} · ${clock}` : clock;
}
