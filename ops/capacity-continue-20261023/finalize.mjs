import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',ops=root+'/ops/capacity-continue-20261023';
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const staged=await json(ops+'/staged.json'),activation=await json(ops+'/activation.json'),live=await json(ops+'/live-verification.json');
assert.ok(staged.passed&&activation.passed&&live.passed);
assert.equal(await fs.realpath(root+'/dist'),staged.candidate+'/dist');
const log=await fs.readFile(staged.candidate+'/qualification/capacity-resume.log','utf8');
const count=[...log.matchAll(/ℹ pass (\d+)/g)].reduce((total,match)=>total+Number(match[1]),0);
assert.equal(count,65);assert.ok(!/ℹ fail [1-9]/.test(log));
const appSha=createHash('sha256').update(await fs.readFile(staged.candidate+'/dist/app.mjs')).digest('hex');
assert.equal(appSha,staged.request.expectedAppSha256);
const receipt={
 format:'code-ai-capacity-auto-continuation',version:1,complete:true,at:new Date().toISOString(),
 scope:'Code-AI-managed task queue on main Germany only',buildId:staged.buildId,
 activeRelease:staged.candidate,predecessorRetained:staged.baseline,appSha256:appSha,
 behavior:{failureKind:'model_capacity',delayMs:60000,sameSession:true,sameModelSettings:true,
  instruction:'Existing Continue task action; never replay the original task prompt',
  repeatsAfterFurtherCapacityFailure:true,browserRequired:false,durableAcrossRestart:true,
  manualStopOrImmediateInputCancelsWaitingContinuation:true,draftSaveDoesNotCancel:true,
  quotaAuthenticationAndUncertainCustodyRetried:false,historicalFailuresRetried:false,
  firstFailureAndRecoveryNotificationsKept:true,repeatedCapacityChainAlertsSuppressed:true},
 verification:{testsPassed:count,compiledQueueTestsPassed:36,pureContractTestsPassed:29,
  exactOneMinuteBoundary:true,concurrentRequestDeduplication:true,coldProcessRestart:true,
  stopDeleteAndManualSupersession:true,dailyCadencePreserved:true,
  internalAndPublicApiPassed:true,publicBrowserSmokePassed:true,browser:'isolated Chromium',
  realCapacityFailureInduced:false,realTaskPromptsSubmittedAsTests:false},
 continuity:{activeNativeInputsPreserved:activation.preservedActiveInputs.length,nativeOwnersRestarted:false,
  originalInputsResent:false,recurringSchedulesPreserved:activation.recurringSchedulesPreserved,
  frontendChanged:false,uiPointer:staged.uiPointer,otherServersModified:false,privateQueueBackupRetained:true},
 qualificationNotes:[
  'The initial test harness omitted CODEX_STORAGE_ROOT for one existing notification test. The isolated fixture was corrected and all 65 tests passed; no product workaround was added.',
  'The first activation attempt stopped before mutation at the native-custody gate. The same handoff was retried after fresh state proved all active inputs detachable.',
  'One activation succeeded. A subsequent audit was too strict about all historical queue IDs: existing startup retention pruned seven terminal entries older than 21 days. Their private pre-switch backup remains; no conversation file was deleted. Audit reconciliation did not restart again.'
 ],
 limitations:[
  'Applies to newly failing Code-AI-managed queue items, not unowned external GUI-native turns or historical failed jobs.',
  'A busy queue, native-activity reconciliation or a user hold can defer actual start beyond the one-minute minimum.',
  'Personal Chrome returned DEVICE_OFFLINE; UI verification used isolated Chromium.',
  'No remote server was upgraded in this task; no actual provider-capacity incident was deliberately triggered.'
 ],
 evidence:['staged.json','static-preflight.json','activation.json','live-verification.json',
  staged.candidate+'/qualification/capacity-resume.log',staged.candidate+'/activation-receipt.json'],
};
await fs.writeFile(ops+'/final-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({complete:true,testsPassed:count,liveVerified:true,activeRelease:staged.candidate}));
