import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const ops='/root/projects/code-ai/ops/work-modes-routing-20261020';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const prepared=await read(ops+'/prepared.json');
const release=path.basename(prepared.candidate);
assert.equal(path.dirname(await fs.realpath('/root/projects/code-ai/dist')),prepared.candidate);
const fleet=await read(ops+'/after-deployment.json');
const live=await read(ops+'/live-readback.json');
assert.equal(live.release,release);
const targets=[];
for(const id of ['local','beam-10g','pci']){
 const health=fleet.results.find(r=>r.id===id);
 const acceptance=await read(ops+'/'+id+'-acceptance.json');
 const activation=await read(id==='local'?prepared.candidate+'/activation-receipt.json':ops+'/'+id+'-activation.json');
 assert.equal(health.version,release);assert.equal(health.ready,true);assert.equal(acceptance.passed,true);
 assert.equal(acceptance.version,release);assert.equal(activation.installed,true);
 assert.equal(acceptance.rational.status,'completed');assert.equal(acceptance.decisionWake.nativeStatus,'completed');
 assert.equal(acceptance.decisionWake.sameSession,true);assert.equal(acceptance.sameVerdictAdmittedOnce,true);
 targets.push({id,status:'deployed-and-native-accepted',version:release,ready:true,
  rationalPlanAndEvidenceVerified:true,decisionParkVerified:true,decisionWakeSameConversationVerified:true,
  sameVerdictAdmittedOnce:true,sessionId:acceptance.sessionId,caseId:acceptance.caseId,
  queueItemId:acceptance.itemId,wakeItemId:acceptance.wakeItemId,failedAcceptanceAttemptsPreserved:acceptance.previousAttempts||[],
  caseStatus:acceptance.decisionWake.caseStatus,customerTicketClosed:false,
  activationFinishedAt:activation.finishedAt,acceptanceFinishedAt:acceptance.finishedAt,
  nonterminalQueueIdsPreserved:activation.nonterminalQueueIdsPreserved,
  profiles:health.profiles.filter(p=>p.provider==='codex').map(p=>({id:p.id,version:p.codexVersion,authenticated:p.authenticated,transportReady:p.transportReady}))});
}
const earlier=await read('/root/projects/code-ai/ops/focus-notifications-20261020/fleet-deployment-receipt.json');
for(const id of ['ubuntu-gpu-lab','personal-windows-me']){
 const health=fleet.results.find(r=>r.id===id),prior=earlier.targets?.find(r=>r.id===id)||earlier.results?.find(r=>r.id===id);
 targets.push({id,status:id==='ubuntu-gpu-lab'?'not-updated-storage-reserve-gate':'not-updated-unreachable',
  reachable:health?.reachable===true,version:health?.version||null,ready:health?.ready||false,
  changedByThisRelease:false,...(id==='ubuntu-gpu-lab'?{storagePolicy:'smart-build-hygiene: production filesystem reserve max(15%,100GB)',
  lastStorageCheck:prior||null}:{}),...(health?.error?{error:health.error}:{})});
}
const mainActivations=await Promise.all([prepared.baseline,prepared.candidate].map(p=>read(p+'/activation-receipt.json')));
const interruptedMainRuns=mainActivations.reduce((sum,r)=>sum+Math.max(0,(r.queueAfter?.cancelled||0)-(r.queueBefore?.cancelled||0)),0);
const result={format:'code-ai-work-modes-live-acceptance',version:1,finishedAt:new Date().toISOString(),release,
 sourceSha256:prepared.sourceSha256,beamBuildId:prepared.buildId,scopeCompleted:['local','beam-10g','pci'],
 allRegisteredTargetsUpdated:false,focusedUnitTests:{passed:54,failed:0},runtimeProgramsVerified:10,
 ui:{location:'Codex conversation → פעולות → מצב הגיוני והכרעות',rationalLabel:'מצב הגיוני — תוכנית עם זמנים ועצירה',
 decisionLabel:'מצב הכרעה — שמירת מקרים להחלטתי',defaultOff:true,perConversation:true,effectiveFromNextMessage:true,
 liveReadback:live,existingScreenshot:'/root/projects/code-ai/.code-ai/reports/work-modes-live-20261020/work-modes-live.png'},
 knownUntested:{physicalPhoneNotification:false,realDeadlineOverrun:false,deadlineStoreRegressionTests:true},
 ownerAuthorizedServiceRestarts:true,interruptedMainRuns,interruptedRunRecordsPreserved:true,
 nativeOwnersRestartedByDeployment:false,authenticationRotated:false,originalFailuresDeleted:false,targets};
await fs.writeFile(ops+'/final-receipt.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({receipt:ops+'/final-receipt.json',release,targets:targets.map(t=>({id:t.id,status:t.status})),testsPassed:54}));
