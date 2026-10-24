export interface WorkModePreferences {
  enabled:boolean;goal:string;rationalEnabled:boolean;decisionEnabled:boolean;
}
export type WorkModeKind='focus'|'rational'|'decision';
export const emptyWorkModePreferences=():WorkModePreferences=>({enabled:false,goal:'',rationalEnabled:false,decisionEnabled:false});
export const workModeLabels:Record<WorkModeKind,string>={focus:'מיקוד הנדסי',rational:'מצב הגיוני',decision:'מצב הכרעה'};
export function activeWorkModeLabels(mode:WorkModePreferences):string[]{return[mode.enabled&&workModeLabels.focus,mode.rationalEnabled&&workModeLabels.rational,mode.decisionEnabled&&workModeLabels.decision].filter(Boolean) as string[];}
export function workModePatch(kind:WorkModeKind,mode:WorkModePreferences):Partial<WorkModePreferences>{
 if(kind==='decision')return{decisionEnabled:mode.decisionEnabled};if(kind==='focus')return{enabled:mode.enabled,goal:mode.goal};
 return{rationalEnabled:mode.rationalEnabled};
}
export function incidentCenterLink(serverId:string):string{return'/api/codex/incident-center?'+new URLSearchParams({server:serverId});}
