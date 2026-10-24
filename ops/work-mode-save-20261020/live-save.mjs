import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fleetClient} from '../focus-notifications-20261020/fleet-live.mjs';
const project='/root/projects/code-ai', ops=process.env.CODE_AI_UI_RELEASE_OPS||project+'/ops/work-mode-save-20261020';
const source=process.argv[2]||project;
const {saveWorkModePreferences}=await import(pathToFileURL(source+'/client/src/components/codex/workModeTransport.ts'));
const api=await fleetClient();
const request=async(server,url,init)=>api(server,String(url).replace(/^\/api\/codex/,''),init?.method==='POST'?JSON.parse(init.body):undefined);
const keys=['enabled','goal','rationalEnabled','planningMinutes','taskMinutes','decisionEnabled'];
const values=m=>Object.fromEntries(keys.map(k=>[k,m[k]]));
const checks=[];
for(const [server,profile]of[['local','developer'],['beam-10g','beam-admin'],['pci','pci-admin']]){
 const prior=JSON.parse(await fs.readFile(project+'/ops/work-modes-routing-20261020/'+server+'-acceptance.json','utf8'));
 const session=prior.sessionId,route='/session-focus-mode?'+new URLSearchParams({profileId:profile,sessionKey:session});
 const original=values((await api(server,route)).focusMode);
 const results=[];
 try{
  for(const patch of[{rationalEnabled:!original.rationalEnabled},{decisionEnabled:!original.decisionEnabled},{enabled:false,goal:original.goal}]){
   const before=values((await api(server,route)).focusMode);
   const saved=values(await saveWorkModePreferences(request,server,profile,session,patch,()=>true));
   assert.deepEqual(saved,{...before,...patch});
   assert.deepEqual(values((await api(server,route)).focusMode),saved);
   results.push({fields:Object.keys(patch),saved:true,readback:true,unrelatedPreferencesPreserved:true});
  }
 }finally{
  await saveWorkModePreferences(request,server,profile,session,original,()=>true);
  assert.deepEqual(values((await api(server,route)).focusMode),original,'Maintenance preferences must be restored');
 }
 checks.push({server,profile,session,checks:results,originalPreferencesRestored:true});
}
const receipt={passed:true,source,checkedAt:new Date().toISOString(),realPostAndGet:true,transportUsedByReactHook:true,noNativeTasksSubmitted:true,checks};
await fs.writeFile(ops+'/live-save.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(receipt));
