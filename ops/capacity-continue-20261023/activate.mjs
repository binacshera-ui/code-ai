import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {withNativeHandoff} from '../native-large-frames/native-handoff.mjs';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';

const root='/root/projects/code-ai', ops=root+'/ops/capacity-continue-20261023';
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const run=(binary,args,options={})=>execFileSync(binary,args,{encoding:'utf8',timeout:120000,stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'},...options});
const staged=await json(ops+'/staged.json');
assert.equal(staged.passed,true);
assert.equal(staged.request.id,'main');
assert.equal(staged.request.sharedProfiles,'developer,developer2');
assert.equal(await fs.realpath(root+'/dist'),staged.baseline+'/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),staged.uiPointer);
for(const file of staged.changed) assert.equal(await digest(root+'/'+file),await digest(staged.candidate+'/'+file),'Qualified source changed: '+file);
const verifier=JSON.parse(run(staged.request.nodeExecutable,[
 '/home/developer/.codex/skills/live-production-deployment/scripts/verify-release-candidate.mjs',
 '--candidate',staged.candidate,'--active',staged.baseline,
 '--require','package.json','--require','dist/server.js','--require','dist/app.mjs',
 '--require','server/codexCapacityContinuation.mjs','--require','qualification/capacity-resume.log',
]));
assert.equal(verifier.ok,true);
await save(ops+'/static-preflight.json',verifier);

const controller=root+'/.code-ai/queue/deployment-drain/controller.json';
let lease;
try {
 const status=await requestController(controller,{action:'status'});
 lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:staged.buildId,ttlMs:120000});
 assert.equal(await fs.realpath(root+'/dist'),staged.baseline+'/dist');
 const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
 const before=JSON.parse(run(pm2,['jlist'])).find(process=>process.name==='code-ai-app');
 assert.ok(before?.pid>1);
 const items=(await json(root+'/.code-ai/queue/state.json')).items;
 assert.ok(items.filter(item=>item.scheduleMode==='recurring'&&item.status==='scheduled').every(item=>Date.parse(item.scheduledAt)>Date.now()+120000),'Due recurrence would make predecessor rollback unsafe');
 const owners=await Promise.all(['developer','developer2'].map(async profile=>{
  const owner=await json('/home/'+profile+'/code-ai-native-owner/ownership.json');
  return {profile,pid:owner.nativePid,generation:owner.nativeIdentity.startTime,brokerSha:owner.brokerModuleSha256};
 }));
 const switched=await withNativeHandoff({pid:before.pid,items,profiles:staged.request.sharedProfiles.split(','),replace:async()=>JSON.parse(run(staged.request.nodeExecutable,[staged.candidate+'/install.mjs','activate',staged.candidate+'/fleet-request.json'],{cwd:staged.candidate}).trim())});
 assert.equal(switched.result.installed,true);
 assert.equal(await fs.realpath(root+'/dist'),staged.candidate+'/dist');
 assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),staged.uiPointer);
 for(const old of owners){
  const owner=await json('/home/'+old.profile+'/code-ai-native-owner/ownership.json');
  assert.equal(owner.nativePid,old.pid);assert.equal(owner.nativeIdentity.startTime,old.generation);assert.equal(owner.brokerModuleSha256,old.brokerSha);
 }
 const after=(await json(root+'/.code-ai/queue/state.json')).items;
 // Existing startup retention removes terminal queue entries older than 21
 // days. This is not conversation-history deletion; the full queue backup
 // remains private in the candidate. Nonterminal/native custody must survive.
 const missing=items.filter(item=>!after.some(next=>next.id===item.id));
 assert.ok(missing.every(item=>['completed','failed','cancelled'].includes(item.status)
   && Date.parse(item.completedAt||item.updatedAt||item.createdAt)<Date.now()-21*86400000
   && !item.nativeSubmission),'Nonterminal or recent queue history disappeared');
 const recurring=items.filter(item=>item.scheduleMode==='recurring');
 for(const item of recurring){const next=after.find(row=>row.id===item.id);assert.equal(next.status,item.status);assert.equal(next.scheduledAt,item.scheduledAt);assert.equal(next.nativeRunId,item.nativeRunId);}
 const coreAfter=JSON.parse(run(pm2,['jlist'])).find(process=>process.name==='code-ai-app');
 assert.equal(coreAfter.pm2_env.status,'online');
 await save(ops+'/activation.json',{
  passed:true,scope:'main Germany only',at:new Date().toISOString(),buildId:staged.buildId,
  candidate:staged.candidate,predecessor:staged.baseline,corePidBefore:before.pid,corePidAfter:coreAfter.pid,
  nativeOwners:owners,nativeOwnersRestarted:false,preservedActiveInputs:switched.preserved,
  sourceInputsResent:false,historyIdsPreserved:items.length-missing.length,retainedQueueBackup:true,
  existingRetentionPruned:missing.map(item=>({id:item.id,status:item.status})),recurringSchedulesPreserved:recurring.length,
  frontendChanged:false,uiPointer:staged.uiPointer,otherServersModified:false,transaction:switched.result,
 });
 console.log(JSON.stringify({passed:true,installed:true,corePid:coreAfter.pid,activeNativeInputsPreserved:switched.preserved.length,nativeOwnersRestarted:false,frontendChanged:false}));
} finally {
 if(lease)try{const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}
}
