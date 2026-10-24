import fs from 'node:fs/promises';import assert from 'node:assert/strict';
import {fleetClient}from'../focus-notifications-20261020/fleet-live.mjs';
const ops='/root/projects/code-ai/ops/ai-work-mode-timing-20261020',id=process.argv[2];
assert.ok(['local','beam-10g','pci'].includes(id));
const c=JSON.parse(await fs.readFile(ops+'/capture.json','utf8'));
const b=JSON.parse(await fs.readFile(ops+'/manual-build.json','utf8'));
const file=ops+'/'+id+'-native-acceptance.json';
const report=JSON.parse(await fs.readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return JSON.stringify({id,buildId:b.buildId,startedAt:new Date().toISOString()});}));
assert.equal(report.buildId,b.buildId);
const save=()=>fs.writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
if(report.passed){console.log(JSON.stringify(report));process.exit(0);}
const api=await fleetClient(),profile=id==='local'?'developer':id==='pci'?'pci-admin':'beam-admin';
const prior=JSON.parse(await fs.readFile('/root/projects/code-ai/ops/work-modes-routing-20261020/'+id+'-acceptance.json','utf8'));
const session=prior.sessionId,route='/session-focus-mode?'+new URLSearchParams({profileId:profile,sessionKey:session});
const keys=['enabled','goal','rationalEnabled','planningMinutes','taskMinutes','decisionEnabled'];
const prefs=m=>Object.fromEntries(keys.map(k=>[k,m[k]]));
const nonce='CODE_AI_MODEL_TIMING_OK';
try{
 const health=await api(id,'/remote-agent/health');assert.equal(health.version,c.activationBackendBaseline.split('/').at(-1));assert.equal(health.ready,true);
 if(!report.originalPreferences){report.originalPreferences=prefs((await api(id,route)).focusMode);await save();}
 if(!report.itemId){
  await api(id,'/session-focus-mode',{profileId:profile,sessionKey:session,focusMode:{...report.originalPreferences,rationalEnabled:true,decisionEnabled:false}});
  const{profiles}=await api(id,'/profiles');const cwd=profiles.find(p=>p.id===profile)?.workspaceCwd;assert.ok(cwd);
  const item=(await api(id,'/queue/items',{profileId:profile,queueKey:session,sessionId:session,cwd,
   clientRequestId:'model-timing-'+b.buildId+'-'+id,promptPreview:'בדיקת תחזוקה: ה־AI קובע זמני תכנון ומשימות',
   prompt:'Isolated Code AI timing acceptance in this maintenance conversation, no customer work. Use the supplied work-mode capability. The AI must choose its OWN sensible planning duration and declare it using budget BEFORE investigation, then choose its OWN estimate for exactly one measurable task and save its plan. Do not ask the user for any time values; old timing values in this conversation are not requirements for this test. Run exactly one arithmetic verification command: python3 -c \'assert 7*9 == 63; print("'+nonce+'")\'. Mark that task complete using the supplied helper with actual stdout and exit-code evidence. Reply exactly '+nonce+'. Do not read project/customer/auth files, send messages/email, park any case, delegate, create a goal, modify other settings or perform other work.'})).item;
  report.itemId=item.id;report.sessionId=session;await save();console.log(JSON.stringify({id,phase:'submitted',itemId:item.id}));
 }
 const deadline=Date.now()+420000;let item;
 do{item=(await api(id,'/queue/items/'+report.itemId+'?includeSession=false')).item;
  if(['completed','failed','cancelled'].includes(item.status))break;
  await new Promise(r=>setTimeout(r,1500));
 }while(Date.now()<deadline);
 assert.equal(item.status,'completed',String(item.error||item.status));assert.equal(item.sessionId,session);assert.ok(String(item.finalMessage).includes(nonce));
 const runs=(await api(id,'/work-mode-runs?'+new URLSearchParams({profileId:profile,sessionKey:session}))).runs;
 const run=runs.find(r=>r.runId===item.workModeRunId);assert.ok(run);assert.equal(run.timingSource,'model');
 assert.ok(run.planningMinutes>=1&&run.planningMinutes<=30);assert.equal(run.taskMinutes,null);
 assert.equal(run.status,'completed');assert.equal(run.tasks.length,1);assert.equal(run.tasks[0].status,'completed');
 assert.ok(run.tasks[0].estimatedMinutes>=1&&run.tasks[0].estimatedMinutes<=240);assert.ok(run.tasks[0].evidence?.trim());
 report.run={runId:run.runId,status:run.status,timingSource:run.timingSource,planningMinutes:run.planningMinutes,planningDeadlineAt:run.planningDeadlineAt,
  taskMinutes:run.taskMinutes,tasks:run.tasks,completedAt:run.finishedAt};
 report.actualNativeOwnerUsed=true;report.noOperatorTimeValuesProvided=true;report.customerDataUntouched=true;
 report.passed=true;report.finishedAt=new Date().toISOString();delete report.error;
}catch(error){report.passed=false;report.error=error.message;throw error;}
finally{
 if(report.originalPreferences){
  await api(id,'/session-focus-mode',{profileId:profile,sessionKey:session,focusMode:report.originalPreferences});
  assert.deepEqual(prefs((await api(id,route)).focusMode),report.originalPreferences);
  report.originalPreferencesRestored=true;
 }
 await save();
}
console.log(JSON.stringify(report));
