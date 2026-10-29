import { useState } from 'react';
import { KeyRound, Loader2, LogIn, Plus, Trash2 } from 'lucide-react';
import type { CodexApiCredential } from './accountAuthenticationPresentation';

export function CodexApiKeyLogin({
  credentials, selectedId, loading, pending, onSelect, onSave, onDelete, onConnect, onClose,
}: {
  credentials: CodexApiCredential[];
  selectedId: string;
  loading: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onSave: (label: string, apiKey: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onConnect: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const disabled = pending || loading;
  const closeAddForm = () => {
    setApiKey('');
    setLabel('');
    setAdding(false);
  };

  return (
    <div className="mt-2 rounded-[0.75rem] border border-sky-200 bg-sky-50/50 p-2.5">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold text-sky-800">
        <KeyRound className="h-3.5 w-3.5" />
        כניסה עם מפתח API שמור
      </div>
      <div className="mt-1 text-[8px] leading-4 text-slate-500">
        בחר מפתח ולחץ על התחבר. השמירה לבדה אינה מחברת את החשבון.
      </div>
      {loading ? (
        <div className="mt-2 flex items-center justify-center gap-1.5 py-2 text-[9px] text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" /> טוען מפתחות שמורים…
        </div>
      ) : credentials.length ? (
        <div className="mt-2 space-y-1.5" role="radiogroup" aria-label="מפתחות API שמורים">
          {credentials.map((credential) => (
            <div key={credential.id} className="rounded-[0.6rem] border border-sky-100 bg-white px-2 py-1.5">
              <div className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[9px] text-slate-700">
                  <input
                    type="radio"
                    name="codex-api-credential"
                    value={credential.id}
                    checked={selectedId === credential.id}
                    disabled={disabled}
                    onChange={() => { onSelect(credential.id); setDeleteId(null); }}
                    className="accent-sky-600"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" dir="auto">{credential.label}</span>
                    <span className="block font-mono text-[8px] text-slate-400" dir="ltr">{credential.maskedSuffix}</span>
                  </span>
                </label>
                <button
                    type="button"
                    onClick={() => setDeleteId(deleteId === credential.id ? null : credential.id)}
                    disabled={disabled}
                    aria-label={`הסר מהרשימה את המפתח ${credential.label}`}
                    className="rounded p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  ><Trash2 className="h-3 w-3" /></button>
              </div>
              {deleteId === credential.id && (
                <div className="mt-1.5 border-t border-rose-100 pt-1.5 text-[8px] text-rose-700">
                  להסיר את המפתח מהרשימה?
                  <div className="mt-1 flex gap-1.5">
                    <button type="button" disabled={disabled} onClick={() => setDeleteId(null)} className="rounded border border-slate-200 px-2 py-1 text-slate-500">ביטול</button>
                    <button type="button" disabled={disabled} onClick={() => { setDeleteId(null); void onDelete(credential.id); }} className="rounded bg-rose-600 px-2 py-1 font-semibold text-white disabled:opacity-50">הסר מפתח</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[9px] text-slate-500">אין עדיין מפתחות שמורים.</div>
      )}

      {adding ? (
        <form className="mt-2 space-y-1.5 rounded-[0.6rem] border border-sky-100 bg-white p-2" onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !label.trim() || !apiKey.trim()) return;
          const save = onSave(label.trim(), apiKey.trim());
          setApiKey('');
          void save.then((saved) => { if (saved) closeAddForm(); });
        }}>
          <label className="block text-[8px] text-slate-600">
            שם לזיהוי המפתח
            <input type="text" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} autoComplete="off" disabled={disabled} required className="mt-1 block w-full rounded border border-slate-200 px-2 py-1.5 text-[10px] outline-none focus:border-sky-400" />
          </label>
          <label className="block text-[8px] text-slate-600">
            מפתח OpenAI API
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={disabled} required dir="ltr" className="mt-1 block w-full rounded border border-slate-200 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-sky-400" />
          </label>
          <div className="flex gap-1.5">
            <button type="button" onClick={closeAddForm} disabled={disabled} className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-[8px] text-slate-600">ביטול</button>
            <button type="submit" disabled={disabled || !label.trim() || !apiKey.trim()} className="flex-1 rounded bg-sky-600 px-2 py-1.5 text-[8px] font-semibold text-white disabled:opacity-50">שמור מפתח</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} disabled={disabled} className="mt-2 flex items-center gap-1 text-[9px] font-semibold text-sky-700 disabled:opacity-50"><Plus className="h-3 w-3" />הוסף מפתח</button>
      )}
      <div className="mt-2 flex gap-1.5">
        <button type="button" onClick={() => { closeAddForm(); onClose(); }} disabled={pending} className="flex-1 rounded-[0.55rem] border border-slate-200 bg-white px-2 py-1.5 text-[8px] font-semibold text-slate-600 disabled:opacity-50">חזרה</button>
        <button type="button" onClick={onConnect} disabled={disabled || adding || !selectedId || !credentials.some((credential) => credential.id === selectedId)} className="flex flex-[1.7] items-center justify-center gap-1 rounded-[0.55rem] bg-sky-600 px-2 py-1.5 text-[8px] font-semibold text-white transition hover:bg-sky-700 disabled:opacity-50">
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}התחבר
        </button>
      </div>
    </div>
  );
}
