import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Server, X } from 'lucide-react';
import type { ServerStatusSnapshot, StorageMedium } from '../../../../shared/serverStatus';
import {
  appendServerStatusHistory, formatServerBytes, formatServerPercent, formatServerRate, formatServerUptime,
  groupServerVolumes, primaryServerNetwork, serverTrendGeometry, serverStatusWarningLabel, startServerStatusPolling,
} from './serverStatusPresentation';

export interface ServerStatusDialogProps {
  serverId: string;
  serverLabel: string;
  loadStatus: (signal: AbortSignal) => Promise<ServerStatusSnapshot>;
  onClose: () => void;
}

const MEDIUM_LABELS: Record<StorageMedium, string> = { nvme: 'NVMe', hdd: 'HDD', ssd: 'SSD', other: 'אחר / לא מזוהה' };
const STATUS_STYLES = `
.code-ai-server-status{--ss-bg:var(--code-ai-panel-bg,#fff);--ss-soft:var(--code-ai-soft-bg,#fafafa);--ss-border:var(--code-ai-panel-border,#e5e5e5);--ss-text:var(--code-ai-canvas-text,#171717);--ss-muted:var(--code-ai-text-muted,#737373);--ss-green:#15803d;--ss-amber:#a16207;--ss-red:#b91c1c;--ss-rx:#0891b2;--ss-tx:#7c3aed;color:var(--ss-text)}
.code-ai-theme-dark .code-ai-server-status{--ss-bg:#171717;--ss-soft:#262626;--ss-border:#333;--ss-text:#ededed;--ss-muted:#a3a3a3;--ss-green:#86efac;--ss-amber:#fde047;--ss-red:#fca5a5;--ss-rx:#67e8f9;--ss-tx:#c4b5fd}
.code-ai-server-status button:focus-visible,.code-ai-server-status summary:focus-visible{outline:2px solid var(--ss-muted);outline-offset:3px}
.code-ai-server-status button:hover:not(:disabled),.code-ai-server-status summary:hover{background:var(--ss-soft)}
.code-ai-server-status .ss-card{border:1px solid var(--ss-border);background:var(--ss-bg);border-radius:1rem;min-width:0;padding:1rem}
.code-ai-server-status .ss-muted{color:var(--ss-muted)}
.code-ai-server-status .ss-number{font-variant-numeric:tabular-nums;unicode-bidi:isolate}
.code-ai-server-status .ss-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem}
.code-ai-server-status .ss-label{font-size:.6875rem;color:var(--ss-muted)}
`;

function Meter({ value, label }: { value: number | null | undefined; label: string }) {
  const known = value != null && Number.isFinite(value);
  const percent = known ? Math.max(0, Math.min(100, value)) : 0;
  const color = percent >= 90 ? 'var(--ss-red)' : percent >= 75 ? 'var(--ss-amber)' : 'var(--ss-green)';
  return <div role={known ? 'meter' : undefined} aria-label={label} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={known ? percent : undefined} className="mt-3 h-2 overflow-hidden rounded-full" style={{ background: 'var(--ss-soft)' }}>
    {known && <div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} />}
  </div>;
}

function Trend({ history, select, label, color = 'var(--ss-green)', maximum }: { history: ServerStatusSnapshot[]; select: (sample: ServerStatusSnapshot) => number | null; label: string; color?: string; maximum?: number }) {
  const geometry = serverTrendGeometry(history.map(sample => ({ at: Date.parse(sample.sampledAt), value: select(sample) })), maximum);
  return <div className="mt-3">
    <svg role="img" aria-label={`${label} · ${geometry.count} דגימות אמיתיות`} viewBox="0 0 320 60" className="block h-[60px] w-full" preserveAspectRatio="none">
      <path d="M2,56 H318" stroke="var(--ss-border)" fill="none" />
      {geometry.paths.map((path, index) => <path key={index} d={path} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />)}
      {geometry.dots.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2.5" fill={color} />)}
    </svg>
    <span className="ss-label">{geometry.count ? `${geometry.count} דגימות שנקראו בחלון הזה` : 'ממתין לדגימות קצב'}</span>
  </div>;
}

function Metric({ label, children, prominent = false }: { label: string; children: ReactNode; prominent?: boolean }) {
  return <div className="min-w-0"><div className="ss-label">{label}</div><div className={`ss-number mt-1 break-words ${prominent ? 'text-xl font-semibold sm:text-2xl' : 'text-sm font-medium'}`} dir="auto">{children}</div></div>;
}

function CardTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">{icon}{children}</h3>;
}

export function ServerStatusView({ snapshot, history = [] }: { snapshot: ServerStatusSnapshot; history?: ServerStatusSnapshot[] }) {
  const { cpu, memory, storage, network } = snapshot;
  return <div className="space-y-4" data-testid="server-status-metrics">
    <div className="ss-row ss-muted text-xs leading-5"><span><bdi dir="ltr">{snapshot.hostname}</bdi> · {snapshot.platform}</span><span>זמן פעילות: {formatServerUptime(snapshot.uptimeSeconds)}</span></div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className="ss-card" aria-label="מעבד">
        <CardTitle icon={<Cpu className="h-4 w-4" aria-hidden="true" />}>מעבד · CPU</CardTitle>
        {cpu ? <>
          <div className="grid grid-cols-2 gap-4"><Metric label="ניצול כעת" prominent>{formatServerPercent(cpu.usedPercent)}</Metric><Metric label="פנוי כעת" prominent>{formatServerPercent(cpu.freePercent)}</Metric></div>
          <Meter value={cpu.usedPercent} label="ניצול מעבד" />
          <Trend history={history} select={sample => sample.cpu?.usedPercent ?? null} label="היסטוריית ניצול מעבד" maximum={100} />
          <p className="ss-muted mt-3 break-words text-xs leading-5" dir="auto">{cpu.model} · {cpu.logicalCores} ליבות לוגיות</p>
          <div className="ss-row mt-2 text-xs"><span className="ss-muted">עומס ממוצע 1 / 5 / 15 דקות (לא %)</span><bdi dir="ltr" className="ss-number">{cpu.loadAverage.map(value => value.toFixed(2)).join(' / ')}</bdi></div>
          <details className="mt-2"><summary className="flex min-h-11 cursor-pointer items-center rounded-lg text-xs font-medium">הצג ניצול לפי ליבה ({cpu.cores.length})</summary>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">{cpu.cores.map((used, index) => <div key={index} className="rounded-lg p-2" style={{ background: 'var(--ss-soft)' }}><div className="ss-row text-[10px]"><span className="ss-muted">ליבה {index + 1}</span><bdi dir="ltr" className="ss-number">{used == null ? '—' : formatServerPercent(used)}</bdi></div><Meter value={used} label={`ניצול ליבה ${index + 1}`} /></div>)}</div>
          </details>
        </> : <p className="ss-muted text-sm">נתוני המעבד אינם זמינים בשרת הזה.</p>}
      </section>
      <section className="ss-card" aria-label="זיכרון">
        <CardTitle icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}>זיכרון · RAM</CardTitle>
        {memory ? <>
          <div className="grid grid-cols-2 gap-4"><Metric label="בשימוש" prominent>{formatServerBytes(memory.usedBytes)}</Metric><Metric label="זמין לשימוש" prominent>{formatServerBytes(memory.availableBytes)}</Metric></div>
          <Meter value={memory.usedPercent} label="ניצול זיכרון" />
          <Trend history={history} select={sample => sample.memory?.usedPercent ?? null} label="היסטוריית ניצול זיכרון" maximum={100} />
          <div className="mt-3 grid grid-cols-3 gap-3"><Metric label="סך הכול">{formatServerBytes(memory.totalBytes)}</Metric><Metric label="פנוי לגמרי">{formatServerBytes(memory.freeBytes)}</Metric><Metric label="מטמון / buffers">{formatServerBytes(memory.cacheBytes)}</Metric></div>
          <p className="ss-muted mt-3 text-[11px] leading-5">הזיכרון הזמין כולל מטמון שהמערכת יכולה לפנות; הוא אינו זהה לזיכרון הפנוי לגמרי.</p>
          <div className="ss-row mt-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--ss-border)' }}><span className="ss-muted">Swap · בשימוש / סך הכול</span><bdi dir="ltr" className="ss-number">{formatServerBytes(memory.swapUsedBytes)} / {formatServerBytes(memory.swapTotalBytes)}</bdi></div>
        </> : <p className="ss-muted text-sm">נתוני הזיכרון אינם זמינים בשרת הזה.</p>}
      </section>
    </div>
    <section className="ss-card" aria-label="אחסון">
      <CardTitle icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}>אחסון · נפחים מותקנים</CardTitle>
      {storage ? <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{groupServerVolumes(storage.volumes).map(group => <div key={group.medium} className="min-w-0 rounded-xl border p-3" style={{ borderColor: 'var(--ss-border)' }}>
          <h4 className="mb-3 text-sm font-semibold">{MEDIUM_LABELS[group.medium]}</h4>
          {group.volumes.length ? <><Metric label="פנוי לשימוש" prominent>{formatServerBytes(group.availableBytes)}</Metric><Meter value={group.totalBytes ? group.usedBytes / group.totalBytes * 100 : null} label={`ניצול אחסון ${MEDIUM_LABELS[group.medium]}`} /><div className="ss-row mt-3 text-[11px]"><span className="ss-muted">בשימוש</span><bdi dir="ltr">{formatServerBytes(group.usedBytes)}</bdi></div><div className="ss-row mt-1 text-[11px]"><span className="ss-muted">סך הכול</span><bdi dir="ltr">{formatServerBytes(group.totalBytes)}</bdi></div>{group.reservedBytes > 0 && <div className="ss-row mt-1 text-[11px]"><span className="ss-muted">שמור למערכת</span><bdi dir="ltr">{formatServerBytes(group.reservedBytes)}</bdi></div>}</> : <p className="ss-muted text-xs leading-5">לא זוהה נפח מותקן מסוג זה.</p>}
        </div>)}</div>
        <div className="mt-4 space-y-3">{storage.volumes.map(volume => <div key={`${volume.device}:${volume.mount}`} className="rounded-xl p-3" style={{ background: 'var(--ss-soft)' }}>
          <div className="ss-row"><bdi dir="ltr" className="min-w-0 break-all font-mono text-xs">{volume.mount}</bdi><span className="ss-muted text-[10px]" dir="ltr">{MEDIUM_LABELS[volume.medium]} · {volume.filesystem}</span></div>
          <div className="ss-muted mt-1 break-all font-mono text-[10px]" dir="ltr">{volume.device}</div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="סך הכול">{formatServerBytes(volume.totalBytes)}</Metric><Metric label="בשימוש">{formatServerBytes(volume.usedBytes)}</Metric><Metric label="פנוי לשימוש">{formatServerBytes(volume.availableBytes)}</Metric><Metric label="ניצול">{formatServerPercent(volume.usedPercent)}</Metric></div>
          <Meter value={volume.usedPercent} label={`ניצול נפח ${volume.mount}`} />
        </div>)}</div>
        <p className="ss-muted mt-3 text-[11px] leading-5">מוצגים נפחי מערכת קבצים ייחודיים, לא סכום דיסקים פיזיים לפני RAID. הסיווג נקרא מהחומרה; נפח שלא זוהה אינו משויך אוטומטית ל־HDD. נתוני אחסון: {sampleTime(storage.sampledAt)}.</p>
      </> : <p className="ss-muted text-sm">נתוני האחסון אינם זמינים בשרת הזה.</p>}
    </section>
    <section className="ss-card" aria-label="תעבורת רשת">
      <CardTitle icon={<Network className="h-4 w-4" aria-hidden="true" />}>תעבורת רשת</CardTitle>
      {network?.length ? <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{network.map(adapter => <div key={adapter.name} className="min-w-0 rounded-xl border p-3" style={{ borderColor: 'var(--ss-border)' }}>
        <div className="ss-row mb-3"><h4 className="font-mono text-sm" dir="ltr">{adapter.name}</h4><span className="ss-muted text-[11px]">{adapter.isDefault ? 'ממשק ברירת המחדל · ' : ''}<bdi>{adapter.state}</bdi></span></div>
        <div className="grid grid-cols-2 gap-4"><Metric label="↓ הורדה · RX" prominent><span style={{ color: 'var(--ss-rx)' }}>{formatServerRate(adapter.receiveBytesPerSecond)}</span></Metric><Metric label="↑ העלאה · TX" prominent><span style={{ color: 'var(--ss-tx)' }}>{formatServerRate(adapter.transmitBytesPerSecond)}</span></Metric></div>
        <div className="grid grid-cols-2 gap-4"><Trend history={history} select={sample => sample.network?.find(item => item.name === adapter.name)?.receiveBytesPerSecond ?? null} label={`קצב הורדה ${adapter.name}`} color="var(--ss-rx)" /><Trend history={history} select={sample => sample.network?.find(item => item.name === adapter.name)?.transmitBytesPerSecond ?? null} label={`קצב העלאה ${adapter.name}`} color="var(--ss-tx)" /></div>
        <div className="ss-row mt-3 text-xs"><span className="ss-muted">מהירות קישור מדווחת</span><bdi dir="ltr">{adapter.linkSpeedMbps == null ? 'לא זמינה' : `${adapter.linkSpeedMbps.toLocaleString('en-US')} Mbps`}</bdi></div>
        <div className="mt-3 grid grid-cols-2 gap-4"><Metric label="RX מצטבר במערכת">{formatServerBytes(adapter.receivedBytes)}</Metric><Metric label="TX מצטבר במערכת">{formatServerBytes(adapter.transmittedBytes)}</Metric></div>
      </div>)}</div> : <p className="ss-muted text-sm">נתוני ממשקי הרשת אינם זמינים בשרת הזה.</p>}
      <p className="ss-muted mt-3 text-[11px] leading-5">זהו קצב תעבורה נמדד, לא בדיקת מהירות ולא מכסה של ספק האחסון. מהירות הקישור אינה הבטחת רוחב פס. ממשקים אינם נסכמים כדי למנוע ספירה כפולה.</p>
    </section>
    {!!snapshot.warnings.length && <section className="ss-card" aria-label="מידע על הדגימה"><h3 className="text-xs font-semibold">מידע על הדגימה</h3><ul className="ss-muted mt-2 list-inside list-disc space-y-1 text-xs leading-5">{snapshot.warnings.map((warning, index) => <li key={index}>{serverStatusWarningLabel(warning)}</li>)}</ul></section>}
  </div>;
}

function sampleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'לא זמין' : date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ServerStatusDialog({ serverId, serverLabel, loadStatus, onClose }: ServerStatusDialogProps) {
  const [data, setData] = useState<{ serverId: string; history: ServerStatusSnapshot[] }>({ serverId, history: [] });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(Date.now);
  const loadRef = useRef(loadStatus);
  const polling = useRef<ReturnType<typeof startServerStatusPolling> | null>(null);
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  loadRef.current = loadStatus;
  useEffect(() => {
    setData({ serverId, history: [] });
    setError(null);
    const controller = startServerStatusPolling({
      load: signal => loadRef.current(signal), visibility: document, onPending: setPending, onVisibility: setHidden,
      onSnapshot: snapshot => {
        setError(null);
        setNow(Date.now());
        setData(old => ({ serverId, history: appendServerStatusHistory(old.serverId === serverId ? old.history : [], snapshot) }));
      },
      onError: failure => setError(failure.message || 'קריאת מצב השרת נכשלה.'),
    });
    polling.current = controller;
    const clock = setInterval(() => setNow(Date.now()), 2_000);
    return () => { controller.stop(); clearInterval(clock); if (polling.current === controller) polling.current = null; };
  }, [serverId]);
  const history = data.serverId === serverId ? data.history : [];
  const snapshot = history.at(-1);
  const stale = !!snapshot && now - Date.parse(snapshot.sampledAt) > 10_000;
  const primary = primaryServerNetwork(snapshot?.network);
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    const original = previousFocus.current;
    const target = original?.isConnected && original !== document.body
      ? original
      : document.querySelector<HTMLButtonElement>('button[aria-label="פעולות"]');
    target?.focus({ preventScroll: true });
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <div className="code-ai-server-status" dir="rtl">
      <style>{STATUS_STYLES}</style>
      <Dialog.Overlay className="fixed inset-0 z-[140] bg-black/40" />
      <Dialog.Content data-testid="server-status-dialog" data-server-id={serverId} aria-label={`מצב שרת · ${serverLabel}`} dir="rtl" className="fixed left-1/2 top-1/2 z-[141] flex max-h-[94dvh] w-[calc(100vw-1rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none sm:rounded-3xl" style={{ background: 'var(--ss-bg)', borderColor: 'var(--ss-border)', color: 'var(--ss-text)' }} onCloseAutoFocus={restoreFocus}>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 sm:px-6 sm:py-4" style={{ borderColor: 'var(--ss-border)' }}>
          <div className="min-w-0"><Dialog.Title className="flex items-center gap-2 text-base font-semibold"><Server className="h-5 w-5 shrink-0" aria-hidden="true" />מצב שרת</Dialog.Title><Dialog.Description className="ss-muted mt-1 break-words text-xs leading-5">{serverLabel} · ניטור חי לקריאה בלבד</Dialog.Description></div>
          <div className="flex shrink-0 gap-1"><button type="button" onClick={() => polling.current?.refresh()} disabled={pending || hidden} aria-label="רענן מצב שרת" title="רענן מצב שרת" className="flex h-11 w-11 items-center justify-center rounded-xl disabled:opacity-40"><RefreshCw className="h-4 w-4" aria-hidden="true" /></button><Dialog.Close asChild><button type="button" aria-label="סגור מצב שרת" className="flex h-11 w-11 items-center justify-center rounded-xl"><X className="h-5 w-5" aria-hidden="true" /></button></Dialog.Close></div>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <div className="ss-row mb-4 text-[11px]"><span className="flex items-center gap-2" role="status" aria-live="polite"><Activity className="h-3.5 w-3.5" aria-hidden="true" /><span>{hidden ? 'הדגימה מושהית כשהלשונית אינה מוצגת' : error ? 'העדכון נכשל' : stale ? 'מוצגת דגימה ישנה' : snapshot ? 'מתעדכן כל כ־2 שניות' : 'קורא נתוני שרת…'}</span></span>{snapshot && <span className="ss-muted">דגימה אחרונה: <time dateTime={snapshot.sampledAt}>{sampleTime(snapshot.sampledAt)}</time></span>}</div>
          {(error || stale) && <div role="alert" className="mb-4 rounded-xl border p-3 text-xs leading-6" style={{ borderColor: 'var(--ss-amber)', color: 'var(--ss-amber)' }}>{error || 'לא התקבלה דגימה חדשה במשך יותר מ־10 שניות.'} {snapshot ? 'הנתונים למטה הם הדגימה האחרונה שנקראה, ולא מצב חי מאומת.' : 'לא מוצגים נתונים משרת אחר.'}<button type="button" onClick={() => polling.current?.refresh()} disabled={pending || hidden} className="mt-2 flex min-h-11 items-center gap-2 rounded-lg px-3 font-semibold disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{pending ? 'מנסה שוב…' : 'נסה שוב'}</button></div>}
          {snapshot ? <ServerStatusView snapshot={snapshot} history={history} /> : !error && <div className="ss-card py-12 text-center"><Server className="ss-muted mx-auto mb-3 h-8 w-8" aria-hidden="true" /><p className="text-sm">ממתין למדידה אמיתית מהשרת הנבחר</p><p className="ss-muted mt-2 text-xs leading-6">CPU ותעבורת רשת עשויים להזדקק לשתי דגימות. לא מוצגים ערכי הדגמה.</p></div>}
        </div>
        <footer className="ss-row ss-muted shrink-0 border-t px-4 py-3 text-[10px] leading-5 sm:px-6" style={{ borderColor: 'var(--ss-border)' }}><span>עד 60 דגימות בחלון · ההיסטוריה אינה נשמרת</span>{primary && <span className="flex items-center gap-1"><ArrowDown className="h-3 w-3" aria-hidden="true" /><ArrowUp className="h-3 w-3" aria-hidden="true" />ממשק ראשי: <bdi dir="ltr">{primary.name}</bdi></span>}</footer>
      </Dialog.Content>
    </div>
  </Dialog.Root>;
}
