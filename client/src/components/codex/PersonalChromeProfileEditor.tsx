import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, Save, UserRound, X } from 'lucide-react';
import { normalizeProfileIdentity, type ChromeProfileIdentity } from '../../../../chrome-extension/profileIdentity.js';
import type { PersonalChromeDeviceValue } from './PersonalChromeModeDialog';
import { chromeProfilePicture, ChromeProfileConflictError } from './personalChromeProfile';

interface Props {
  device: PersonalChromeDeviceValue;
  onSave: (deviceId: string, identity: ChromeProfileIdentity, baseRevision: number) => Promise<PersonalChromeDeviceValue>;
  onClose: () => void;
}

export function PersonalChromeProfileEditor({device,onSave,onClose}: Props) {
  const initial = normalizeProfileIdentity(device.profileIdentity || {name:device.name});
  const [draft,setDraft] = useState(initial);
  const [baseRevision,setBaseRevision] = useState(device.profileRevision || 0);
  const [dirty,setDirty] = useState(false);
  const [busy,setBusy] = useState(false);
  const [preparing,setPreparing] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [notice,setNotice] = useState<string|null>(null);
  const saveLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true; return () => {mounted.current=false;}; },[]);
  useEffect(() => {
    if (dirty || busy || preparing) return;
    setDraft(normalizeProfileIdentity(device.profileIdentity || {name:device.name}));
    setBaseRevision(device.profileRevision || 0);
  },[device.profileIdentity,device.name,device.profileRevision,dirty,busy,preparing]);

  function edit(next: ChromeProfileIdentity) { setDraft(next);setDirty(true);setError(null);setNotice(null); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saveLock.current || preparing || !draft.name.trim()) return;
    saveLock.current=true;setBusy(true);setError(null);setNotice(null);
    try {
      const saved = await onSave(device.id,draft,baseRevision);
      if (!mounted.current) return;
      setDraft(normalizeProfileIdentity(saved.profileIdentity));
      setBaseRevision(saved.profileRevision || 0);setDirty(false);
      setNotice(saved.online ? 'הפרטים נשמרו בשרת ונשלחו לתוסף.' : 'הפרטים נשמרו בשרת ויסתנכרנו לתוסף כשיתחבר.');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ChromeProfileConflictError) setBaseRevision(failure.device.profileRevision || 0);
      setError(failure instanceof Error ? failure.message : 'שמירת הפרופיל נכשלה. העריכה נשמרה כאן.');
    } finally { saveLock.current=false;if(mounted.current)setBusy(false); }
  }

  return <form onSubmit={submit} className="mt-2 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4" aria-label={`עריכת פרופיל ${device.name}`}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-800">שם ותמונה של הדפדפן</h3>
      <button type="button" onClick={onClose} disabled={busy || preparing} aria-label="סגור עריכת פרופיל" className="rounded-full p-2 text-slate-500"><X className="h-4 w-4" /></button>
    </div>
    <p className="mt-1 text-xs leading-5 text-slate-500">הפרטים משותפים לכל השיחות. אפשר לערוך ולשמור כאן, בטלפון או בתוסף.</p>
    <label className="mt-3 block text-xs font-medium text-slate-700">שם הדפדפן / הפרופיל
      <input value={draft.name} maxLength={120} disabled={busy} autoComplete="off" onChange={e=>edit({...draft,name:e.target.value,source:'custom'})} className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-300" />
    </label>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white text-slate-400">
        {draft.avatarDataUrl ? <img src={draft.avatarDataUrl} alt="תצוגה מקדימה של תמונת הפרופיל" className="h-full w-full object-cover" /> : <UserRound className="h-5 w-5" />}
      </span>
      <label className="min-w-0 flex-1 text-xs font-medium text-slate-700">תמונת פרופיל
        <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || preparing} className="mt-1 block max-w-full text-xs text-slate-600" onChange={async e=>{
          const file=e.target.files?.[0];e.target.value='';if(!file)return;
          setPreparing(true);setError(null);
          try { const avatarDataUrl=await chromeProfilePicture(file);if(mounted.current){setDraft(current=>({...current,avatarDataUrl,source:'custom'}));setDirty(true);setNotice(null);} }
          catch(failure){if(mounted.current)setError(failure instanceof Error ? failure.message : 'טעינת התמונה נכשלה.');}
          finally{if(mounted.current)setPreparing(false);}
        }} />
      </label>
      {draft.avatarDataUrl && <button type="button" disabled={busy || preparing} onClick={()=>edit({...draft,avatarDataUrl:null,source:'custom'})} className="text-xs text-slate-500 underline">הסר תמונה</button>}
    </div>
    {error && <p role="alert" className="mt-3 text-xs leading-5 text-rose-700">{error}</p>}
    {notice && <p role="status" className="mt-3 text-xs leading-5 text-emerald-700">{notice}</p>}
    <button type="submit" disabled={busy || preparing || !draft.name.trim()} className="mt-3 flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-slate-800 ring-1 ring-slate-200 disabled:opacity-50">
      {busy || preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{busy ? 'שומר פרופיל…' : preparing ? 'מכין תמונה…' : 'שמור פרטי פרופיל'}
    </button>
  </form>;
}
