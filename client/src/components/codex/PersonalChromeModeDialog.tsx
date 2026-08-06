import { Check, Chrome, Copy, Link2, Loader2, MonitorSmartphone, RefreshCw, ShieldCheck, Unplug, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PersonalChromeApprovalPolicy = 'risky' | 'always' | 'never';

export interface PersonalChromeModeValue {
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  tabId: number | null;
  approvalPolicy: PersonalChromeApprovalPolicy;
  allowJavascript: boolean;
  allowUploads: boolean;
  allowPorts: boolean;
  bindingId: string | null;
}

export interface PersonalChromeDeviceValue {
  id: string;
  name: string;
  extensionId: string | null;
  platform: string | null;
  browserVersion: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  online: boolean;
  connectedAt: string | null;
  capabilities: string[];
}

export interface PersonalChromePairingValue {
  code: string;
  expiresAt: string;
  controlUrl: string;
}

interface Props {
  isOpen: boolean;
  provider: string | null;
  value: PersonalChromeModeValue;
  devices: PersonalChromeDeviceValue[];
  pairing: PersonalChromePairingValue | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (next: PersonalChromeModeValue) => void;
  onRefresh: () => void;
  onCreatePairing: () => void;
  onRevokeDevice: (deviceId: string) => void;
  onSave: () => void;
  onDisable: () => void;
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      dir="ltr"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-indigo-500' : 'bg-slate-200'
      )}
    >
      <span className={cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

export function PersonalChromeModeDialog({
  isOpen, provider, value, devices, pairing, isLoading, isSaving, error,
  onClose, onChange, onRefresh, onCreatePairing, onRevokeDevice, onSave, onDisable,
}: Props) {
  if (!isOpen) return null;
  const providerSupported = provider === 'codex';
  const selectedDevice = devices.find((device) => device.id === value.deviceId) || null;

  return (
    <div className="fixed inset-0 z-[96] flex items-end justify-center bg-slate-950/30 p-3 backdrop-blur-sm sm:items-center" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב Chrome אישי" />
      <section className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-slate-100 bg-white shadow-[0_32px_100px_-34px_rgba(15,23,42,.45)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-50 to-sky-50 text-indigo-600">
              <Chrome className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Personal Chrome</div>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">Chrome אישי</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">Codex עובד בתוך ה־Chrome האמיתי במחשב שלך, עם בחירת רכיבים, קונסול, רשת ואישורים.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 touch-pan-y [-webkit-overflow-scrolling:touch]">
          {!providerSupported && (
            <div className="rounded-[1.4rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">מצב Chrome אישי זמין לסשני Codex בלבד.</div>
          )}

          <div className="flex items-center justify-between gap-4 rounded-[1.4rem] border border-indigo-100 bg-indigo-50/60 p-4">
            <div>
              <div className="text-sm font-semibold text-slate-900">הפעל לסשן הזה</div>
              <div className="mt-1 text-xs leading-5 text-slate-500">החיבור קשור למכשיר ולסשן, וניתן לבטל אותו בכל רגע.</div>
            </div>
            <Toggle checked={value.enabled} disabled={!providerSupported} onChange={(enabled) => onChange({ ...value, enabled })} />
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">המכשירים שלי</div>
              <div className="mt-1 text-xs text-slate-500">בחר את ה־Chrome שאליו הסשן יתחבר.</div>
            </div>
            <button type="button" onClick={onRefresh} disabled={isLoading} className="rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
            </button>
          </div>

          <div className="mt-3 grid gap-3">
            {devices.map((device) => {
              const selected = value.deviceId === device.id;
              return (
                <div
                  role="button"
                  tabIndex={0}
                  key={device.id}
                  onClick={() => onChange({ ...value, deviceId: device.id, deviceName: device.name, tabId: null })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onChange({ ...value, deviceId: device.id, deviceName: device.name, tabId: null });
                  }}
                  className={cn(
                    'group flex w-full cursor-pointer items-center justify-between gap-3 rounded-[1.35rem] border px-4 py-3 text-right transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                    selected ? 'border-indigo-300 bg-indigo-50/70 ring-2 ring-indigo-100' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', device.online ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400')}><MonitorSmartphone className="h-5 w-5" /></span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <span className="truncate">{device.name}</span>
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', device.online ? 'bg-emerald-400' : 'bg-slate-300')} />
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-400">{device.online ? 'מחובר עכשיו' : device.lastSeenAt ? `נראה לאחרונה ${new Date(device.lastSeenAt).toLocaleString('he-IL')}` : 'טרם התחבר'}</span>
                    </span>
                  </div>
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`בטל חיבור ${device.name}`}
                      onClick={(event) => { event.stopPropagation(); onRevokeDevice(device.id); }}
                      className="rounded-full p-2 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
                    ><Unplug className="h-4 w-4" /></button>
                    {selected && <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-500 text-white"><Check className="h-4 w-4" /></span>}
                  </span>
                </div>
              );
            })}
            {!isLoading && devices.length === 0 && (
              <div className="rounded-[1.35rem] border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm leading-6 text-slate-500">עדיין אין Chrome מזווג. צור קוד וחבר את התוסף מהמחשב האישי.</div>
            )}
          </div>

          <div className="mt-4 rounded-[1.4rem] border border-sky-100 bg-sky-50/55 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Link2 className="h-4 w-4 text-sky-600" />חיבור תוסף חדש</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">הקוד תקף לעשר דקות וניתן לשימוש פעם אחת.</div>
              </div>
              <button type="button" onClick={onCreatePairing} className="rounded-full bg-sky-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-700">צור קוד</button>
            </div>
            {pairing && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-sky-200 bg-white px-4 py-3" dir="ltr">
                <code className="text-lg font-bold tracking-[0.16em] text-slate-900">{pairing.code}</code>
                <button type="button" onClick={() => void navigator.clipboard.writeText(pairing.code)} className="rounded-full bg-slate-100 p-2 text-slate-500 hover:bg-slate-200"><Copy className="h-4 w-4" /></button>
              </div>
            )}
          </div>

          <div className="mt-5 rounded-[1.4rem] border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-900">מדיניות פעולה</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {([
                ['risky', 'חכם', 'אישור בפעולות מסוכנות'],
                ['always', 'קפדני', 'אישור לכל שינוי'],
                ['never', 'מהיר', 'ללא שאלת אישור'],
              ] as const).map(([policy, label, description]) => (
                <button key={policy} type="button" onClick={() => onChange({ ...value, approvalPolicy: policy })} className={cn('rounded-xl border px-2 py-3 text-center transition', value.approvalPolicy === policy ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}>
                  <span className="block text-xs font-semibold">{label}</span><span className="mt-1 block text-[10px] leading-4">{description}</span>
                </button>
              ))}
            </div>

            <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60 px-3">
              {([
                ['allowJavascript', 'הרצת JavaScript', 'כלי מתקדם; פעולות mutation עדיין עשויות לבקש אישור.'],
                ['allowUploads', 'צירוף קבצים', 'מאפשר לשלוח קובץ מוגבל בגודל ל־input בדף.'],
                ['allowPorts', 'פורטי פיתוח', 'פתיחת פורטים מקומיים על 127.0.0.1 בלבד ועם TTL.'],
              ] as const).map(([field, title, description]) => (
                <div key={field} className="flex items-center justify-between gap-4 py-3">
                  <div><div className="text-xs font-semibold text-slate-800">{title}</div><div className="mt-1 text-[11px] leading-5 text-slate-500">{description}</div></div>
                  <Toggle checked={value[field]} onChange={(checked) => onChange({ ...value, [field]: checked })} />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex gap-2 rounded-[1.25rem] border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-xs leading-6 text-emerald-900">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>כל session binding ניתן לביטול. תוכן אתרים מסומן כקלט לא מהימן, כותרות רגישות מסוננות, ופורטים אינם נפתחים לרשת.</span>
          </div>

          {error && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4">
          <button type="button" onClick={onDisable} disabled={isSaving || !value.bindingId} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">כבה ובטל חיבור</button>
          <button type="button" onClick={onSave} disabled={isSaving || !providerSupported || (value.enabled && !selectedDevice)} className="flex items-center gap-2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}{isSaving ? 'שומר…' : 'שמור מצב'}
          </button>
        </footer>
      </section>
    </div>
  );
}
