import { FolderSearch2, Globe2, MessageCircle, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ConversationSearchScope = 'current' | 'project' | 'all';

export interface CodexSessionConversationSearchModeValue {
  enabled: boolean;
  scope: ConversationSearchScope;
  projectRoot: string;
  createdAt: string | null;
  updatedAt: string | null;
}

const SCOPE_OPTIONS: Array<{
  id: ConversationSearchScope;
  title: string;
  description: string;
  icon: typeof Search;
}> = [
  {
    id: 'current',
    title: 'השיחה הזאת',
    description: 'חיפוש ממוקד רק בהודעות המשתמש ובתשובות הסופיות של הסשן הפעיל.',
    icon: MessageCircle,
  },
  {
    id: 'project',
    title: 'כל שיחות הפרויקט',
    description: 'חיפוש בכל הסשנים שתיקיית העבודה שלהם נמצאת בתוך הפרויקט הנבחר.',
    icon: FolderSearch2,
  },
  {
    id: 'all',
    title: 'כל השיחות',
    description: 'חיפוש בכל היסטוריית Codex הנגישה, בכל הפרופילים המקומיים ובארכיון.',
    icon: Globe2,
  },
];

export function ConversationSearchModeDialog({
  isOpen,
  provider,
  value,
  workspaceRoot,
  isSaving,
  onClose,
  onChange,
  onSave,
  onDisable,
}: {
  isOpen: boolean;
  provider: 'codex' | 'claude' | 'gemini' | null;
  value: CodexSessionConversationSearchModeValue;
  workspaceRoot: string;
  isSaving: boolean;
  onClose: () => void;
  onChange: (value: CodexSessionConversationSearchModeValue) => void;
  onSave: () => Promise<void> | void;
  onDisable: () => Promise<void> | void;
}) {
  if (!isOpen) return null;
  const codexOnly = provider === 'codex';
  const effectiveProjectRoot = value.projectRoot || workspaceRoot;

  return (
    <div className="fixed inset-0 z-[82] flex items-end justify-center bg-slate-950/25 p-3 backdrop-blur-sm sm:items-center" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב חיפוש בשיחות" />
      <div className="relative z-10 flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-[2rem] border border-blue-100 bg-[#fbfcff] shadow-[0_34px_110px_-44px_rgba(37,99,235,0.45)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
              <Search className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-500">Conversation Search</div>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">מצב חיפוש בשיחות</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">הסוכן מחפש בהיסטוריה באופן דטרמיניסטי, מאמת את המקור ומחזיר ראיה וקישור ישיר לסשן.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" aria-label="סגור">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {!codexOnly && (
            <div className="mb-4 rounded-[1.2rem] border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">מצב חיפוש בשיחות זמין כרגע רק בפרופיל Codex.</div>
          )}

          <div className="space-y-3">
            {SCOPE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = value.scope === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!codexOnly || isSaving}
                  onClick={() => onChange({
                    ...value,
                    scope: option.id,
                    projectRoot: option.id === 'project' ? effectiveProjectRoot : value.projectRoot,
                  })}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-[1.35rem] border p-4 text-right transition',
                    selected ? 'border-blue-300 bg-blue-50 ring-2 ring-blue-100' : 'border-slate-100 bg-white hover:border-blue-200 hover:bg-blue-50/40',
                    (!codexOnly || isSaving) && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', selected ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-500')}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                      {option.title}
                      {selected && <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white">נבחר</span>}
                    </span>
                    <span className="mt-1 block text-xs leading-6 text-slate-500">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {value.scope === 'project' && (
            <label className="mt-4 block rounded-[1.25rem] border border-slate-100 bg-white p-4 shadow-sm">
              <span className="text-xs font-semibold text-slate-700">תיקיית הפרויקט</span>
              <span className="mt-1 block text-[11px] leading-5 text-slate-400">ייכללו רק סשנים שה־cwd שלהם הוא התיקייה הזאת או תיקייה פנימית שלה.</span>
              <input
                dir="ltr"
                value={effectiveProjectRoot}
                disabled={!codexOnly || isSaving}
                onChange={(event) => onChange({ ...value, projectRoot: event.currentTarget.value })}
                className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-left font-mono text-xs text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
                placeholder="/path/to/project"
              />
            </label>
          )}

          <div className="mt-4 rounded-[1.25rem] border border-blue-100 bg-blue-50/70 px-4 py-3 text-xs leading-6 text-blue-900">
            החיפוש אינו משנה קובצי היסטוריה. הסקיל מסנן פלטי כלים, הוראות מערכת ועותקי fork, ומציג רק התאמות מאומתות מתוך הודעות אמיתיות.
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4">
          {value.enabled ? (
            <button type="button" disabled={isSaving} onClick={onDisable} className="rounded-full border border-rose-100 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-100 disabled:opacity-50">כבה מצב</button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={isSaving} className="rounded-full border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">ביטול</button>
            <button
              type="button"
              disabled={!codexOnly || isSaving || (value.scope === 'project' && !effectiveProjectRoot.trim())}
              onClick={onSave}
              className="rounded-full bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'שומר...' : value.enabled ? 'שמור' : 'הפעל מצב'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
