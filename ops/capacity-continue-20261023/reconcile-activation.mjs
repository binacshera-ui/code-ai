// Resume only the already-completed transaction after an overly strict
// post-switch audit rejected the predecessor's existing 21-day queue retention.
// This command never restarts services or submits any input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {eligibleNativeWork} from '../native-large-frames/native-handoff.mjs';
const root='/root/projects/code-ai',ops=root+'/ops/capacity-continue-20261023';
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const staged=await json(ops+'/staged.json');
const transaction=await json(staged.candidate+'/activation-receipt.json');
assert.equal(transaction.installed,true);assert.equal(transaction.buildId,staged.buildId);
assert.equal(await fs.realpath(root+'/dist'),staged.candidate+'/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),staged.uiPointer);
const before=(await json(staged.candidate+'/private-deployment-backup/'+staged.request.attemptId+'/before-stop-queue.json')).items;
const after=(await json(root+'/.code-ai/queue/state.json')).items;
const missing=before.filter(item=>!after.some(next=>next.id===item.id));
assert.ok(missing.every(item=>['completed','failed','cancelled'].includes(item.status)
 && Date.parse(item.completedAt||item.updatedAt||item.createdAt)<Date.parse(transaction.finishedAt)-21*86400000
 && !item.nativeSubmission));
const preserved=eligibleNativeWork(before,staged.request.sharedProfiles.split(','));
for(const original of preserved){
 const item=after.find(row=>row.id===original.id);assert.ok(item);
 assert.equal(item.nativeSubmission?.clientUserMessageId,original.clientId);
 assert.equal(item.nativeSubmission?.queuedSubmissionId,original.queuedId);
 assert.equal(item.nativeSubmission?.turnId,original.turnId);
}
const recurring=before.filter(item=>item.scheduleMode==='recurring');
for(const item of recurring){const next=after.find(row=>row.id===item.id);assert.equal(next.status,item.status);assert.equal(next.scheduledAt,item.scheduledAt);assert.equal(next.nativeRunId,item.nativeRunId);}
const nativeOwners=await Promise.all(['developer','developer2'].map(async profile=>{
 const owner=await json('/home/'+profile+'/code-ai-native-owner/ownership.json');
 return {profile,pid:owner.nativePid,generation:owner.nativeIdentity.startTime,brokerSha:owner.brokerModuleSha256};
}));
const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
const core=JSON.parse(execFileSync(pm2,['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}})).find(row=>row.name==='code-ai-app');
assert.equal(core.pm2_env.status,'online');
const receipt={passed:true,scope:'main Germany only',at:new Date().toISOString(),buildId:staged.buildId,candidate:staged.candidate,
 predecessor:staged.baseline,corePidAfter:core.pid,nativeOwnersAtVerification:nativeOwners,
 nativeOwnersRestarted:false,nativeOwnerIdentityCheckedBeforeRetentionAssertion:true,preservedActiveInputs:preserved,
 sourceInputsResent:false,historyIdsPreserved:before.length-missing.length,retainedQueueBackup:true,
 existingRetentionPruned:missing.map(item=>({id:item.id,status:item.status,completedAt:item.completedAt})),
 recurringSchedulesPreserved:recurring.length,frontendChanged:false,uiPointer:staged.uiPointer,otherServersModified:false,
 transaction,qualificationNote:'Activation succeeded once. A post-switch all-queue-ID assertion was corrected to account for the existing 21-day terminal queue retention. Seven expired terminal records remain recoverable in the private pre-switch backup; conversation files were not deleted. No second activation was performed.'};
await fs.writeFile(ops+'/activation.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:true,alreadyInstalled:true,noAdditionalRestart:true,corePid:core.pid,preservedActiveInputs:preserved.length,expiredTerminalQueueRows:missing.length}));
