import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test,{after} from 'node:test';
import {execFileSync} from 'node:child_process';
const storage=await mkdtemp(path.join(os.tmpdir(),'code-ai-capacity-test-'));
process.env.CODEX_STORAGE_ROOT=storage;process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';
process.env.CODEX_NTFY_STATE_FILE=path.join(storage,'notifications.json');
const now=Date.now(),at=new Date(now).toISOString();
const source=(id:string,extra={})=>({id,profileId:'developer',sourceProfileId:null,queueKey:'thread-'+id,sessionId:'thread-'+id,cwd:'/synthetic',
 model:'keep-model',reasoningEffort:'high',permissionModeId:'restricted',prompt:'Original task must NOT be replayed',promptPreview:'synthetic',attachments:[],status:'failed',
 createdAt:new Date(now-60000).toISOString(),startedAt:new Date(now-1000).toISOString(),updatedAt:at,completedAt:at,scheduledAt:at,attempts:1,scheduleMode:'once',
 failureKind:'model_capacity',capacityRetryPendingAt:at,nativeSubmission:{clientUserMessageId:'code-ai:'+id,queuedSubmissionId:'q-'+id,turnId:'t-'+id,deliveryPhase:'completed'},...extra});
await mkdir(path.join(storage,'queue'));
await writeFile(path.join(storage,'queue/state.json'),JSON.stringify({items:[source('one'),source('stop'),source('manual'),source('draft'),source('delete'),source('retry'),
 source('old',{capacityRetryPendingAt:null}),source('quota',{failureKind:'usage_limit'}),source('unknown',{nativeSubmission:{clientUserMessageId:'code-ai:unknown',queuedSubmissionId:'q-unknown',turnId:null,deliveryPhase:'detached'}}),
 source('daily',{status:'scheduled',lastRunStatus:'failed',scheduleMode:'recurring',recurringFrequency:'daily',recurringTimeZone:'UTC',scheduledAt:new Date(now+86400000).toISOString(),nativeSubmission:null,nativeRunId:'future-day'}),
 source('pending-stop'),source('second',{capacityRetry:{sourceItemId:'prior',rootItemId:'root',sourceStartedAt:at,failedAt:at,sourceWorkModeRunId:null,attempt:1}})],sessionBindings:{}}));
const q=await import('./codexQueue.js');
after(async()=>{await q.shutdownCodexQueueWorker();await rm(storage,{recursive:true,force:true})});
test('concurrent scheduling persists one fresh continuation and preserves the failed row and settings',async()=>{
 const [a,b]=await Promise.all([q.scheduleCodexCapacityContinuation('one'),q.scheduleCodexCapacityContinuation('one')]);assert.ok(a&&b);assert.equal(a.id,b.id);
 assert.notEqual(a.id,'one');assert.equal(a.nativeSubmission,null);assert.equal(a.model,'keep-model');assert.equal(a.permissionModeId,'restricted');assert.equal(a.reasoningEffort,'high');
 assert.match(a.prompt,/Continue from the exact point/);assert.ok(!a.prompt.includes('Original task'));assert.equal(a.sessionId,'thread-one');
 assert.equal(Date.parse(a.scheduledAt)-now,60000);assert.equal(a.status,'scheduled');assert.equal(a.capacityRetry?.attempt,1);
 assert.equal((await q.getCodexQueueItem('one')).status,'failed');
 const persisted=JSON.parse(await readFile(path.join(storage,'queue/state.json'),'utf8'));assert.equal(persisted.items.filter(x=>x.capacityRetry?.sourceItemId==='one').length,1);
 assert.equal(persisted.items.find(x=>x.id==='one').nativeSubmission.turnId,'t-one');assert.equal(persisted.items.find(x=>x.id==='one').capacityRetryPendingAt,null);
});
test('durable scheduled continuation becomes runnable at 60 seconds, never at 59.999 seconds',async t=>{
 t.mock.timers.enable({apis:['Date'],now});t.mock.timers.tick(59999);
 const rows=await q.listCodexQueueItems();const child=rows.find(x=>x.capacityRetry?.sourceItemId==='one');assert.equal(child.status,'scheduled');
 t.mock.timers.tick(1);const due=await q.getCodexQueueItem(child.id);assert.equal(due.status,'queued');
 assert.equal(q.selectRunnableCodexQueueItems([due],1,new Set(),new Set())[0].id,due.id);
});
test('stop and deletion of the failed source cancel the waiting automatic continuation',async()=>{
 for(const [id,remove] of [['stop',false],['delete',true]] as const){const a=await q.scheduleCodexCapacityContinuation(id);assert.ok(a);
  if(remove)await q.deleteCodexQueueItem(id);else await q.cancelCodexQueueItem(id);
  assert.equal((await q.getCodexQueueItem(a.id)).status,'cancelled');}
});
test('a stop before the worker processes its durable intent prevents creation',async()=>{
 await q.cancelCodexQueueItem('pending-stop');assert.equal(await q.scheduleCodexCapacityContinuation('pending-stop'),null);
});
test('manual continue/new message supersedes the automatic one; draft saves do not',async()=>{
 for(const id of ['manual','draft']){const a=await q.scheduleCodexCapacityContinuation(id);assert.ok(a);
  await q.enqueueCodexQueueItem({profileId:'developer',queueKey:'thread-'+id,sessionId:'thread-'+id,prompt:'manual input',saveAsDraft:id==='draft'});
  assert.equal((await q.getCodexQueueItem(a.id)).status,id==='draft'?'scheduled':'cancelled');}
});
test('manual retry supersedes pending auto-continue and keeps one native input identity per request',async()=>{
 const a=await q.scheduleCodexCapacityContinuation('retry');assert.ok(a);const manual=await q.retryCodexQueueItem('retry');
 assert.equal((await q.getCodexQueueItem(a.id)).status,'cancelled');assert.notEqual(manual.id,a.id);assert.equal(manual.capacityRetry,null);assert.equal(manual.nativeSubmission,null);
});
test('old failures, quota errors and unresolved custody never auto-restart',async()=>{
 for(const id of ['old','quota','unknown'])assert.equal(await q.scheduleCodexCapacityContinuation(id),null);
 assert.equal((await q.getCodexQueueItem('unknown')).nativeSubmission?.clientUserMessageId,'code-ai:unknown');
});
test('daily cadence is unchanged and each later capacity failure adds exactly one one-time continuation',async()=>{
 const daily=await q.getCodexQueueItem('daily'),a=await q.scheduleCodexCapacityContinuation('daily'),b=await q.scheduleCodexCapacityContinuation('second');
 assert.ok(a&&b);assert.equal(a.scheduleMode,'once');assert.equal((await q.getCodexQueueItem('daily')).scheduledAt,daily.scheduledAt);
 assert.equal(b.capacityRetry?.attempt,2);assert.equal(b.capacityRetry?.rootItemId,'root');
});
test('cold-process restart preserves the pending continuation and cannot create another one',async()=>{
 const child=(await q.listCodexQueueItems()).find(x=>x.capacityRetry?.sourceItemId==='draft');assert.ok(child);
 const module=new URL('../queue-core.mjs',import.meta.url).href;
 const code=`const q=await import(${JSON.stringify(module)}); const rows=await q.listCodexQueueItems();const child=rows.find(x=>x.capacityRetry?.sourceItemId==='draft');await q.scheduleCodexCapacityContinuation('draft');console.log(JSON.stringify({id:child.id,status:child.status,count:(await q.listCodexQueueItems()).filter(x=>x.capacityRetry?.sourceItemId==='draft').length}));await q.shutdownCodexQueueWorker();`;
 const loaded=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,CODEX_STORAGE_ROOT:storage,CODEX_QUEUE_DISABLE_EXECUTION:'1'}}).trim());
 assert.equal(loaded.id,child.id);assert.equal(loaded.status,'scheduled');assert.equal(loaded.count,1);
});
