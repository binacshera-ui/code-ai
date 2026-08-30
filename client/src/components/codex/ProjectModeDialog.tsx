import {
  CheckCircle2,
  Download,
  Factory,
  FileJson2,
  FolderTree,
  Gauge,
  Globe2,
  LoaderCircle,
  Palette,
  Upload,
  UsersRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  PROJECT_MODE_CONFIG_MAX_BYTES,
  parseProjectModeConfigText,
  serializeProjectModeConfig,
} from './projectModeConfig';

export interface CodexProjectPaletteValue {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
}

export interface CodexSessionProjectModeValue {
  enabled: boolean;
  projectName: string;
  geminiProfileId: string;
  uiProtocol: 'http' | 'https';
  uiPort: number;
  uiUrl: string;
  frontendRoot: string;
  backendRoot: string;
  designSystemPath: string;
  productBrief: string;
  businessContext: string;
  primaryOutcome: string;
  targetAudience: string;
  userArchetypes: string;
  userResearchNotes: string;
  contentVoice: string;
  locales: string;
  accessibilityRequirements: string;
  responsiveRequirements: string;
  analyticsRequirements: string;
  designSchool: string;
  desiredFeeling: string;
  fontFamily: string;
  palette: CodexProjectPaletteValue;
  direction: 'rtl' | 'ltr' | 'mixed';
  platform: 'responsive-web' | 'desktop-web' | 'mobile-web' | 'native-like-web' | 'multi-surface';
  preserveExistingUi: boolean;
  simpleProfessionalMode: boolean;
  referenceUrls: string[];
  constraints: string[];
  successCriteria: string[];
  programScale: 'focused' | 'full' | 'enterprise';
  maxParallelAgents: number;
  portReachable: boolean;
  portCheckedAt: string | null;
  artifactsRoot: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectModeProfileOption {
  id: string;
  label: string;
}

export interface ProjectModeImportOutcome {
  ok: boolean;
  error?: string;
}

interface ProjectModeImportState {
  phase: 'idle' | 'reading' | 'saving' | 'success' | 'error';
  fileName: string;
  message: string;
}

function lines(values: string[]): string {
  return values.join('\n');
}

function parseLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block rounded-[1.25rem] border border-slate-100 bg-white p-4 shadow-sm">
      <span className="text-xs font-semibold text-slate-700">{label}</span>
      {hint && <span className="mt-1 block text-[10px] leading-5 text-slate-400">{hint}</span>}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const safeColor = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <label className="rounded-[1rem] border border-slate-100 bg-white p-3">
      <span className="text-[11px] font-medium text-slate-600">{label}</span>
      <span className="mt-2 flex items-center gap-2" dir="ltr">
        <input type="color" value={safeColor} onChange={(event) => onChange(event.currentTarget.value)} className="h-9 w-11 cursor-pointer rounded-lg border-0 bg-transparent p-0" />
        <input value={value} onChange={(event) => onChange(event.currentTarget.value)} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-2.5 py-2 font-mono text-[11px] text-slate-700 outline-none focus:border-violet-300" />
      </span>
    </label>
  );
}

export function ProjectModeDialog({
  isOpen,
  provider,
  value,
  profiles,
  isSaving,
  onClose,
  onChange,
  onImport,
  onSave,
  onDisable,
}: {
  isOpen: boolean;
  provider: 'codex' | 'claude' | 'gemini' | null;
  value: CodexSessionProjectModeValue;
  profiles: ProjectModeProfileOption[];
  isSaving: boolean;
  onClose: () => void;
  onChange: (value: CodexSessionProjectModeValue) => void;
  onImport: (value: CodexSessionProjectModeValue) => Promise<ProjectModeImportOutcome>;
  onSave: () => Promise<void> | void;
  onDisable: () => Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingConfig, setIsDraggingConfig] = useState(false);
  const [importState, setImportState] = useState<ProjectModeImportState>({
    phase: 'idle',
    fileName: '',
    message: '',
  });

  useEffect(() => {
    if (!isOpen) {
      setIsDraggingConfig(false);
      setImportState({ phase: 'idle', fileName: '', message: '' });
    }
  }, [isOpen]);

  if (!isOpen) return null;
  const codexOnly = provider === 'codex';
  const inputClass = 'w-full rounded-[1rem] border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none placeholder:text-slate-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-100';
  const textareaClass = `${inputClass} min-h-[7rem] resize-y leading-6`;

  async function importConfigFile(file: File): Promise<void> {
    if (!codexOnly || isSaving || importState.phase === 'saving') return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      setImportState({ phase: 'error', fileName: file.name, message: 'יש לבחור קובץ עם סיומת .json.' });
      return;
    }
    if (file.size > PROJECT_MODE_CONFIG_MAX_BYTES) {
      setImportState({ phase: 'error', fileName: file.name, message: 'הקובץ גדול מ־256KB.' });
      return;
    }

    setImportState({ phase: 'reading', fileName: file.name, message: 'קורא ומאמת את הקובץ...' });
    try {
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('הקובץ אינו מקודד כ־UTF‑8 תקין. שמור אותו מחדש כ־UTF‑8 ונסה שוב.');
      }
      const imported = parseProjectModeConfigText(source, value, profiles.map((profile) => profile.id));
      onChange(imported.value);
      setImportState({ phase: 'saving', fileName: file.name, message: 'בודק פורט, תיקיות ושדות ומפעיל את המצב...' });
      const outcome = await onImport(imported.value);
      if (!outcome.ok) throw new Error(outcome.error || 'השרת דחה את הפעלת מצב הפרויקט.');
      const warningText = imported.warnings.length > 0 ? ` ${imported.warnings.join(' ')}` : '';
      setImportState({ phase: 'success', fileName: file.name, message: `מצב הפרויקט הופעל בהצלחה.${warningText}` });
    } catch (error: any) {
      setImportState({
        phase: 'error',
        fileName: file.name,
        message: error?.message || 'לא ניתן לייבא את קובץ ה־JSON.',
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleConfigDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsDraggingConfig(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void importConfigFile(file);
  }

  function downloadCurrentConfig(): void {
    const blob = new Blob([serializeProjectModeConfig(value)], { type: 'application/json;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const safeProjectName = value.projectName.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
    anchor.href = objectUrl;
    anchor.download = `${safeProjectName}.project-mode.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <div className="fixed inset-0 z-[82] flex items-end justify-center bg-slate-950/30 p-3 backdrop-blur-sm sm:items-center sm:p-5" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב פרויקט" />
      <div className="relative z-10 flex max-h-[96dvh] w-full max-w-4xl flex-col overflow-hidden rounded-[2rem] border border-violet-100 bg-[#fbfbfd] shadow-[0_38px_130px_-45px_rgba(109,40,217,0.45)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700"><Factory className="h-5 w-5" /></div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-500">Project UI & Product Factory</div>
              <div className="mt-0.5 text-lg font-semibold text-slate-900">מצב פרויקט · צוות מוצר ו־UI אוטונומי</div>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">סוכני Codex, מועצת UX של Gemini ומועצת Design של Gemini עובדים בגלים על ה־UI החי והבקאנד שסיפקת.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {!codexOnly && <div className="mb-4 rounded-[1.2rem] border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">מצב פרויקט זמין רק בפרופיל Codex.</div>}

          <section
            className={cn(
              'mb-4 rounded-[1.5rem] border bg-white p-4 shadow-sm transition',
              isDraggingConfig ? 'border-violet-400 bg-violet-50 ring-4 ring-violet-100' : 'border-violet-100',
            )}
            onDragEnter={(event) => {
              event.preventDefault();
              if (codexOnly) setIsDraggingConfig(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingConfig(false);
            }}
            onDrop={handleConfigDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importConfigFile(file);
              }}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700"><FileJson2 className="h-5 w-5" /></div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">הפעל באמצעות קובץ JSON</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">בחר או גרור קובץ עד 256KB. לאחר אימות UTF‑8 וחוזה v1, המערכת תבדוק את הפורט והתיקיות ותפעיל מיד את המצב.</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!codexOnly || isSaving || importState.phase === 'saving'}
                  className="inline-flex items-center gap-2 rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {importState.phase === 'reading' || importState.phase === 'saving' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  בחר JSON והפעל
                </button>
                <button type="button" onClick={downloadCurrentConfig} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50">
                  <Download className="h-4 w-4" />הורד JSON נוכחי
                </button>
              </div>
            </div>
            {importState.phase !== 'idle' && (
              <div
                className={cn(
                  'mt-3 rounded-xl border px-3 py-2 text-xs leading-5',
                  importState.phase === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
                  importState.phase === 'error' && 'border-rose-200 bg-rose-50 text-rose-800',
                  (importState.phase === 'reading' || importState.phase === 'saving') && 'border-violet-100 bg-violet-50 text-violet-800',
                )}
                role={importState.phase === 'error' ? 'alert' : 'status'}
              >
                {importState.fileName && <span className="font-semibold" dir="auto">{importState.fileName}: </span>}
                {importState.message}
              </div>
            )}
          </section>

          <section className="rounded-[1.5rem] border border-violet-100 bg-violet-50/55 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">הפעל מפעל פרויקט לסשן</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">לא ניתן לשמור מצב פעיל לפני שפורט ה־UI פתוח וכל שדות החובה נבדקו בשרת.</div>
              </div>
              <button type="button" role="switch" aria-checked={value.enabled} disabled={!codexOnly} onClick={() => codexOnly && onChange({ ...value, enabled: !value.enabled })} dir="ltr" className={cn('relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition', value.enabled ? 'bg-violet-600' : 'bg-slate-200', !codexOnly && 'opacity-50')}>
                <span className={cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', value.enabled ? 'translate-x-5' : 'translate-x-0')} />
              </button>
            </div>
            {value.portReachable && value.uiUrl && (
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-[11px] font-medium text-emerald-700" dir="ltr"><CheckCircle2 className="h-3.5 w-3.5" />{value.uiUrl}</div>
            )}
          </section>

          <section className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="שם הפרויקט"><input value={value.projectName} onChange={(event) => onChange({ ...value, projectName: event.currentTarget.value })} placeholder="למשל: העסק שלכם" className={inputClass} /></Field>
            <Field label="חשבון Gemini למועצות"><select value={value.geminiProfileId} onChange={(event) => onChange({ ...value, geminiProfileId: event.currentTarget.value })} className={inputClass}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></Field>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Globe2 className="h-4 w-4 text-violet-600" />UI חי ותיקיות מקור</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <select value={value.uiProtocol} onChange={(event) => onChange({ ...value, uiProtocol: event.currentTarget.value as 'http' | 'https', portReachable: false })} className={inputClass} dir="ltr"><option value="http">http</option><option value="https">https</option></select>
              <input type="number" min={1} max={65535} value={value.uiPort || ''} onChange={(event) => onChange({ ...value, uiPort: Number(event.currentTarget.value) || 0, portReachable: false })} placeholder="פורט UI, לדוגמה 4177" className={inputClass} dir="ltr" />
            </div>
            <div className="mt-3 grid gap-3">
              <Field label="תיקיית frontend ראשית" hint="הקוד שמציג את ה־UI בפורט"><input value={value.frontendRoot} onChange={(event) => onChange({ ...value, frontendRoot: event.currentTarget.value })} className={inputClass} dir="ltr" /></Field>
              <Field label="תיקיית backend ראשית" hint="מקור היכולות, החוזים והלוגיקה"><input value={value.backendRoot} onChange={(event) => onChange({ ...value, backendRoot: event.currentTarget.value })} className={inputClass} dir="ltr" /></Field>
              <Field label="מערכת עיצוב קיימת — אופציונלי" hint="אם ריק, הצוות ייצור שפה לפי הבריף"><input value={value.designSystemPath} onChange={(event) => onChange({ ...value, designSystemPath: event.currentTarget.value })} className={inputClass} dir="ltr" /></Field>
            </div>
          </section>

          <section className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="בריף מוצר"><textarea value={value.productBrief} onChange={(event) => onChange({ ...value, productBrief: event.currentTarget.value })} placeholder="מה המוצר עושה, מה קיים ומה אסור לשבור..." className={textareaClass} /></Field>
            <Field label="התוצאה הראשית למשתמש"><textarea value={value.primaryOutcome} onChange={(event) => onChange({ ...value, primaryOutcome: event.currentTarget.value })} placeholder="מה המשתמש חייב להצליח לעשות ולהבין..." className={textareaClass} /></Field>
            <Field label="הקשר עסקי ומודל מוצר"><textarea value={value.businessContext} onChange={(event) => onChange({ ...value, businessContext: event.currentTarget.value })} placeholder="B2B/B2C, ענף, ערך עסקי, תמחור, סיכונים ורגולציה..." className={textareaClass} /></Field>
            <Field label="שפת תוכן וטון"><textarea value={value.contentVoice} onChange={(event) => onChange({ ...value, contentVoice: event.currentTarget.value })} placeholder="ישיר, אנושי, מקצועי, פעולות בשם פועל, מונחים אסורים..." className={textareaClass} /></Field>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-cyan-100 bg-cyan-50/35 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><UsersRound className="h-4 w-4 text-cyan-700" />משתמשים וחוויית מוצר</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="קהל יעד"><textarea value={value.targetAudience} onChange={(event) => onChange({ ...value, targetAudience: event.currentTarget.value })} className={textareaClass} placeholder="מי משתמש, באיזה הקשר ומה רמת המומחיות..." /></Field>
              <Field label="ארכיטיפי משתמש"><textarea value={value.userArchetypes} onChange={(event) => onChange({ ...value, userArchetypes: event.currentTarget.value })} className={textareaClass} placeholder="מפעיל, מנהל, מאשר, לקוח, משתמש מזדמן..." /></Field>
              <Field label="מחקר, כאבים והנחות — אופציונלי"><textarea value={value.userResearchNotes} onChange={(event) => onChange({ ...value, userResearchNotes: event.currentTarget.value })} className={textareaClass} /></Field>
              <Field label="אסכולת UX ועיצוב"><textarea value={value.designSchool} onChange={(event) => onChange({ ...value, designSchool: event.currentTarget.value })} className={textareaClass} placeholder="לדוגמה: מוצר B2B ישראלי חד, אנושי, מהיר, data-rich אך לא עמוס..." /></Field>
              <Field label="שפות ו־locales"><input value={value.locales} onChange={(event) => onChange({ ...value, locales: event.currentTarget.value })} className={inputClass} placeholder="he-IL, en-US" dir="ltr" /></Field>
              <Field label="יעד נגישות"><textarea value={value.accessibilityRequirements} onChange={(event) => onChange({ ...value, accessibilityRequirements: event.currentTarget.value })} className={textareaClass} /></Field>
              <Field label="דרישות responsive"><textarea value={value.responsiveRequirements} onChange={(event) => onChange({ ...value, responsiveRequirements: event.currentTarget.value })} className={textareaClass} /></Field>
              <Field label="Analytics ומדדי מוצר — אופציונלי"><textarea value={value.analyticsRequirements} onChange={(event) => onChange({ ...value, analyticsRequirements: event.currentTarget.value })} className={textareaClass} /></Field>
            </div>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-fuchsia-100 bg-fuchsia-50/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Palette className="h-4 w-4 text-fuchsia-700" />שפה חזותית</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="תחושה ואישיות מותג"><textarea value={value.desiredFeeling} onChange={(event) => onChange({ ...value, desiredFeeling: event.currentTarget.value })} className={textareaClass} placeholder="מה המשתמש אמור להרגיש; מה אסור שהממשק ישדר..." /></Field>
              <Field label="משפחת גופן"><input value={value.fontFamily} onChange={(event) => onChange({ ...value, fontFamily: event.currentTarget.value })} className={inputClass} placeholder="Rubik, Heebo, Assistant..." dir="ltr" /></Field>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(value.palette) as Array<keyof CodexProjectPaletteValue>).map((colorKey) => (
                <ColorField key={colorKey} label={colorKey} value={value.palette[colorKey]} onChange={(next) => onChange({ ...value, palette: { ...value.palette, [colorKey]: next }, portReachable: value.portReachable })} />
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="כיווניות"><select value={value.direction} onChange={(event) => onChange({ ...value, direction: event.currentTarget.value as CodexSessionProjectModeValue['direction'] })} className={inputClass}><option value="rtl">RTL</option><option value="ltr">LTR</option><option value="mixed">מעורב</option></select></Field>
              <Field label="פלטפורמה"><select value={value.platform} onChange={(event) => onChange({ ...value, platform: event.currentTarget.value as CodexSessionProjectModeValue['platform'] })} className={inputClass}><option value="responsive-web">Responsive Web</option><option value="desktop-web">Desktop Web</option><option value="mobile-web">Mobile Web</option><option value="native-like-web">Native-like Web</option><option value="multi-surface">Multi-surface</option></select></Field>
              <Field label="היקף התוכנית"><select value={value.programScale} onChange={(event) => onChange({ ...value, programScale: event.currentTarget.value as CodexSessionProjectModeValue['programScale'] })} className={inputClass}><option value="enterprise">Enterprise · 8 שלבים</option><option value="full">מלא · 6 שלבים</option><option value="focused">ממוקד · 4 שלבים</option></select></Field>
            </div>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Gauge className="h-4 w-4 text-violet-600" />כללי הפעלה</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3"><span className="text-xs text-slate-600">ה־UI הקיים הוא היעד שיש לפתח ולשמר</span><input type="checkbox" checked={value.preserveExistingUi} onChange={(event) => onChange({ ...value, preserveExistingUi: event.currentTarget.checked })} /></label>
              <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3"><span className="text-xs text-slate-600">אותה ליבה במצבי פשוט/מקצועי</span><input type="checkbox" checked={value.simpleProfessionalMode} onChange={(event) => onChange({ ...value, simpleProfessionalMode: event.currentTarget.checked })} /></label>
              <Field label={`סוכנים במקביל: ${value.maxParallelAgents}`}><input type="range" min={2} max={8} value={value.maxParallelAgents} onChange={(event) => onChange({ ...value, maxParallelAgents: Number(event.currentTarget.value) })} className="w-full accent-violet-600" /></Field>
            </div>
          </section>

          <section className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="רפרנסים — כתובת בכל שורה"><textarea value={lines(value.referenceUrls)} onChange={(event) => onChange({ ...value, referenceUrls: parseLines(event.currentTarget.value) })} className={textareaClass} dir="ltr" /></Field>
            <Field label="אילוצים — אחד בכל שורה"><textarea value={lines(value.constraints)} onChange={(event) => onChange({ ...value, constraints: parseLines(event.currentTarget.value) })} className={textareaClass} /></Field>
            <Field label="קריטריוני הצלחה"><textarea value={lines(value.successCriteria)} onChange={(event) => onChange({ ...value, successCriteria: parseLines(event.currentTarget.value) })} className={textareaClass} /></Field>
          </section>

          <section className="mt-4 rounded-[1.5rem] border border-violet-100 bg-violet-50/70 p-4 text-xs leading-6 text-violet-950">
            <div className="flex items-center gap-2 font-semibold"><FolderTree className="h-4 w-4" />תהליך של צוות מוצר אמיתי</div>
            <p className="mt-1 text-violet-800">המערכת תמפה בקאנד ומשתמשים, תנהל החלטות UX וניסוח, תבנה שפה חזותית, תפעיל צוותי יישום וביקורת, תבדוק את ה־UI בפורט בדפדפן, ותשמור ראיות ו־rollback. רפרנסים מחברות אחרות הם השראה בלבד — אין העתקת ממשק או מותג.</p>
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4 sm:px-6">
          <button type="button" onClick={() => void onDisable()} disabled={isSaving || !value.enabled} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">כבה מצב</button>
          <div className="flex items-center gap-2"><button type="button" onClick={onClose} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50">בטל</button><button type="button" onClick={() => void onSave()} disabled={isSaving || !codexOnly || (value.enabled && !value.geminiProfileId)} className="rounded-full bg-slate-950 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-900 disabled:opacity-40">{isSaving ? 'בודק ושומר...' : 'בדוק פורט ושמור'}</button></div>
        </footer>
      </div>
    </div>
  );
}
