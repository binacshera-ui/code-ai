import {useEffect,useRef,useState,type ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {ListChecks,X} from 'lucide-react';
import type {CodexRationalRun} from '../../../../shared/codexWorkModes';
import {incidentCenterLink,type WorkModePreferences} from './workModePreferences';
export interface WorkModeCase {caseId:string;title:string;summary:string;status:string;updatedAt:string;investigatorProfileId:string|null;investigatorSessionId:string|null;}
export function casesForConversation(cases:WorkModeCase[],profileId:string,sessionKey:string){return cases.filter(c=>c.investigatorProfileId===profileId&&c.investigatorSessionId===sessionKey).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));}
export function visibleRationalRun(runs:CodexRationalRun[]){const sorted=[...runs].filter(r=>r.enabled).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt));return sorted.find(r=>!r.holdReleasedAt&&['expired','incomplete'].includes(r.status))||sorted[0];}
export function caseStatusLabel(status:string){return({waiting_operator:'ממתין להכרעתך',waiting_investigator:'ממתין לחקירה',needs_more_evidence:'נדרשות ראיות',approved_for_execution:'אושר לביצוע',execution_in_progress:'בביצוע',verification_in_progress:'באימות',execution_failed:'הביצוע נכשל',needs_additional_decision:'נדרשת הכרעה נוספת',waiting_completion_confirmation:'ממתין לאישור השלמה',rejected:'נדחה',reopened:'נפתח מחדש',completed:'הושלם',open:'פתוח'} as Record<string,string>)[status]||status;}
export function workModeLauncherSummary(run?:CodexRationalRun){
 if(!run)return 'מוכן להודעה הבאה';
 if(run.finishedAt&&run.outcome==='cancelled'&&run.status==='incomplete')return run.holdReleasedAt?'נעצרה · אפשר להמשיך':'ההרצה נעצרה · התוכנית נשמרה';
 if(!run.holdReleasedAt&&['expired','incomplete'].includes(run.status))return 'נעצרה · נדרשת החלטתך';
 if(run.holdReleasedAt)return 'העצירה שוחררה';
 if(run.status==='planning')return 'ה־AI מתכנן';
 const done=run.tasks.filter(t=>t.status==='completed').length;
 return run.tasks.length?`${done}/${run.tasks.length} הושלמו`:'ממתין לתוכנית';
}
export function WorkModeLauncher({mode,run,cases,error,open,onOpenChange,children}:{
 mode:WorkModePreferences;run?:CodexRationalRun;cases:WorkModeCase[];error:string|null;open:boolean;
 onOpenChange:(open:boolean)=>void;children:ReactNode;
}){
 if(!run&&!mode.rationalEnabled&&!mode.decisionEnabled&&!cases.length&&!error)return null;
 const hasPlan=!!run||mode.rationalEnabled,title=hasPlan?'תוכנית משימות':'מקרים להכרעה';
 const pending=cases.filter(c=>!['completed','rejected'].includes(c.status)).length;
 const held=!!run&&!run.holdReleasedAt&&['expired','incomplete'].includes(run.status);
 return <div className="mb-3 flex flex-wrap items-center gap-2" dir="rtl" data-testid="work-mode-dock">
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
   <Dialog.Trigger asChild><button type="button" data-testid="work-mode-launcher" className={`inline-flex max-w-full items-center gap-2 rounded-full border px-4 py-2 text-xs font-medium transition ${held?'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100':'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}>
    <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true"/><span>{title}</span>
    {hasPlan&&<span className="text-[11px] opacity-80">{workModeLauncherSummary(run)}</span>}
    {pending>0&&<span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px]">{pending} להכרעה</span>}
    {error&&<span className="text-[10px]">עדכון הסטטוס נכשל</span>}
   </button></Dialog.Trigger>
   <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[120] bg-slate-950/25 backdrop-blur-sm"/>
    <Dialog.Content data-testid="work-mode-panel" dir="rtl" className="fixed left-1/2 top-1/2 z-[121] flex max-h-[88dvh] w-[calc(100vw-1.5rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-[1.75rem] border border-slate-200 bg-white shadow-2xl outline-none">
     <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
      <div><Dialog.Title className="text-base font-semibold text-slate-800">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-slate-500">התוכנית, הזמנים וההכרעות של השיחה הזאת · מתעדכן מהשרת</Dialog.Description></div>
      <Dialog.Close asChild><button type="button" aria-label="סגור תוכנית משימות" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"><X className="h-5 w-5" aria-hidden="true"/></button></Dialog.Close>
     </div>
     <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-2 sm:px-5">{children}</div>
    </Dialog.Content>
   </Dialog.Portal>
  </Dialog.Root>
 </div>;
}
export function WorkModeStatusView({mode,run,cases,serverId,now,saving,error,onRelease}:{mode:WorkModePreferences;run?:CodexRationalRun;cases:WorkModeCase[];serverId:string;now:number;saving:boolean;error:string|null;onRelease:()=>void}){
 const held=!!run&&!run.holdReleasedAt&&['expired','incomplete'].includes(run.status);
 const cancelled=!!run?.finishedAt&&run.outcome==='cancelled'&&run.status==='incomplete';
 const done=run?.tasks.filter(t=>t.status==='completed').length||0;
 const remaining=run?.deadlineAt&&!run.finishedAt?Math.max(0,Math.ceil((Date.parse(run.deadlineAt)-now)/1000)):null;
 const pending=cases.filter(c=>!['completed','rejected'].includes(c.status)).length;
 if(!run&&!mode.rationalEnabled&&!mode.decisionEnabled&&!cases.length)return null;
 return <div className="my-3 space-y-3" dir="rtl" aria-label="מצבי עבודה בשיחה">
  {(run||mode.rationalEnabled)&&<section aria-label="תוכנית מצב הגיוני" className={`rounded-2xl border p-4 text-sm ${held?'border-amber-300 bg-amber-50':'border-indigo-200 bg-indigo-50/50'}`}>
   <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">מצב הגיוני · {cancelled?'ההרצה נעצרה':held?'נעצרה — נדרשת החלטתך':run?.status==='completed'?'המשימות הושלמו':run?.holdReleasedAt?'העצירה שוחררה':run?'תוכנית קצובה':'מוכן להודעה הבאה'}</h3>
    {remaining!==null&&<span role="timer" className="tabular-nums">{remaining>0?`נותרו ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`:'המועד עבר · ממתין לאימות השרת'}</span>}</div>
   {!run&&<p className="mt-2 text-xs leading-6 text-slate-600">בשליחה הבאה ה־AI יקבע זמן לתכנון, ואחריו ישמור תוכנית עם אומדן נפרד לכל משימה. לא נדרשת בחירת זמנים מצידך.</p>}
   {run?.status==='planning'&&<p className="mt-2 text-slate-600">{run.timingSource==='model'&&run.planningMinutes==null?'ממתין להצהרת זמן התכנון בידי ה־AI. הספירה הנוכחית היא מועד ההצהרה, לא זמן התכנון.':'ממתין לתוכנית משימות עם אומדני זמן.'}</p>}
   {run?.timingSource==='model'&&run.planningMinutes!=null&&<p className="mt-2 text-xs leading-6 text-slate-600">אומדן ה־AI לתכנון: {run.planningMinutes} דקות. זמני המשימות נקבעו בידי ה־AI לפי התוכנית.</p>}
   {!!run?.tasks.length&&<><div className="mt-3 flex items-center justify-between text-xs"><span>{done} מתוך {run.tasks.length} הושלמו</span>{run.deadlineAt&&!run.finishedAt&&<span>מועד היעד: {new Date(run.deadlineAt).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}</span>}</div><div role="progressbar" aria-label="השלמת משימות" aria-valuemin={0} aria-valuemax={run.tasks.length} aria-valuenow={done} className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-100"><div className="h-full bg-indigo-600 transition-all" style={{width:`${done/run.tasks.length*100}%`}}/></div></>}
   <ol className="mt-3 space-y-2">{run?.tasks.map(task=><li key={task.id} className={`flex items-start gap-2 rounded-xl p-2 ${task.id===run.currentTaskId?'bg-white/80 ring-1 ring-indigo-200':''}`}><span aria-label={task.status==='completed'?'הושלמה':'טרם הושלמה'} className={task.status==='completed'?'text-emerald-700':'text-slate-500'}>{task.status==='completed'?'✓':'□'}</span><div className="min-w-0"><span>{task.title} · {task.estimatedMinutes} דקות</span>{task.evidence&&<p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6 text-slate-600">{task.evidence}</p>}</div></li>)}</ol>
   {cancelled&&<p className="mt-3 text-xs leading-6">הביטול אושר. התוכנית והסימונים נשמרו, ומשימות שלא בוצעו לא מסומנות כהושלמו.</p>}
   {held&&<><p className="mt-3 text-xs leading-6">{run?.status==='expired'?'הזמן שהוקצב עבר ללא השלמה. בקשת העצירה נשלחה להרצה המקורית בלבד.':cancelled?'ההרצה בוטלה; התוכנית אינה הרצה פעילה.':'ההרצה הסתיימה בלי תוכנית מסומנת במלואה.'} המשכים בשיחה מושהים עד החלטתך. שליחת הודעה חדשה, המשך או ניסיון חוזר תשחרר את ההשהיה לאחר אישור העצירה; אין צורך למחוק את התוכנית. שיחות אחרות ממשיכות כרגיל.</p><button type="button" onClick={onRelease} disabled={saving} className="mt-3 rounded-full bg-slate-900 px-4 py-2 text-white disabled:opacity-50">{saving?'משחרר…':'שחרר את העצירה ואפשר המשך'}</button></>}
  </section>}
  {(mode.decisionEnabled||cases.length>0)&&<section aria-label="מקרים במצב הכרעה" className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">מצב הכרעה · {pending?`${pending} מקרים פתוחים`:'אין מקרים פתוחים'}</h3><a href={incidentCenterLink(serverId)} target="_blank" rel="noreferrer" className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-violet-700 underline">פתח מרכז הכרעה</a></div>
   {!cases.length&&<p className="mt-2 text-xs leading-6 text-slate-600">מקרים שיישמרו להכרעתך יופיעו כאן. ההכרעה מחזירה את הטיפול לשיחה הזאת.</p>}
   <ul className="mt-3 space-y-2">{cases.map(c=><li key={c.caseId} className="rounded-xl border border-violet-100 bg-white p-3"><div className="flex flex-wrap items-start justify-between gap-2"><h4 className="min-w-0 break-words font-medium">{c.title}</h4><span className={`rounded-full px-2 py-1 text-[11px] ${['waiting_operator','needs_additional_decision'].includes(c.status)?'bg-amber-100 text-amber-900':'bg-slate-100 text-slate-600'}`}>{caseStatusLabel(c.status)}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-slate-600">{c.summary}</p><p className="mt-2 break-all text-[10px] text-slate-400" dir="ltr">{c.caseId}</p></li>)}</ul>
  </section>}
  {error&&<p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{error}</p>}
 </div>;
}
export function WorkModeStatus({profileId,sessionKey,serverId,mode,request}:{profileId:string;sessionKey:string|null;serverId:string;mode:WorkModePreferences;request:<T>(serverId:string,input:RequestInfo,init?:RequestInit)=>Promise<T>}){
 const scope=JSON.stringify([profileId,sessionKey,serverId]),latest=useRef(scope);latest.current=scope;
 const [snapshot,setSnapshot]=useState({scope:'',runs:[] as CodexRationalRun[],cases:[] as WorkModeCase[],error:null as string|null});
 const [saving,setSaving]=useState(false),[now,setNow]=useState(Date.now);
 const [openedScope,setOpenedScope]=useState('');
 useEffect(()=>setOpenedScope(''),[scope]);
 useEffect(()=>{let active=true,busy=false;setSaving(false);
  async function load(){if(!sessionKey||busy)return;busy=true;
   try{const [runs,cases]=await Promise.allSettled([request<{runs:CodexRationalRun[]}>(serverId,`/api/codex/work-mode-runs?profileId=${encodeURIComponent(profileId)}&sessionKey=${encodeURIComponent(sessionKey)}`),request<{cases:WorkModeCase[]}>(serverId,'/api/codex/incident-cases')]);
    if(active&&latest.current===scope)setSnapshot(old=>({scope,runs:runs.status==='fulfilled'?runs.value.runs:old.scope===scope?old.runs:[],cases:cases.status==='fulfilled'?casesForConversation(cases.value.cases,profileId,sessionKey):old.scope===scope?old.cases:[],error:runs.status==='rejected'||cases.status==='rejected'?'עדכון הסטטוס מהשרת נכשל; מוצג המידע האחרון שנקרא.':null}));
   }finally{busy=false;}}
  void load();const timer=setInterval(()=>void load(),5_000);return()=>{active=false;clearInterval(timer);};
 },[scope,profileId,sessionKey,serverId,request]);
 const view=snapshot.scope===scope?snapshot:{scope,runs:[],cases:[],error:null};const run=visibleRationalRun(view.runs);
 useEffect(()=>{if(!run?.deadlineAt||run.finishedAt)return;const timer=setInterval(()=>setNow(Date.now()),1_000);return()=>clearInterval(timer);},[run?.runId,run?.deadlineAt,run?.finishedAt]);
 async function release(){if(!run||saving)return;setSaving(true);try{const data=await request<{run:CodexRationalRun}>(serverId,`/api/codex/work-mode-runs/${encodeURIComponent(run.runId)}/release`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profileId,sessionKey})});if(latest.current===scope)setSnapshot(s=>({...s,runs:s.runs.map(r=>r.runId===data.run.runId?data.run:r),error:null}));}catch(e:any){if(latest.current===scope)setSnapshot(s=>({...s,error:e.message}));}finally{if(latest.current===scope)setSaving(false);}}
 return <WorkModeLauncher mode={mode} run={run} cases={view.cases} error={view.error} open={openedScope===scope} onOpenChange={open=>setOpenedScope(open?scope:'')}>
  <WorkModeStatusView mode={mode} run={run} cases={view.cases} serverId={serverId} now={now} saving={saving} error={view.error} onRelease={()=>void release()}/>
 </WorkModeLauncher>;
}
