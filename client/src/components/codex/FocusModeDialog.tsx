import {useEffect,useRef,useState} from 'react';
import {workModeLabels,workModePatch,incidentCenterLink,type WorkModeKind,type WorkModePreferences} from './workModePreferences';
export function FocusModeDialog({open,kind,scope,serverId,value,loaded,saving,error,onClose,onSave}:{
 open:boolean;kind:WorkModeKind;scope:string;serverId:string;value:WorkModePreferences;loaded:boolean;saving:boolean;error:string|null;
 onClose:()=>void;onSave:(patch:Partial<WorkModePreferences>)=>Promise<boolean>;
}){
 const [draft,setDraft]=useState(value);const current=useRef('');const identity=JSON.stringify([open,kind,scope]);current.current=identity;
 useEffect(()=>{if(open&&loaded)setDraft(value);},[open,kind,scope,loaded]);useEffect(()=>()=>{current.current='';},[]);
 if(!open)return null;
 const field=kind==='rational'?'rationalEnabled':kind==='decision'?'decisionEnabled':'enabled';
 async function save(){const expected=identity;if(await onSave(workModePatch(kind,draft))&&current.current===expected)onClose();}
 return <div className="fixed inset-0 z-[78] flex items-end justify-center bg-slate-950/20 p-4 backdrop-blur-sm sm:items-center" dir="rtl">
  <button className="absolute inset-0" aria-label={`סגור ${workModeLabels[kind]}`} onClick={onClose}/>
  <section role="dialog" aria-modal="true" aria-labelledby="work-mode-title" className="relative max-h-[88dvh] w-full max-w-xl overflow-y-auto rounded-[2rem] border border-slate-100 bg-white p-6 shadow-xl">
   <h2 id="work-mode-title" className="text-lg font-semibold">{workModeLabels[kind]}</h2><p className="mt-2 text-xs leading-6 text-slate-500">נשמר בשיחה הזאת בשרת הנבחר. חל מההודעה הבאה; לא משנה הרשאות או הרצה שכבר פעילה.</p>
   <div className="my-5 flex items-center justify-between gap-4 rounded-2xl bg-slate-50 p-4"><span className="font-medium">{draft[field]?'המצב פעיל':'המצב כבוי'}</span><button type="button" role="switch" aria-label={`הפעל ${workModeLabels[kind]}`} aria-checked={draft[field]} disabled={!loaded||saving} onClick={()=>setDraft({...draft,[field]:!draft[field]})} dir="ltr" className={`relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition disabled:opacity-50 ${draft[field]?'bg-indigo-600':'bg-slate-200'}`}><span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${draft[field]?'translate-x-5':'translate-x-0'}`}/></button></div>
   {kind==='rational'&&<><p className="text-sm leading-7 text-slate-600">ה־AI קובע מראש את הזמן לתכנון ואת אומדן הזמן לכל משימה, ושומר תוכנית מדידה לפני הביצוע. אין צורך להזין זמנים. כל השלמה דורשת וי וראיה. חריגה מהזמן שה־AI קבע עוצרת את ההרצה ומקפיאה המשכים בשיחה עד החלטתך; שיחות אחרות ממשיכות כרגיל.</p><p className="mt-3 text-xs leading-6 text-slate-500">האומדנים, התוכנית, הספירה לאחור והראיות מוצגים בשיחה. ה־AI אינו רשאי להאריך לעצמו את הזמן אחרי שמירת התקציב. ההתראה בהתאם להגדרת ההתראות שלה.</p></>}
   {kind==='decision'&&<><p className="text-sm leading-7 text-slate-600">כשזוהתה תקלה וחסרה החלטה על התיקון, נשמר מקרה להכרעתך. אפשר להמשיך בעבודה שאינה תלויה בו. תשובתך במרכז ההכרעה מחזירה את אותו מקרה לאותה שיחה להמשך טיפול ואימות — ללא פתיחת שיחה אחרת.</p><a href={incidentCenterLink(serverId)} target="_blank" rel="noreferrer" className="mt-4 inline-flex rounded-xl bg-indigo-50 px-4 py-3 text-sm font-medium text-indigo-700">פתח מרכז הכרעה</a><p className="mt-3 text-xs leading-6 text-slate-500">המקרים והסטטוס שלהם יוצגו גם בשיחה. טיקט אינו נסגר רק בעקבות תשובת המודל.</p></>}
   {kind==='focus'&&<><p className="text-sm leading-7 text-slate-600">לבחון את דרך העבודה, לזהות תכנון מסורבל ולהציע מה להסיר או לאחד. המצב אינו מבטל הרשאות, בטיחות או שערי פריסה מחייבים, ואינו מבטיח זיהוי של כל לולאת חשיבה.</p><label className="mt-4 block text-sm">התוצאה המבוקשת (רשות)<textarea value={draft.goal} maxLength={2000} disabled={!loaded||saving} onChange={e=>setDraft({...draft,goal:e.target.value})} className="mt-2 min-h-24 w-full rounded-xl border p-3"/></label></>}
   {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
   <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="rounded-full border px-4 py-2">בטל</button><button type="button" onClick={()=>void save()} disabled={!loaded||saving} className="rounded-full bg-slate-900 px-5 py-2 text-white disabled:opacity-50">{!loaded?'טוען…':saving?'שומר…':'שמור'}</button></div>
  </section>
 </div>;
}
