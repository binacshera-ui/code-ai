import { Activity, Loader2, RefreshCw, ShieldCheck, Smartphone, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PhoneAccessPolicy = 'careful' | 'free';

export interface PhoneModeValue {
  enabled: boolean;
  accessPolicy: PhoneAccessPolicy;
  includeCallArchive: boolean;
  verboseLogs: boolean;
}

export interface PhoneModeStatusValue {
  connected: boolean;
  checkedAt: string | null;
  deviceName: string | null;
  batteryPercent: number | null;
  charging: boolean | null;
  error: string | null;
}

interface Props {
  isOpen: boolean;
  provider: string | null;
  value: PhoneModeValue;
  status: PhoneModeStatusValue | null;
  isLoading: boolean;
  isSaving: boolean;
  onClose: () => void;
  onChange: (next: PhoneModeValue) => void;
  onRefresh: () => void;
  onSave: () => void;
  onDisable: () => void;
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} dir="ltr" disabled={disabled} onClick={() => onChange(!checked)} className={cn('relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-teal-600' : 'bg-slate-200')}>
      <span className={cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

export function PhoneModeDialog({ isOpen, provider, value, status, isLoading, isSaving, onClose, onChange, onRefresh, onSave, onDisable }: Props) {
  if (!isOpen) return null;
  const providerSupported = provider === 'codex';
  return (
    <div className="fixed inset-0 z-[96] flex items-end justify-center bg-slate-950/30 p-3 backdrop-blur-sm sm:items-center" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב שליטה בטלפון" />
      <section className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_32px_100px_-34px_rgba(15,23,42,.45)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 text-teal-700"><Smartphone className="h-6 w-6" /></div>
            <div className="min-w-0"><div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Reapre Phone</div><h2 className="mt-1 text-xl font-semibold text-slate-900">שליטה בטלפון</h2><p className="mt-1 text-sm leading-6 text-slate-500">Codex בודק ושולט ב־Android המחובר, וניגש לארכיון השיחות והתמלולים דרך MCP פרטי לסשן.</p></div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 touch-pan-y [-webkit-overflow-scrolling:touch]">
          {!providerSupported && <div className="rounded-[1.4rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">מצב שליטה בטלפון זמין לסשני Codex בלבד.</div>}
          <div className="flex items-center justify-between gap-4 rounded-[1.4rem] border border-teal-100 bg-teal-50/60 p-4">
            <div><div className="text-sm font-semibold text-slate-900">הפעל לסשן הזה</div><div className="mt-1 text-xs leading-5 text-slate-500">ההרשאה קשורה לסשן וניתנת לביטול בכל רגע.</div></div>
            <Toggle checked={value.enabled} disabled={!providerSupported} onChange={(enabled) => onChange({ ...value, enabled })} />
          </div>

          <div className="mt-5 rounded-[1.4rem] border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">מצב חיבור</div><div className="mt-1 text-xs text-slate-500">בדיקה חיה ללא שינוי במכשיר.</div></div><button type="button" onClick={onRefresh} disabled={isLoading} className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} /></button></div>
            <div className="mt-3 flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-3"><span className={cn('h-2.5 w-2.5 rounded-full', status?.connected ? 'bg-emerald-400' : 'bg-slate-300')} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-800">{status?.connected ? status.deviceName || 'Android מחובר' : 'הטלפון אינו זמין כרגע'}</div><div className="mt-1 text-xs text-slate-500">{status?.connected ? `${status.batteryPercent ?? '—'}%${status.charging ? ' · בטעינה' : ''}` : status?.error || 'לחץ רענון לבדיקת החיבור'}</div></div><Activity className="h-4 w-4 text-teal-600" /></div>
          </div>

          <div className="mt-5 rounded-[1.4rem] border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">מדיניות פעולה</div><div className="mt-1 text-xs leading-5 text-slate-500">בחר אם Codex יעצור לפני פעולות שמשנות את הטלפון.</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => onChange({ ...value, accessPolicy: 'careful' })} className={cn('rounded-xl border px-4 py-4 text-right transition', value.accessPolicy === 'careful' ? 'border-teal-300 bg-teal-50 text-teal-950 ring-2 ring-teal-100' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}><span className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" />גישה זהירה</span><span className="mt-2 block text-xs leading-5">קריאה חופשית; שינוי דורש בקשה מפורשת ועלול להמתין לאישור בטלפון.</span></button>
              <button type="button" onClick={() => onChange({ ...value, accessPolicy: 'free' })} className={cn('rounded-xl border px-4 py-4 text-right transition', value.accessPolicy === 'free' ? 'border-amber-300 bg-amber-50 text-amber-950 ring-2 ring-amber-100' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}><span className="flex items-center gap-2 text-sm font-semibold"><Zap className="h-4 w-4" />גישה חופשית</span><span className="mt-2 block text-xs leading-5">פעולות שהתבקשו במפורש מתבצעות בלי אישור חוזר; יעד ותוצאה עדיין נבדקים.</span></button>
            </div>
            {value.accessPolicy === 'free' && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-950"><span className="font-semibold">גישה חופשית פעילה:</span> Codex יוכל ללחוץ, להקליד, לפתוח אפליקציות ולבצע פעולות טלפון שביקשת במפורש ללא עצירה נוספת.</div>}
          </div>

          <div className="mt-5 divide-y divide-slate-100 rounded-[1.4rem] border border-slate-200 bg-white px-4">
            <div className="flex items-center justify-between gap-4 py-4"><div><div className="text-sm font-semibold text-slate-900">ארכיון שיחות ותמלולים</div><div className="mt-1 text-xs leading-5 text-slate-500">מאפשר חיפוש, קריאה ותיוג דרך כלי phone_calls.</div></div><Toggle checked={value.includeCallArchive} onChange={(includeCallArchive) => onChange({ ...value, includeCallArchive })} /></div>
            <div className="flex items-center justify-between gap-4 py-4"><div><div className="text-sm font-semibold text-slate-900">לוגים מפורטים</div><div className="mt-1 text-xs leading-5 text-slate-500">שומר correlation ID, זמני תגובה ושגיאות בלי תוכן פרטי.</div></div><Toggle checked={value.verboseLogs} onChange={(verboseLogs) => onChange({ ...value, verboseLogs })} /></div>
          </div>
          <div className="mt-4 flex gap-2 rounded-[1.25rem] border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-xs leading-6 text-emerald-900"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>מפתח Reapre נשאר בשרת ואינו נשלח לדפדפן או ל־Codex. תוכן מהטלפון מסומן תמיד כקלט לא מהימן.</span></div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4"><button type="button" onClick={onDisable} disabled={isSaving || !value.enabled} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">כבה מצב</button><button type="button" onClick={onSave} disabled={isSaving || !providerSupported} className="flex items-center gap-2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">{isSaving && <Loader2 className="h-4 w-4 animate-spin" />}{isSaving ? 'שומר…' : value.accessPolicy === 'free' && value.enabled ? 'שמור והפעל גישה חופשית' : 'שמור מצב'}</button></footer>
      </section>
    </div>
  );
}
