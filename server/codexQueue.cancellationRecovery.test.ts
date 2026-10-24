import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test,{after} from 'node:test';
const storage=await mkdtemp(path.join(os.tmpdir(),'code-ai-cancel-recovery-'));
process.env.CODEX_STORAGE_ROOT=storage;process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';
process.env.CODEX_NTFY_STATE_FILE=path.join(storage,'notifications.json');
const at=new Date().toISOString();
const item=(id,status,native=true)=>({id,profileId:'developer',queueKey:'queue-'+id,sessionId:'00000000-0000-4000-8000-000000000001',prompt:'Synthetic cancellation recovery',attachments:[],status,createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,startedAt:at,completedAt:null,
 ...(native?{nativeSubmission:{clientUserMessageId:'code-ai:'+id,queuedSubmissionId:'00000000-0000-4000-8000-000000000002',turnId:'00000000-0000-4000-8000-000000000003',deliveryPhase:'running'}}:{})});
await mkdir(path.join(storage,'queue'));
await writeFile(path.join(storage,'queue/state.json'),JSON.stringify({items:[item('pending','cancelling'),item('ordinary','cancelling',false),item('running','running')],sessionBindings:{}}));
const queue=await import('./codexQueue.js');
after(async()=>{await queue.shutdownCodexQueueWorker();await rm(storage,{recursive:true,force:true})});
test('cold restart preserves exact native IDs and stop intent instead of inventing a cancellation',async()=>{
 const v=await queue.getCodexQueueItem('pending');assert.equal(v.status,'queued');assert.ok(v.nativeCancellationRequestedAt);assert.equal(v.completedAt,null);
 assert.equal(v.nativeSubmission.clientUserMessageId,'code-ai:pending');assert.equal(v.nativeSubmission.turnId,'00000000-0000-4000-8000-000000000003');
 assert.notEqual(v.nativeSubmission.deliveryPhase,'cancelled');
 const d=JSON.parse(await readFile(path.join(storage,'queue/state.json'),'utf8'));assert.ok(d.items.find(i=>i.id==='pending').nativeCancellationRequestedAt);
});
test('ordinary active native work reconnects without acquiring cancellation intent',async()=>{
 const v=await queue.getCodexQueueItem('running');assert.equal(v.status,'queued');assert.ok(!v.nativeCancellationRequestedAt);
});
test('non-native predecessor stopping still follows the existing stopped-process contract',async()=>{
 const v=await queue.getCodexQueueItem('ordinary');assert.equal(v.status,'cancelled');
});
