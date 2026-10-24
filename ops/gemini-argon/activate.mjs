import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {withNativeHandoff} from '../native-large-frames/native-handoff.mjs';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
const ops='/root/projects/code-ai/ops/gemini-argon';
const {request}=JSON.parse(await readFile(ops+'/staged.json','utf8'));
const controller='/root/projects/code-ai/.code-ai/queue/deployment-drain/controller.json';
const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:240000,env:{...process.env,PM2_HOME:'/root/.pm2'},...options});
let lease=null;
const receipt={buildId:request.buildId,model:'gemini-4-argon',startedAt:new Date().toISOString(),complete:false};
const save=()=>writeFile(ops+'/activation.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
try{
  assert.equal(await realpath('/root/projects/code-ai/dist'),request.baseline+'/dist');
  const status=await requestController(controller,{action:'status'});
  lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:request.buildId,ttlMs:120000});
  const before=JSON.parse(run(pm2,['jlist'])).find(v=>v.name==='code-ai-app');
  const items=JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8')).items;
  const owners=[];
  for(const profile of ['developer','developer2']){
    const file='/home/'+profile+'/code-ai-native-owner/ownership.json';
    const x=JSON.parse(await readFile(file,'utf8'));owners.push({profile,file,nativePid:x.nativePid,startTime:x.nativeIdentity.startTime});
  }
  const transaction=await readFile('/root/projects/code-ai/ops/native-unlock-release/activate-host.mjs','utf8');
  const switched=await withNativeHandoff({pid:before.pid,items,profiles:request.sharedProfiles.split(','),replace:async()=>{
    const output=run(request.nodeExecutable,['--input-type=module','-',request.requestFile],{input:transaction,cwd:request.candidate});
    return JSON.parse(output.trim());
  }});
  for(const owner of owners){const x=JSON.parse(await readFile(owner.file,'utf8'));assert.equal(x.nativePid,owner.nativePid);assert.equal(x.nativeIdentity.startTime,owner.startTime);}
  assert.equal(switched.result.installed,true);
  assert.equal(switched.result.credentialConfigurationBytePreserved,true);
  assert.equal(await realpath('/root/projects/code-ai/dist'),request.candidate+'/dist');
  assert.equal(createHash('sha256').update(await readFile(request.candidate+'/dist/app.mjs')).digest('hex'),request.expectedAppSha256);
  const afterItems=JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8')).items;
  for(const input of switched.preserved){
    const after=afterItems.find(v=>v.id===input.id);assert.ok(after);
    assert.equal(after.sessionId,input.sessionId);
    if(after.nativeSubmission){assert.equal(after.nativeSubmission.clientUserMessageId,input.clientId);}
  }
  Object.assign(receipt,{complete:true,finishedAt:new Date().toISOString(),activeRelease:request.candidate,
    credentialsPreserved:true,nativeOwnerGenerationsPreserved:true,preservedActiveInputs:switched.preserved.length,
    preservedInputIds:switched.preserved.map(p=>p.id),inputsResent:false,coreHandoffUsed:switched.suspended,
    ownerProcesses:owners.map(v=>({profile:v.profile,nativePid:v.nativePid,startTime:v.startTime}))});
  await save();console.log(JSON.stringify({complete:true,model:receipt.model,preservedActiveInputs:receipt.preservedActiveInputs,nativeOwnerGenerationsPreserved:true}));
}catch(error){
  Object.assign(receipt,{complete:false,failedAt:new Date().toISOString(),errorClass:error.name,errorCode:error.code||'ACTIVATION_GATE_FAILED'});
  await save();process.exitCode=1;
}finally{
  if(lease){try{const status=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:status.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
}
