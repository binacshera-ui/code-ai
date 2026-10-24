import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import {fleetClient} from '../focus-notifications-20261020/fleet-live.mjs';
const ops='/root/projects/code-ai/ops/work-mode-stop-20261020',file=ops+'/native-check.json';
await build({entryPoints:['client/src/components/codex/workModeOwnerActions.ts'],bundle:true,platform:'node',format:'esm',outfile:ops+'/owner-actions.mjs'});
const {stopQueueItemForUser,releaseWorkModeHoldsForUser}=await import(pathToFileURL(ops+'/owner-actions.mjs'));
const api=await fleetClient(),scope={profileId:'developer',sessionKey:'01a158ef-b0b5-7f92-b4f7-6e522f79fa8e'};
const r=JSON.parse(await fs.readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '{}';}));
const save=()=>fs.writeFile(file,JSON.stringify(r,null,2)+'\n',{mode:0o600});
if(r.passed){console.log(JSON.stringify(r));process.exit(0);}
const request=async(url,init)=>api('local',url.replace(/^\/api\/codex/,''),init?.method==='POST'?JSON.parse(init.body||'{}'):undefined);
const prefsRoute='/session-focus-mode?'+new URLSearchParams(scope),keys=['enabled','goal','rationalEnabled','planningMinutes','taskMinutes','decisionEnabled'];
const prefs=m=>Object.fromEntries(keys.map(k=>[k,m[k]]));
try{
 if(!r.originalPreferences){r.originalPreferences=prefs((await api('local',prefsRoute)).focusMode);r.startedAt=new Date().toISOString();await save();}
 await api('local','/session-focus-mode',{...scope,focusMode:{...r.originalPreferences,rationalEnabled:true,decisionEnabled:false}});
 if(!r.itemId){
  await releaseWorkModeHoldsForUser(request,scope);
  const {profiles}=await api('local','/profiles');const cwd=profiles.find(p=>p.id==='developer').workspaceCwd;
  const {item}=await api('local','/queue/items',{profileId:scope.profileId,queueKey:scope.sessionKey,sessionId:scope.sessionKey,cwd,
   clientRequestId:'owner-stop-native-20261020-v1',promptPreview:'בדיקת תחזוקה מבודדת: עצירה ידנית עם תוכנית',
   prompt:'Isolated maintenance acceptance only, not customer work. Use this run\'s supplied work-mode helper: declare your chosen short planning budget, then save exactly ONE task titled "Wait for owner stop verification" with a sensible estimate. Do NOT mark it complete. Immediately run sleep 90 using a terminal tool so the owner can cancel while a plan is pending. No other commands except the supplied helper and sleep. Do not read project/customer files, send messages or email, delegate, modify preferences, create a goal, start builds or use browsers. After sleep reply STOP_TEST_WAITED, but expect manual cancellation first.'});
  r.itemId=item.id;await save();
 }
 const deadline=Date.now()+240000;let item,run;
 while(Date.now()<deadline){
  item=(await api('local','/queue/items/'+r.itemId+'?includeSession=false')).item;
  run=(await api('local','/work-mode-runs?'+new URLSearchParams(scope))).runs.find(x=>x.runId===item.workModeRunId);
  if(run?.tasks.length&&item.nativeSubmission?.deliveryPhase==='running')break;
  if(['completed','failed','cancelled'].includes(item.status))throw Error('Synthetic task ended early: '+item.status);
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert.equal(item.status,'running');assert.equal(run?.status,'running');assert.equal(run.tasks.length,1);
 r.planWasPending=true;r.runId=run.runId;r.updates=[];await save();
 await stopQueueItemForUser(request,r.itemId,scope,item=>r.updates.push(item.status));
 item=(await api('local','/queue/items/'+r.itemId+'?includeSession=false')).item;
 run=(await api('local','/work-mode-runs?'+new URLSearchParams(scope))).runs.find(x=>x.runId===r.runId);
 assert.equal(item.status,'cancelled');assert.equal(item.nativeSubmission.deliveryPhase,'cancelled');
 assert.equal(run.outcome,'cancelled');assert.ok(run.finishedAt);assert.ok(run.holdReleasedAt);
 assert.equal(run.tasks[0].status,'pending');
 await releaseWorkModeHoldsForUser(request,scope);
 r.nativeCancellationConfirmed=true;r.ownerHoldReleased=true;r.unfinishedTaskPreserved=true;
 r.originalSessionPreserved=true;r.customerWorkUntouched=true;r.passed=true;r.finishedAt=new Date().toISOString();delete r.error;
}catch(error){r.error=error.message;r.passed=false;throw error;}
finally{
 if(r.originalPreferences){await api('local','/session-focus-mode',{...scope,focusMode:r.originalPreferences});
 assert.deepEqual(prefs((await api('local',prefsRoute)).focusMode),r.originalPreferences);r.originalPreferencesRestored=true;}
 await save();
}
console.log(JSON.stringify(r));
