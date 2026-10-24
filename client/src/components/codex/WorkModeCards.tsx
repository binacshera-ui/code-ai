import {Brain,CalendarClock,Scale} from 'lucide-react';
import {workModeLabels,type WorkModeKind,type WorkModePreferences} from './workModePreferences';
export function WorkModeBadges({mode,onOpen}:{mode:WorkModePreferences;onOpen:(kind:WorkModeKind)=>void}){
 return <>{(['rational','decision','focus'] as const).filter(kind=>kind==='rational'?mode.rationalEnabled:kind==='decision'?mode.decisionEnabled:mode.enabled).map(kind=><button type="button" key={kind} onClick={()=>onOpen(kind)} className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100"><span aria-hidden="true">●</span><span>{workModeLabels[kind]} · פעיל{kind==='rational'?' · תזמון בידי ה־AI':''}</span></button>)}</>;
}
export function WorkModeCards({mode,available,loaded,error,onOpen,onRetry}:{mode:WorkModePreferences;available:boolean;loaded:boolean;error:string|null;onOpen:(kind:WorkModeKind)=>void;onRetry:()=>void}){
 const rows=[{kind:'rational' as const,active:mode.rationalEnabled,Icon:CalendarClock,description:'תוכנית משימות עם אומדני זמן, סימון וי עם ראיות ועצירה בחריגה.',detail:'ה־AI קובע מראש זמן לתכנון ואומדן נפרד לכל משימה'},
  {kind:'decision' as const,active:mode.decisionEnabled,Icon:Scale,description:'שומר תקלה להכרעתך, ממשיך עבודה אחרת ומחזיר את ההכרעה לאותה שיחה.',detail:'מקרים פתוחים והכרעות מוצגים בשיחה ובמרכז ההכרעה'},
  {kind:'focus' as const,active:mode.enabled,Icon:Brain,description:'מזהה סרבול, מציף דרך עבודה שלא עובדת ומציע פישוט.',detail:mode.goal||'שיקול דעת הנדסי ומניעת לולאות תיאום'}];
 return <>{rows.map(({kind,active,Icon,description,detail})=><button type="button" key={kind} data-work-mode={kind} aria-label={workModeLabels[kind]} aria-pressed={available&&loaded&&active} disabled={!available||!loaded} onClick={()=>onOpen(kind)}
  className={`flex w-full items-start justify-between gap-3 rounded-[1.25rem] border px-4 py-4 text-right transition disabled:opacity-60 ${active&&available&&loaded?'border-indigo-200 bg-indigo-50/80':'border-slate-100 bg-slate-50/80 hover:border-indigo-200 hover:bg-indigo-50/50'}`}>
  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">{workModeLabels[kind]}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${active&&loaded?'bg-indigo-600 text-white':'bg-white text-slate-500'}`}>{!available?'Codex בלבד':!loaded?(error?'לא זמין':'טוען…'):active?'פעיל':'כבוי'}</span></div><p className="mt-1 text-xs leading-6 text-slate-500">{description}</p><p className="mt-2 text-[11px] leading-5 text-slate-400">{detail}</p></div>
  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${active?'bg-indigo-100 text-indigo-700':'bg-white text-indigo-500'}`}><Icon className="h-4 w-4"/></span></button>)}
  {available&&error&&<div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">לא ניתן לטעון את מצבי העבודה מהשרת הנבחר. לא שונו הגדרות.<button type="button" onClick={onRetry} className="mr-2 underline">נסה שוב</button></div>}
 </>;
}
