import fs from'node:fs/promises';import assert from'node:assert/strict';
import{fleetClient}from'../focus-notifications-20261020/fleet-live.mjs';
const[id]=process.argv.slice(2);assert.ok(['local','beam-10g','pci'].includes(id));
const root='ops/work-modes-routing-20261020',file=root+'/'+id+'-acceptance.json';
const report=JSON.parse(await fs.readFile(file,'utf8').catch(()=>JSON.stringify({id,startedAt:new Date().toISOString()})));
const api=await fleetClient(),save=()=>fs.writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const profile=id==='local'?'developer':id==='beam-10g'?'beam-admin':'pci-admin';
const nonce='CODE_AI_REAL_MODES_OK',followup='CODE_AI_VERDICT_RESUMED_OK';
async function waitItem(itemId){
 const deadline=Date.now()+360000;let item;
 do{item=(await api(id,'/queue/items/'+itemId+'?includeSession=false')).item;
   if(['completed','failed','cancelled'].includes(item.status))break;
   await new Promise(r=>setTimeout(r,1200));
 }while(Date.now()<deadline);
 assert.equal(item.status,'completed',String(item.error||item.status));return item;
}
try{
 const prepared=JSON.parse(await fs.readFile(root+'/prepared.json','utf8'));
 const health=await api(id,'/remote-agent/health');assert.equal(health.version,prepared.candidate.split('/').at(-1));assert.equal(health.ready,true);report.version=health.version;
 const{profiles}=await api(id,'/profiles');const cwd=profiles.find(p=>p.id===profile)?.workspaceCwd;assert.ok(cwd);
 const casesBefore=await api(id,'/incident-cases');assert.ok(Array.isArray(casesBefore.cases));report.canonicalBackendConnected=true;
 const key='real-work-modes-20261020-'+id;
 if(process.argv.includes('--repair-run-capability')&&!report.recoverySessionId&&!report.passed){
  assert.ok(report.itemId,'Recovery requires the original isolated maintenance attempt');
  const prior=(await api(id,'/queue/items/'+report.itemId+'?includeSession=false')).item;
  assert.equal(prior.status,'failed');assert.equal(prior.profileId,profile);assert.ok(prior.sessionId);
  assert.ok(String(prior.error).includes('מצב הגיוני'));
  const oldRuns=(await api(id,'/work-mode-runs?profileId='+profile+'&sessionKey='+prior.sessionId)).runs;
  const oldRun=oldRuns.find(r=>r.runId===prior.workModeRunId);
  assert.equal(oldRun?.status,'incomplete');assert.equal(oldRun.tasks.length,0);
  // This is the operator-owned acceptance case only, not a model bypass of a hold.
  // Preserve the failed native attempt and explicitly release its test hold.
  await fs.copyFile(file,file+'.before-control-auth-repair.json');
  await api(id,'/work-mode-runs/'+oldRun.runId+'/release',{profileId:profile,sessionKey:prior.sessionId});
  report.previousAttempts=[...(report.previousAttempts||[]),{itemId:prior.id,sessionId:prior.sessionId,
   runId:oldRun.runId,status:prior.status,reason:'Dedicated run capability blocked by sidecar host authentication; no plan or CPU work accepted'}];
  report.recoverySessionId=prior.sessionId;delete report.itemId;delete report.error;await save();
 }
 if(!report.itemId){
  await api(id,'/session-focus-mode',{profileId:profile,sessionKey:report.recoverySessionId||key,focusMode:{enabled:false,goal:'Isolated Code AI work-mode acceptance only',rationalEnabled:true,decisionEnabled:true,planningMinutes:3,taskMinutes:5}});
  const item=(await api(id,'/queue/items',{profileId:profile,queueKey:report.recoverySessionId||key,
   ...(report.recoverySessionId?{sessionId:report.recoverySessionId}:{}),clientRequestId:key+(report.recoverySessionId?':control-auth-repair':''),cwd,
   prompt:'Isolated Code AI maintenance acceptance, not a customer incident. Follow the supplied work-mode helper instructions. Save a plan with exactly one measurable task, estimate 5 minutes. Run exactly one CPU command: python3 -c \'assert 7*9 == 63; print("'+nonce+'")\'. Using the supplied helper, park exactly one case for operator decision: requestId "maintenance_modes_20261020_'+id+'", title "בדיקת תחזוקה בלבד — מצבי עבודה '+id+'", summary "Isolated maintenance acceptance, no customer and no linked ticket; CPU command exited successfully. Awaiting a test verdict to prove same-session continuation.", operatorQuestion "Approve a CPU-only continuation test?". Do NOT set a failureTicketId. Mark the planned task complete with actual command stdout/exit-code evidence. Reply exactly '+nonce+'. Do not send emails, contact anyone, read project/customer/auth files, delegate, start goals, or perform any other work.',
   promptPreview:'בדיקת תחזוקה: תוכנית, וי ומקרה להכרעה'})).item;
  report.itemId=item.id;await save();console.log(JSON.stringify({phase:'submitted',id,itemId:item.id}));
 }
 const first=await waitItem(report.itemId);assert.ok(String(first.finalMessage).includes(nonce));assert.ok(first.sessionId);report.sessionId=first.sessionId;
 const query='?profileId='+profile+'&sessionKey='+first.sessionId;
 const{runs}=await api(id,'/work-mode-runs'+query);const run=runs.find(r=>r.runId===first.workModeRunId);assert.ok(run);assert.equal(run.status,'completed');assert.equal(run.tasks.length,1);assert.equal(run.tasks[0].status,'completed');assert.ok(run.tasks[0].evidence?.trim());
 report.rational={runId:run.runId,status:run.status,completedTasks:1,evidenceRecorded:true};
 const listing=await api(id,'/incident-cases');const parked=listing.cases.find(c=>c.metadata?.workModeRunId===first.workModeRunId);assert.ok(parked,'Native helper did not park its case');
 assert.equal(parked.investigatorSessionId,first.sessionId);assert.equal(parked.investigatorProfileId,profile);assert.equal(parked.metadata.codeAiServerId,id);assert.ok(!parked.failureTicketId,'Maintenance case must not link a customer ticket');
 report.caseId=parked.caseId;report.decisionPark={status:parked.status,sameSession:true,originServer:id,noCustomerTicket:true};await save();console.log(JSON.stringify({phase:'plan-and-park-completed',id,sessionId:first.sessionId,caseId:parked.caseId}));
 if(!report.wakeItemId){
  const verdict={requestId:'maintenance_verdict_20261020_'+id,
   summary:'Approved maintenance acceptance only. In THIS SAME conversation, follow rational-mode instructions: make a plan with one task estimated 5 minutes; run exactly python3 -c \'assert 8*8 == 64; print("'+followup+'")\'; mark the task complete with actual evidence. Use your supplied work-mode helper case-execution action to report this existing case '+parked.caseId+' completed with verification_results containing the actual CPU check. There is NO customer ticket to close. Do not create another case, send emails, read customer/project/auth files, delegate or do other work. Reply exactly '+followup+'.',
   executionScope:['Only CPU arithmetic and maintenance case execution report'],testPlan:['CPU exit0/stdout','Same originating conversation','No customer ticket closure']};
  // Exercise the central/global center too: it must delegate to the origin,
  // not create a main-server context or try its local native owner.
  const result=await api('local','/incident-cases/'+parked.caseId+'/verdict',verdict);
  const wake=result.wakeResult;assert.ok(wake?.queue_item_id);assert.equal(wake.session_id,first.sessionId);assert.equal(wake.profile_id,profile);
  report.wakeItemId=wake.queue_item_id;await save();
  const duplicate=await api('local','/incident-cases/'+parked.caseId+'/verdict',verdict);assert.equal(duplicate.wakeResult?.queue_item_id,wake.queue_item_id);
  report.sameVerdictAdmittedOnce=true;await save();console.log(JSON.stringify({phase:'verdict-wake-admitted',id,itemId:report.wakeItemId}));
 }
 const second=await waitItem(report.wakeItemId);assert.equal(second.sessionId,first.sessionId);assert.ok(String(second.finalMessage).includes(followup));
 const detail=await api('local','/incident-cases/'+parked.caseId);const c=detail.caseRecord||detail.case;
 assert.ok(c);assert.equal(c.investigatorSessionId,first.sessionId);assert.equal(c.metadata.codeAiServerId,id);
 assert.ok(['waiting_completion_confirmation','completed'].includes(c.status),c.status);
 report.decisionWake={sameSession:true,sameOrigin:true,nativeStatus:second.status,caseStatus:c.status,customerTicketClosed:false};
 const{runs:afterRuns}=await api(id,'/work-mode-runs'+query);assert.equal(afterRuns.find(r=>r.runId===second.workModeRunId)?.status,'completed');
 report.passed=true;delete report.error;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report));
}catch(error){report.passed=false;report.error=error.message;await save();console.error(JSON.stringify({id,passed:false,error:error.message}));process.exitCode=1;}
