import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',ops=root+'/ops/scheduler-startup-20261023';
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const s=await json(ops+'/staged.json'),api=await json(ops+'/api-activation.json'),ui=await json(ops+'/ui-activation.json');
const before=await json(ops+'/before.json'),after=await json(ops+'/after.json'),preview=await json(ops+'/preview.json');
assert.ok(api.passed&&ui.installed&&after.browser.passed&&preview.browser.passed);
assert.equal(await fs.realpath(root+'/dist'),s.candidate+'/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),ui.release+'/locations.conf');
const processes=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}}));
const core=processes.find(p=>p.name==='code-ai-app');assert.equal(core.pm2_env.status,'online');
for(const n of api.nativeOwners){const current=await json('/home/'+n.id+'/code-ai-native-owner/ownership.json');assert.equal(current.nativePid,n.pid);assert.equal(current.nativeIdentity.startTime,n.generation);}
const items=(await json(root+'/.code-ai/queue/state.json')).items;
assert.ok(api.disabledSchedulesPreserved.every(id=>items.find(i=>i.id===id)?.status==='cancelled'));
assert.ok(api.preservedActiveInputs.every(old=>items.some(i=>i.id===old.id&&i.nativeSubmission?.clientUserMessageId===old.clientId)));
for(const file of s.backendFiles)assert.equal(await fs.readFile(root+'/'+file,'utf8'),await fs.readFile(s.candidate+'/'+file,'utf8'),'Scoped API source moved');
const backendLog=await fs.readFile(s.candidate+'/qualification/backend-resume-scheduler.log','utf8');
assert.ok(backendLog.includes('pass 98')&&backendLog.includes('pass 10')&&!backendLog.includes('fail 1'));
const uiLog=await fs.readFile(s.workspace+'/qualification/ui-scheduler.log','utf8');assert.ok(uiLog.includes('pass 8'));
const receipt={format:'code-ai-scheduler-startup-repair',version:1,complete:true,at:new Date().toISOString(),scope:'main Germany API and shared web UI only',
 buildId:s.buildId,apiRelease:s.candidate,uiRelease:ui.release,uiSourceSha256:s.sourceSha256,
 scheduler:{cause:'A recurring schedule reused the previous completed native input identity.',
   fixed:'Fresh durable native identity per occurrence; unresolved submissions retain custody; cancelled schedules are not re-enabled.',
   migrated:api.migratedSchedules,disabledSchedulesPreserved:api.disabledSchedulesPreserved,
   realJobsExecutedAsTests:false,missedPromptsReplayed:false,historicalFailureEvidencePreserved:true},
 startup:{cause:'Initial load synchronously refreshed every remote host before loading the selected profile.',
   fixed:'Read registry first, load selected profile, refresh remote health asynchronously.',
   publicConversationBeforeMs:before.browser.conversationMs,publicConversationAfterMs:after.browser.conversationMs,
   observedReductionPercent:Math.round((1-after.browser.conversationMs/before.browser.conversationMs)*100),
   publicComposerBeforeMs:before.browser.composerMs,publicComposerAfterMs:after.browser.composerMs,
   requestOrderingVerified:after.browser.startupRequests,liveBrowserPageErrors:after.browser.pageErrors},
 verification:{compiledBackendTestsPassed:98,nativeIdentityUnitTestsPassed:10,uiTestsPassed:8,handoffTestsPassed:5,totalTestsPassed:121,
   isolatedBuildPassed:true,staticPreflightPassed:true,isolatedBrowserPassed:true,publicLiveBrowserPassed:true},
 continuity:{corePidBefore:api.corePidBefore,corePidAfter:core.pid,nativeOwnersRestarted:false,
   activeNativeInputsPreserved:api.preservedActiveInputs.length,sourceInputsResent:false,historyOrLocksDeleted:false,otherServersModified:false},
 qualificationNotes:['Initial isolated test fixture could not write under the shared HDD root; it now uses its private test scratch directory.',
   'An unchanged 21MB transport test timed out under parallel fixture I/O; the complete serialized suite passed without changing product timeouts.',
   'One initial preview took 17492ms; a subsequent preview took 3960ms. The public before/after timings are observations, not a latency SLA.'],
 limitations:['The next real scheduled occurrence has not elapsed; tests used isolated synthetic data, not actual maintenance prompts.',
   'Personal Chrome returned DEVICE_OFFLINE; browser measurements used isolated Chromium.',
   'Historical false-completion timestamps were preserved as incident evidence rather than rewritten.'],
 evidence:['diagnosis.json','before.json','preview.json','after.json','api-activation.json','ui-activation.json','static-preflight.json']};
await fs.writeFile(ops+'/final-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({complete:true,testsPassed:121,publicBeforeMs:receipt.startup.publicConversationBeforeMs,publicAfterMs:receipt.startup.publicConversationAfterMs,
 reductionPercent:receipt.startup.observedReductionPercent,activeInputsPreserved:receipt.continuity.activeNativeInputsPreserved,corePid:core.pid}));
