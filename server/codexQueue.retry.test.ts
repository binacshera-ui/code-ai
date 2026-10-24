import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test,{after} from 'node:test';
const storage=await mkdtemp(path.join(os.tmpdir(),'code-ai-native-retry-'));
process.env.CODEX_STORAGE_ROOT=storage;process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';
process.env.CODEX_NTFY_STATE_FILE=path.join(storage,'notifications.json');
const at=new Date().toISOString();
const fixture=(id:string,status='failed',phase='completed',extra={})=>({id,profileId:'developer',sourceProfileId:null,queueKey:'thread-key',sessionId:'00000000-0000-4000-8000-000000000001',cwd:'/synthetic',model:'pinned-model',reasoningEffort:'high',permissionModeId:'read-only',prompt:'Synthetic original input',promptPreview:'Synthetic input',attachments:[],status,createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,startedAt:at,completedAt:at,error:'HTTP 401',finalMessage:null,scheduleMode:'once',nativeSubmission:{clientUserMessageId:'code-ai:'+id,queuedSubmissionId:'00000000-0000-4000-8000-000000000002',turnId:'00000000-0000-4000-8000-000000000003',deliveryPhase:phase},...extra});
const fixtures=[fixture('failed'),fixture('cancelled','cancelled','cancelled'),fixture('unresolved','failed','detached'),fixture('already-finished','cancelled','completed'),fixture('successful','completed','completed'),fixture('recurring','failed','completed',{scheduleMode:'recurring',recurringFrequency:'daily',recurringTimeZone:'UTC'})];
await mkdir(path.join(storage,'queue'));await writeFile(path.join(storage,'queue/state.json'),JSON.stringify({items:fixtures,sessionBindings:{}}));
const queue=await import('./codexQueue.js');
after(async()=>{await queue.shutdownCodexQueueWorker();await rm(storage,{recursive:true,force:true})});
test('explicit retry of failed native input has a fresh ID, preserves the failed attempt and deduplicates concurrent clicks',async()=>{
 const before=await queue.getCodexQueueItem('failed');const [a,b]=await Promise.all([queue.retryCodexQueueItem('failed'),queue.retryCodexQueueItem('failed')]);
 assert.notEqual(a.id,'failed');assert.equal(a.id,b.id);assert.equal(a.retryOfItemId,'failed');assert.equal(a.nativeSubmission,null);assert.equal(a.status,'queued');assert.equal(a.attempts,0);
 for(const key of ['profileId','queueKey','sessionId','cwd','model','reasoningEffort','permissionModeId','prompt','promptPreview'])assert.equal(a[key],before[key],key);
 assert.deepEqual(await queue.getCodexQueueItem('failed'),before);
 const persisted=JSON.parse(await readFile(path.join(storage,'queue/state.json'),'utf8'));assert.equal(persisted.items.filter(x=>x.retryOfItemId==='failed').length,1);assert.equal(persisted.items.find(x=>x.id==='failed').nativeSubmission.clientUserMessageId,'code-ai:failed');
 assert.equal((await queue.retryCodexQueueItem('failed')).id,a.id);
});
test('confirmed native cancellation can be retried with a new identity',async()=>{
 const r=await queue.retryCodexQueueItem('cancelled');assert.notEqual(r.id,'cancelled');assert.equal(r.nativeSubmission,null);assert.equal((await queue.getCodexQueueItem('cancelled')).status,'cancelled');
});
test('an unresolved accepted submission is never replayed',async()=>{
 await assert.rejects(queue.retryCodexQueueItem('unresolved'));assert.equal((await queue.listCodexQueueItems()).filter(x=>x.retryOfItemId==='unresolved').length,0);
});
test('a native completion contradicting local cancellation is not duplicated',async()=>{
 await assert.rejects(queue.retryCodexQueueItem('already-finished'));assert.equal((await queue.listCodexQueueItems()).filter(x=>x.retryOfItemId==='already-finished').length,0);
});
test('a successful native turn cannot be retried as a failed attempt',async()=>{await assert.rejects(queue.retryCodexQueueItem('successful'))});
test('recurring retry keeps its cadence with one active successor',async()=>{
 const r=await queue.retryCodexQueueItem('recurring');assert.notEqual(r.id,'recurring');assert.equal(r.scheduleMode,'recurring');assert.equal(r.recurringFrequency,'daily');assert.equal(r.recurringTimeZone,'UTC');assert.equal(r.status,'scheduled');assert.ok(new Date(r.scheduledAt).getTime()>Date.now());assert.equal((await queue.getCodexQueueItem('recurring')).status,'failed');
});
