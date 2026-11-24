import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, RefreshCw, Timer, X } from 'lucide-react';
import { DEFAULT_SUBSCRIPTION_QUOTA_STOP, type SubscriptionQuotaStopSnapshot } from '../../../../shared/subscriptionQuotaStop';
import { formatQuotaStopPercent, quotaResetCountdown, subscriptionQuotaStopDraft, subscriptionQuotaStopSettings, subscriptionQuotaStopSavePayload, subscriptionQuotaStopStateLabel, type SubscriptionQuotaStopDraft, type SubscriptionQuotaStopSave } from './subscriptionQuotaStopClient';

export interface SubscriptionQuotaStopControlProps {
  serverId: string;
  profileId: string;
  themeClassName: string;
  themePresetId: string;
  load: (signal: AbortSignal) => Promise<SubscriptionQuotaStopSnapshot>;
  save: (settings: SubscriptionQuotaStopSave) => Promise<SubscriptionQuotaStopSnapshot>;
}

const STYLES = `
.code-ai-quota-stop{--qs-bg:var(--code-ai-panel-bg,#fff);--qs-soft:var(--code-ai-soft-bg,#fafafa);--qs-border:var(--code-ai-panel-border,#e5e5e5);--qs-text:var(--code-ai-canvas-text,#171717);--qs-muted:var(--code-ai-text-muted,#737373);--qs-warning:#a16207;color:var(--qs-text);background:var(--qs-bg)}
.code-ai-theme-dark .code-ai-quota-stop{--qs-bg:#171717;--qs-soft:#262626;--qs-border:#333;--qs-text:#ededed;--qs-muted:#a3a3a3;--qs-warning:#fde047}
.code-ai-quota-stop .qs-action{display:inline-flex;min-height:44px;min-width:44px;align-items:center;justify-content:center;gap:.5rem;border:1px solid var(--qs-border);border-radius:.875rem;padding:.5rem .875rem;font-size:.8125rem;background:var(--qs-bg);color:var(--qs-text)}
.code-ai-quota-stop .qs-action:hover:not(:disabled){background:var(--qs-soft)}
.code-ai-quota-stop button:focus-visible,.code-ai-quota-stop input:focus-visible,.code-ai-quota-stop select:focus-visible{outline:2px solid var(--qs-muted);outline-offset:3px}
.code-ai-quota-stop button:disabled,.code-ai-quota-stop input:disabled,.code-ai-quota-stop select:disabled{opacity:.5;cursor:not-allowed}
.code-ai-quota-stop .qs-muted{color:var(--qs-muted)}
.code-ai-quota-stop .qs-field{width:100%;min-height:44px;border:1px solid var(--qs-border);border-radius:.875rem;padding:.625rem .75rem;color:var(--qs-text);background:var(--qs-bg);font-size:.875rem}
`;

export interface SubscriptionQuotaStopViewProps {
  snapshot: SubscriptionQuotaStopSnapshot | null;
  draft: SubscriptionQuotaStopDraft;
  nowMs: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refreshRequired?: boolean;
  onChange: (draft: SubscriptionQuotaStopDraft) => void;
  onSave: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function SubscriptionQuotaStopView({ snapshot, draft, nowMs, loading, saving, error, refreshRequired = false, onChange, onSave, onRefresh, onClose }: SubscriptionQuotaStopViewProps) {
  const id = useId();
  const supported = snapshot?.supported === true;
  const pending = !snapshot || saving;
  const countdown = quotaResetCountdown(snapshot?.resetsAt ?? null, nowMs);
  let validation: string | null = null;
  try { subscriptionQuotaStopSettings(draft); } catch (error) { validation = (error as Error).message; }
  return <>
    <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2" style={{ borderColor: 'var(--qs-border)', background: 'var(--qs-soft)' }}>
        <p role="status" className="text-xs leading-6">{subscriptionQuotaStopStateLabel(snapshot)}</p>
        <button type="button" className="qs-action !px-2" aria-label="רענן מדידת מכסה" disabled={loading || saving} onClick={onRefresh}>{loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}</button>
      </div>
      {snapshot && !supported ? <p className="qs-muted text-sm leading-7">ההגבלה מיועדת למכסת מנוי Codex שמדווחת על ידי הספק. היא אינה חלה על שימוש במפתח API או במסלול תשלום אחר.</p> : <>
        <div className="flex items-center justify-between gap-4">
          <div><label htmlFor={`${id}-enabled`} className="text-sm font-medium">הפעל סף עצירה למנוי</label><p className="qs-muted mt-1 text-xs leading-5">משותף לכל השיחות והפרופילים של אותו חשבון.</p></div>
          <button id={`${id}-enabled`} type="button" role="switch" aria-label="הפעל סף עצירה למנוי" aria-checked={draft.enabled} disabled={pending || !supported} onClick={() => onChange({ ...draft, enabled: !draft.enabled })} className="qs-action shrink-0" dir="ltr">{draft.enabled ? 'פעיל' : 'כבוי'}</button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label htmlFor={`${id}-percent`} className="block text-xs leading-6">עצור באחוז ניצול<input id={`${id}-percent`} type="number" inputMode="decimal" min="0.1" max="100" step="0.01" value={draft.stopAtUsedPercent} disabled={pending || !supported} onChange={event => onChange({ ...draft, stopAtUsedPercent: event.target.value })} className="qs-field mt-1 tabular-nums" dir="ltr" aria-describedby={`${id}-percent-note`} /></label>
          <label htmlFor={`${id}-window`} className="block text-xs leading-6">חלון המכסה<select id={`${id}-window`} value={draft.window} disabled={pending || !supported} onChange={event => onChange({ ...draft, window: event.target.value as SubscriptionQuotaStopDraft['window'] })} className="qs-field mt-1"><option value="secondary">מכסה שבועית / חלון שני</option><option value="primary">מכסה קצרת טווח / חלון ראשון</option><option value="any">הראשונה שמגיעה לסף</option></select></label>
        </div>
        <p id={`${id}-percent-note`} className="qs-muted !mt-2 text-[11px] leading-5">זהו אחוז שנוצל, לא אחוז שנותר. לדוגמה, עצירה ב־90% שומרת כ־10% מהמכסה.</p>
        {snapshot && <div className="grid grid-cols-2 gap-3 rounded-xl border p-3" style={{ borderColor: 'var(--qs-border)' }}>
          <div><p className="qs-muted text-[11px]">ניצול שנמדד</p><p className="mt-1 text-lg font-semibold tabular-nums" dir="auto">{formatQuotaStopPercent(snapshot.usedPercent)}</p></div>
          <div><p className="qs-muted text-[11px]">נותר עד סף העצירה השמור</p><p className="mt-1 text-lg font-semibold tabular-nums" dir="auto">{formatQuotaStopPercent(snapshot.remainingUntilStopPercent)}</p></div>
          {countdown && <div className="col-span-2 border-t pt-2" style={{ borderColor: 'var(--qs-border)' }}><p className="qs-muted text-[11px]">איפוס המכסה לפי הספק</p><p className="mt-1 text-sm tabular-nums" dir="auto" aria-live="off">{countdown}</p></div>}
        </div>}
        <p className="qs-muted text-xs leading-6">בהגעה לסף נעצרות כל השיחות המשתמשות במנוי הזה, ונחסמים גם המשכים, תורים והפעלות מתוזמנות. שימוש במפתח API נשאר נפרד.</p>
        <p className="qs-muted text-[11px] leading-5">העצירה מבוססת על נתוני הספק, שאינם מדידה בזמן אמת ברמת הטוקן. דיווח מאוחר ובקשות שכבר נשלחו עלולים ליצור חריגה קטנה מהסף.</p>
      </>}
      {snapshot?.message && <p role="status" className="text-xs leading-6" style={{ color: 'var(--qs-warning)' }}>{snapshot.message}</p>}
      {validation && supported && <p className="qs-muted text-xs leading-5">{validation}</p>}
      {error && <p role="alert" className="rounded-xl border px-3 py-2 text-xs leading-6" style={{ color: 'var(--qs-warning)', borderColor: 'var(--qs-border)' }}>{error}</p>}
      {refreshRequired && <p className="qs-muted text-xs leading-6">יש לרענן את המדידה ולאמת את החשבון וההגדרה לפני שמירה נוספת. הרענון יטען טיוטה חדשה; אין ניסיון חוזר אוטומטי.</p>}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--qs-border)', paddingBottom: 'max(.75rem,env(safe-area-inset-bottom))' }}>
      <p className="qs-muted text-[11px]">שינויים נכנסים לתוקף רק אחרי שמירה.</p>
      <div className="flex gap-2"><button type="button" className="qs-action" onClick={onClose} disabled={saving}>ביטול</button><button type="button" className="qs-action font-medium" onClick={onSave} disabled={pending || !supported || Boolean(validation) || refreshRequired}>{saving ? 'שומר…' : 'שמור סף עצירה'}</button></div>
    </footer>
  </>;
}

export function SubscriptionQuotaStopControl(props: SubscriptionQuotaStopControlProps) {
  const [snapshot, setSnapshot] = useState<SubscriptionQuotaStopSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => subscriptionQuotaStopDraft(DEFAULT_SUBSCRIPTION_QUOTA_STOP));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);
  const api = useRef({ load: props.load, save: props.save });
  api.current = { load: props.load, save: props.save };
  const alive = useRef(false);
  const generation = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const draftAccountScope = useRef<string | null | undefined>(undefined);
  const requireFreshDraft = useRef(false);
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  async function refresh(resetDraft = false) {
    if (reading.current || writing.current) return;
    const controller = new AbortController();
    reading.current = controller;
    const expected = generation.current;
    setLoading(true);
    try {
      const next = await api.current.load(controller.signal);
      if (!alive.current || expected !== generation.current || controller.signal.aborted) return;
      setSnapshot(next);
      // After a failed write, only the user's explicit refresh can clear the
      // warning/rebind a draft. Background polls cannot silently authorize it.
      if (!requireFreshDraft.current || resetDraft) setError(null);
      // Only seed a draft on the first read. Polling cannot overwrite edits.
      if (!currentSnapshot.current || resetDraft) {
        setDraft(subscriptionQuotaStopDraft(next));
        draftAccountScope.current = next.accountScope;
        if (resetDraft) { requireFreshDraft.current = false; setRefreshRequired(false); }
      }
    } catch (error) {
      if (alive.current && expected === generation.current && !controller.signal.aborted) setError(error instanceof Error ? error.message : 'לא ניתן לטעון את סף העצירה.');
    } finally {
      if (reading.current === controller) reading.current = null;
      if (alive.current && expected === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const refreshVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    const timer = setInterval(refreshVisible, 15_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { alive.current = false; generation.current++; reading.current?.abort(); reading.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [props.serverId, props.profileId]);
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open]);
  async function save() {
    if (writing.current || requireFreshDraft.current) return;
    let settings: SubscriptionQuotaStopSave;
    try { settings = subscriptionQuotaStopSavePayload(draft, draftAccountScope.current); }
    catch (error) { setError((error as Error).message); return; }
    const expected = ++generation.current;
    reading.current?.abort(); reading.current = null;
    writing.current = true; setSaving(true); setError(null); setLoading(false);
    try {
      const next = await api.current.save(settings);
      if (!alive.current || expected !== generation.current) return;
      setSnapshot(next); setDraft(subscriptionQuotaStopDraft(next)); draftAccountScope.current = next.accountScope; setOpen(false);
    } catch (error) {
      if (alive.current && expected === generation.current) {
        setError(error instanceof Error ? error.message : 'השמירה נכשלה. יש לרענן ולאמת את ההגדרה לפני ניסיון נוסף.');
        requireFreshDraft.current = true; setRefreshRequired(true);
      }
    } finally { writing.current = false; if (alive.current && expected === generation.current) setSaving(false); }
  }
  const title = snapshot?.enabled ? `סף עצירה למנוי · ${snapshot.stopAtUsedPercent}% ניצול` : 'סף עצירה למנוי';
  return <Dialog.Root open={open} onOpenChange={next => {
    if (saving) return;
    if (next) {
      setDraft(subscriptionQuotaStopDraft(snapshot || DEFAULT_SUBSCRIPTION_QUOTA_STOP));
      draftAccountScope.current = snapshot?.accountScope;
      // Reopening after a failed write still needs an explicit fresh read.
      void refresh(requireFreshDraft.current);
    }
    setOpen(next);
  }}>
    <Dialog.Trigger asChild><button type="button" title={title} aria-label={title} data-testid="subscription-quota-stop-launcher" data-quota-stop-state={snapshot?.state || 'loading'} className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400" style={snapshot?.enabled ? { color: snapshot.state === 'blocked' ? '#b45309' : 'var(--code-ai-canvas-text,#525252)' } : undefined}><Timer aria-hidden="true" className="h-[1.05rem] w-[1.05rem]" />{snapshot?.enabled && <span aria-hidden="true" className="absolute left-2 top-2 h-1.5 w-1.5 rounded-full bg-current" />}</button></Dialog.Trigger>
    <Dialog.Portal><div className={`code-ai-theme ${props.themeClassName}`} data-theme-preset={props.themePresetId} dir="rtl"><style>{STYLES}</style><Dialog.Overlay className="fixed inset-0 z-[140] bg-black/35 backdrop-blur-sm" /><Dialog.Content dir="rtl" data-server-id={props.serverId} data-profile-id={props.profileId} className="code-ai-quota-stop fixed left-1/2 top-1/2 z-[141] flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border shadow-xl outline-none" style={{ borderColor: 'var(--qs-border)' }}>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--qs-border)' }}><div><Dialog.Title className="flex items-center gap-2 text-base font-semibold"><Timer aria-hidden="true" className="h-5 w-5" />סף עצירה למנוי</Dialog.Title><Dialog.Description className="qs-muted mt-1 text-xs leading-5">שומרים מכסה לכל השיחות, לא רק לשיחה הפתוחה.</Dialog.Description></div><Dialog.Close asChild><button type="button" className="qs-action !px-2" disabled={saving} aria-label="סגור סף עצירה למנוי"><X aria-hidden="true" className="h-4 w-4" /></button></Dialog.Close></header>
      <SubscriptionQuotaStopView snapshot={snapshot} draft={draft} nowMs={nowMs} loading={loading} saving={saving} error={error} refreshRequired={refreshRequired} onChange={setDraft} onSave={() => void save()} onRefresh={() => void refresh(requireFreshDraft.current)} onClose={() => setOpen(false)} />
    </Dialog.Content></div></Dialog.Portal>
  </Dialog.Root>;
}
