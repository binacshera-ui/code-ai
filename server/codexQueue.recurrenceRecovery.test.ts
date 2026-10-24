import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test,{after} from 'node:test';
const storage=await mkdtemp(path.join(os.tmpdir(),'code-ai-recurrence-recovery-'));
process.env.CODEX_STORAGE_ROOT=storage;process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';
const at=new Date().toISOString(),next=new Date(Date.now()+86400000).toISOString();
const fixture=(id:string,status='scheduled',phase='completed')=>({id,profileId:'developer',sourceProfileId:null,queueKey:'synthetic-thread',sessionId:'synthetic-thread',cwd:'/synthetic',prompt:'DO NOT EXECUTE',promptPreview:'synthetic',attachments:[],status,createdAt:at,updatedAt:at,scheduledAt:next,startedAt:at,completedAt:at,attempts:1,scheduleMode:'recurring',recurringFrequency:'daily',recurringTimeZone:'UTC',lastRunAt:at,lastRunStatus:'completed',nativeSubmission:{clientUserMessageId:'code-ai:'+id,queuedSubmissionId:'q-'+id,turnId:'t-'+id,deliveryPhase:phase}});
await mkdir(path.join(storage,'queue'));
const cycled={...fixture('cycled','failed'),nativeRunId:'native-cycle',nativeSubmission:{clientUserMessageId:'code-ai:native-cycle',queuedSubmissionId:'q-cycle',turnId:'t-cycle',deliveryPhase:'completed'}};
await writeFile(path.join(storage,'queue/state.json'),JSON.stringify({items:[fixture('enabled'),fixture('disabled','cancelled'),fixture('uncertain','queued','detached'),cycled],sessionBindings:{}}));
const q=await import('./codexQueue.js');
after(async()=>{await q.shutdownCodexQueueWorker();await rm(storage,{recursive:true,force:true})});
test('real queue load repairs only stale enabled recurrence and persists its next identity',async()=>{
 const row=await q.getCodexQueueItem('enabled');assert.equal(row.status,'scheduled');assert.equal(row.nativeSubmission,null);assert.ok(row.nativeRunId);
 assert.equal(row.lastRunNativeSubmission?.turnId,'t-enabled');assert.equal(row.scheduledAt,next);
 const persisted=JSON.parse(await readFile(path.join(storage,'queue/state.json'),'utf8')).items.find(x=>x.id==='enabled');assert.equal(persisted.nativeRunId,row.nativeRunId);
});
test('real queue load neither re-enables a cancelled job nor resets detached native work',async()=>{
 const disabled=await q.getCodexQueueItem('disabled');assert.equal(disabled.status,'cancelled');assert.equal(disabled.nativeSubmission?.turnId,'t-disabled');
 const pending=await q.getCodexQueueItem('uncertain');assert.equal(pending.nativeSubmission?.clientUserMessageId,'code-ai:uncertain');assert.equal(pending.nativeSubmission?.deliveryPhase,'detached');assert.ok(!pending.nativeRunId);
});
test('explicit retry never inherits an already accepted occurrence identity',async()=>{
 const retry=await q.retryCodexQueueItem('cycled');assert.notEqual(retry.id,'cycled');assert.equal(retry.nativeRunId,null);assert.equal(retry.nativeSubmission,null);
 assert.equal((await q.getCodexQueueItem('cycled')).nativeSubmission?.clientUserMessageId,'code-ai:native-cycle');
});
test('native failure ownership still recognizes the preceding occurrence',async()=>{
 assert.equal(await q.ownsCodexQueueNativeFailure({profileId:'developer',sessionId:'synthetic-thread',turnId:'t-enabled',timestamp:at} as any),true);
});
