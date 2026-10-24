import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';import path from 'node:path';
import {eligibleNativeWork,withNativeHandoff} from './native-handoff.mjs';
const item={id:'one',profileId:'fixture',sessionId:'thread',status:'running',nativeSubmission:{clientUserMessageId:'code-ai:one',queuedSubmissionId:'q',turnId:'t',deliveryPhase:'running'}};
test('recurring schedule preserves a distinct native occurrence during handoff',()=>{
 const recurring={...item,nativeRunId:'occurrence-two',nativeSubmission:{...item.nativeSubmission,clientUserMessageId:'code-ai:occurrence-two'}};
 assert.equal(eligibleNativeWork([recurring],['fixture'])[0].clientId,'code-ai:occurrence-two');
 assert.throws(()=>eligibleNativeWork([{...recurring,nativeSubmission:item.nativeSubmission}],['fixture']));
});
test('only exact durable native work can use the handoff; cancelling/legacy/foreign custody is refused',()=>{
 assert.equal(eligibleNativeWork([item],['fixture']).length,1);
 for(const i of [{...item,status:'cancelling'},{...item,nativeSubmission:null},{...item,profileId:'other'}])assert.throws(()=>eligibleNativeWork([i],['fixture']));
});
test('failure resumes only the original core generation, never a successor',async()=>{
 for(const reused of [false,true]){const signals=[];let checks=0;
 await assert.rejects(withNativeHandoff({pid:100,items:[item],profiles:['fixture'],signal:(...x)=>signals.push(x),identity:async()=>++checks===1||!reused?'old':'new',replace:async()=>{throw Error('gate');}}));
 assert.deepEqual(signals,reused?[[100,'SIGSTOP']]:[[100,'SIGSTOP'],[100,'SIGCONT']]);}
});
test('real isolated core replacement cannot run its cancellation handler while stopped',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'code-ai-native-handoff-'));const marker=path.join(root,'cancelled');
 const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>require('fs').writeFileSync(${JSON.stringify(marker)},'cancelled'));process.stdout.write('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore']});
 t.after(async()=>{try{child.kill('SIGKILL');}catch{}await rm(root,{recursive:true,force:true});});await once(child.stdout,'data');
 const exited=once(child,'exit');const result=await withNativeHandoff({pid:child.pid,items:[item],profiles:['fixture'],replace:async()=>{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,50));child.kill('SIGKILL');await exited;return 'replaced';}});
 assert.equal(result.suspended,true);assert.equal(result.preserved[0].turnId,'t');await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('lost ACK with a durable stable input ID is detached, never cancelled or resent',()=>{
 const uncertain={...item,status:'queued',nativeSubmission:{clientUserMessageId:'code-ai:one',queuedSubmissionId:null,turnId:null,deliveryPhase:'detached'}};
 assert.equal(eligibleNativeWork([uncertain],['fixture']).length,1);
 assert.equal(eligibleNativeWork([{...uncertain,status:'running'}],['fixture']).length,1);
 assert.throws(()=>eligibleNativeWork([{...uncertain,nativeSubmission:{...uncertain.nativeSubmission,clientUserMessageId:'foreign'}}],['fixture']));
});
