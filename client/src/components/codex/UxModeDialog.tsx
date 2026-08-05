import { Brain, Scale, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CodexSessionUxModeValue {
  enabled: boolean;
  geminiProfileId: string;
  depth: 'focused' | 'deep';
  productBrief: string;
  targetAudience: string;
  primaryOutcome: string;
}

export interface UxModeProfileOption {
  id: string;
  label: string;
}

export function UxModeDialog({
  isOpen,
  provider,
  value,
  profiles,
  isSaving,
  onClose,
  onChange,
  onSave,
  onDisable,
}: {
  isOpen: boolean;
  provider: 'codex' | 'claude' | 'gemini' | null;
  value: CodexSessionUxModeValue;
  profiles: UxModeProfileOption[];
  isSaving: boolean;
  onClose: () => void;
  onChange: (value: CodexSessionUxModeValue) => void;
  onSave: () => Promise<void> | void;
  onDisable: () => Promise<void> | void;
}) {
  if (!isOpen) return null;
  const codexOnly = provider === 'codex';

  return (
    <div className="fixed inset-0 z-[79] flex items-end justify-center bg-slate-950/25 p-3 backdrop-blur-sm sm:items-center sm:p-5" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב חוויית משתמש" />
      <div className="relative z-10 flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-cyan-100 bg-white shadow-[0_35px_120px_-45px_rgba(8,145,178,0.45)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cyan-50 text-cyan-700"><Brain className="h-5 w-5" /></div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-500">UX Debate Mode</div>
              <div className="mt-0.5 text-lg font-semibold text-slate-900">מצב חוויית משתמש · Codex × Gemini</div>
              <p className="mt-1 text-xs leading-5 text-slate-500">קודקס בונה עמדה פרטית, ג׳מיני מקבל שאלה ניטרלית, ואז מתקיימים עד 10 חילופי טיעון־נגד לפני זיקוק מוצרי.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {!codexOnly && <div className="mb-4 rounded-[1.2rem] border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">מצב חוויית משתמש זמין רק בפרופיל Codex. לא ייטענו סקיל או כלי MCP בפרופיל אחר.</div>}

          <section className="rounded-[1.5rem] border border-cyan-100 bg-cyan-50/45 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">הפעל לסשן</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">הסקיל וכלי ה־MCP נטענים רק כשהמתג פעיל.</div>
              </div>
              <button type="button" role="switch" aria-checked={value.enabled} disabled={!codexOnly} onClick={() => codexOnly && onChange({ ...value, enabled: !value.enabled })} dir="ltr" className={cn('relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition', value.enabled ? 'bg-cyan-500' : 'bg-slate-200', !codexOnly && 'opacity-50')}>
                <span className={cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', value.enabled ? 'translate-x-5' : 'translate-x-0')} />
              </button>
            </div>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm">
            <label className="text-xs font-semibold text-slate-700">פרופיל Gemini לייעוץ</label>
            <select value={value.geminiProfileId} disabled={!codexOnly || profiles.length === 0} onChange={(event) => onChange({ ...value, geminiProfileId: event.currentTarget.value })} className="mt-2 w-full rounded-[1rem] border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100 disabled:opacity-50">
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
            <div className="mt-4 text-xs font-semibold text-slate-700">עומק הדיון</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {([
                { id: 'deep' as const, label: 'עמוק', description: 'עד 10 חילופי טיעון ומסע לקוח מלא' },
                { id: 'focused' as const, label: 'ממוקד', description: 'ניתוח זריז ומדויק' },
              ]).map((option) => <button key={option.id} type="button" disabled={!codexOnly} onClick={() => onChange({ ...value, depth: option.id })} className={cn('rounded-[1rem] border px-3 py-3 text-right transition', value.depth === option.id ? 'border-cyan-200 bg-cyan-50 text-cyan-800' : 'border-slate-100 bg-slate-50 text-slate-600')}><div className="text-xs font-semibold">{option.label}</div><div className="mt-1 text-[10px] opacity-70">{option.description}</div></button>)}
            </div>
          </section>

          <section className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm"><label htmlFor="ux-mode-product-brief" className="text-xs font-semibold text-slate-700">בריף מוצר קבוע</label><textarea id="ux-mode-product-brief" value={value.productBrief} onChange={(event) => onChange({ ...value, productBrief: event.currentTarget.value })} maxLength={20000} rows={5} placeholder="מה המוצר, מה נשמר ומה אסור לשבור..." className="mt-2 min-h-[8rem] w-full resize-y rounded-[1rem] border border-slate-200 px-3 py-3 text-sm leading-6 text-slate-700 outline-none placeholder:text-slate-300 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100" /></div>
            <div className="space-y-4">
              <div className="rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm"><label htmlFor="ux-mode-target-audience" className="text-xs font-semibold text-slate-700">קהל יעד</label><textarea id="ux-mode-target-audience" value={value.targetAudience} onChange={(event) => onChange({ ...value, targetAudience: event.currentTarget.value })} maxLength={20000} rows={3} placeholder="מי הלקוח, מה ההקשר והרגישויות..." className="mt-2 w-full resize-y rounded-[1rem] border border-slate-200 px-3 py-3 text-sm leading-6 text-slate-700 outline-none placeholder:text-slate-300 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100" /></div>
              <div className="rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm"><label htmlFor="ux-mode-primary-outcome" className="text-xs font-semibold text-slate-700">תוצאה עיקרית מבוקשת</label><textarea id="ux-mode-primary-outcome" value={value.primaryOutcome} onChange={(event) => onChange({ ...value, primaryOutcome: event.currentTarget.value })} maxLength={20000} rows={3} placeholder="למשל: onboarding ברור שמגיע לערך ראשון..." className="mt-2 w-full resize-y rounded-[1rem] border border-slate-200 px-3 py-3 text-sm leading-6 text-slate-700 outline-none placeholder:text-slate-300 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100" /></div>
            </div>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-cyan-100 bg-cyan-50/70 p-4 text-xs leading-6 text-cyan-950">
            <div className="flex items-center gap-2 font-semibold"><Scale className="h-4 w-4" />תהליך ביקורתי, לא תשובה מוטה</div>
            <p className="mt-1 text-cyan-800">העמדה הראשונית של קודקס נשמרת מקומית ולא מגיעה לג׳מיני בסבב הראשון. רק אחר כך מועבר טיעון־נגד מפורש. אין מניפולציות או dark patterns; כל זיקוק מחייב סיכוני אמון, נגישות, מדדים וניסוי אימות.</p>
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4 sm:px-6">
          <button type="button" onClick={() => void onDisable()} disabled={isSaving || !value.enabled} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">כבה מצב</button>
          <div className="flex items-center gap-2"><button type="button" onClick={onClose} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50">בטל</button><button type="button" onClick={() => void onSave()} disabled={isSaving || !codexOnly || (value.enabled && !value.geminiProfileId)} className="rounded-full bg-slate-950 px-5 py-2 text-sm font-medium text-white transition hover:bg-cyan-900 disabled:opacity-40">{isSaving ? 'שומר...' : 'שמור מצב UX'}</button></div>
        </footer>
      </div>
    </div>
  );
}
