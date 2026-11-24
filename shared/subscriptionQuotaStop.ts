/** Legacy keys: primary selects the short window, secondary the weekly/long
 * window. Provider slot order is not duration: a weekly-only plan uses primary. */
export type SubscriptionQuotaWindow = 'primary' | 'secondary' | 'any';

export function matchesSubscriptionQuotaWindow(selected: SubscriptionQuotaWindow, windowMinutes: number | null | undefined): boolean {
  if (selected === 'any') return true;
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return false;
  return selected === 'secondary' ? windowMinutes > 24 * 60 : windowMinutes <= 24 * 60;
}
export interface SubscriptionQuotaStopSettings {
  enabled: boolean;
  stopAtUsedPercent: number;
  window: SubscriptionQuotaWindow;
}
export interface SubscriptionQuotaStopSnapshot extends SubscriptionQuotaStopSettings {
  /** Opaque account binding used to reject a draft saved after an account switch. */
  accountScope?: string | null;
  supported: boolean;
  state: 'disabled' | 'armed' | 'blocked' | 'unavailable' | 'unsupported';
  usedPercent: number | null;
  remainingUntilStopPercent: number | null;
  resetsAt: number | null;
  observedAt: string | null;
  stoppedAt: string | null;
  message: string | null;
}
export const DEFAULT_SUBSCRIPTION_QUOTA_STOP: SubscriptionQuotaStopSettings = {
  enabled: false, stopAtUsedPercent: 90, window: 'secondary',
};
export function validateSubscriptionQuotaStopSettings(value: unknown): SubscriptionQuotaStopSettings {
  const v = value as Partial<SubscriptionQuotaStopSettings> | null;
  if (!v || typeof v.enabled !== 'boolean' || typeof v.stopAtUsedPercent !== 'number'
      || !Number.isFinite(v.stopAtUsedPercent) || v.stopAtUsedPercent < 0.1 || v.stopAtUsedPercent > 100
      || !['primary', 'secondary', 'any'].includes(v.window || '')) {
    throw new Error('יש לבחור סף ניצול בין 0.1% ל־100% וחלון מכסה תקין.');
  }
  return { enabled: v.enabled, stopAtUsedPercent: Math.round(v.stopAtUsedPercent * 100) / 100,
    window: v.window as SubscriptionQuotaWindow };
}
