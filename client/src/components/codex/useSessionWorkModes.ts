import {useCallback,useEffect,useRef,useState} from 'react';
import {createScopedPreferenceRequests} from './scopedPreferenceRequests';
import {emptyWorkModePreferences,type WorkModePreferences} from './workModePreferences';
import {saveWorkModePreferences,type WorkModeRequest as Request} from './workModeTransport';
export function useSessionWorkModes(serverId:string,profileId:string,sessionKey:string,enabled:boolean,request:Request){
 const scope=JSON.stringify([serverId,profileId,sessionKey,enabled]);
 const guard=useRef(createScopedPreferenceRequests()).current;guard.setScope(scope);
 const [snapshot,setSnapshot]=useState({scope:'',mode:emptyWorkModePreferences(),loaded:false,loading:false,saving:false,error:null as string|null});
 const load=useCallback(async()=>{
  if(!enabled||!profileId||!sessionKey)return;const ticket=guard.beginRead(scope);if(!ticket)return;
  setSnapshot(s=>s.scope===scope?{...s,loading:true}:{scope,mode:emptyWorkModePreferences(),loaded:false,loading:true,saving:false,error:null});
  try{const data=await request<{focusMode:WorkModePreferences}>(serverId,`/api/codex/session-focus-mode?profileId=${encodeURIComponent(profileId)}&sessionKey=${encodeURIComponent(sessionKey)}`);
   if(guard.current(ticket))setSnapshot({scope,mode:data.focusMode,loaded:true,loading:false,saving:false,error:null});
  }catch(e:any){if(guard.current(ticket))setSnapshot(s=>({...s,scope,loading:false,error:e.message||'לא ניתן לטעון את המצבים מהשרת הנבחר'}));}
 },[scope,enabled,profileId,sessionKey,serverId,request,guard]);
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),15_000);return()=>clearInterval(timer);},[load]);
 const save=useCallback(async(patch:Partial<WorkModePreferences>)=>{
  if(!enabled||!profileId||!sessionKey)return false;
  const ticket=guard.beginWrite(scope);if(!ticket)return false;setSnapshot(s=>({...s,saving:true,error:null}));
  try{const mode=await saveWorkModePreferences(request,serverId,profileId,sessionKey,patch,()=>guard.current(ticket));
   if(!mode||!guard.current(ticket))return false;setSnapshot({scope,mode,loaded:true,loading:false,saving:false,error:null});return true;
  }catch(e:any){if(guard.current(ticket))setSnapshot(s=>({...s,saving:false,error:e.message||'שמירת המצב נכשלה'}));return false;}finally{guard.finishWrite(ticket);}
 },[scope,enabled,profileId,sessionKey,serverId,request,guard]);
 const current=snapshot.scope===scope?snapshot:{scope,mode:emptyWorkModePreferences(),loaded:false,loading:enabled,saving:false,error:null};
 return{...current,reload:load,save};
}
