import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {withNativeHandoff} from '../native-large-frames/native-handoff.mjs';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
const root='/root/projects/code-ai',ops=root+'/ops/scheduler-startup-20261023';
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const s=await json(ops+'/staged.json');assert.equal(s.passed,true);
assert.equal((await json(ops+'/preview.json')).browser.passed,true);
const r=s.request;assert.equal(r.id,'main');assert.equal(r.sharedProfiles,'developer,developer2');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),s.uiPointer);
const run=(bin,args,options={})=>execFileSync(bin,args,{encoding:'utf8',timeout:120000,stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'},...options});
if(process.argv[2]==='api'){
 assert.equal(await fs.realpath(root+'/dist'),s.baseline+'/dist');
 const controller=root+'/.code-ai/queue/deployment-drain/controller.json';let lease;
 try{
  const status=await requestController(controller,{action:'status'});
  lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:s.buildId,ttlMs:120000});
  const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2',before=JSON.parse(run(pm2,['jlist'])).find(p=>p.name==='code-ai-app');
  const items=(await json(root+'/.code-ai/queue/state.json')).items;
  assert.ok(items.filter(i=>i.scheduleMode==='recurring'&&i.status==='scheduled').every(i=>Date.parse(i.scheduledAt)>Date.now()+120000),'Due recurrence would make predecessor rollback unsafe');
  const owners=await Promise.all(['developer','developer2'].map(async id=>{const x=await json('/home/'+id+'/code-ai-native-owner/ownership.json');return {id,pid:x.nativePid,generation:x.nativeIdentity.startTime,brokerSha:x.brokerModuleSha256}}));
  const switched=await withNativeHandoff({pid:before.pid,items,profiles:r.sharedProfiles.split(','),replace:async()=>JSON.parse(run(r.nodeExecutable,[s.candidate+'/install.mjs','activate',s.candidate+'/fleet-request.json'],{cwd:s.candidate}).trim())});
  assert.equal(switched.result.installed,true);assert.equal(await fs.realpath(root+'/dist'),s.candidate+'/dist');
  for(const old of owners){const x=await json('/home/'+old.id+'/code-ai-native-owner/ownership.json');assert.equal(x.nativePid,old.pid);assert.equal(x.nativeIdentity.startTime,old.generation);assert.equal(x.brokerModuleSha256,old.brokerSha);}
  const after=(await json(root+'/.code-ai/queue/state.json')).items;
  const disabled=items.filter(i=>i.scheduleMode==='recurring'&&i.status==='cancelled');
  assert.ok(disabled.every(i=>after.find(j=>j.id===i.id)?.status==='cancelled'));
  const expected=items.filter(i=>i.scheduleMode==='recurring'&&i.status==='scheduled'&&!i.nativeRunId
    &&i.nativeSubmission&&['completed','cancelled'].includes(i.nativeSubmission.deliveryPhase)
    &&Date.parse(i.scheduledAt)>Date.parse(i.lastRunAt));
  const migrated=expected.map(i=>after.find(j=>j.id===i.id));
  assert.ok(migrated.every(i=>i?.nativeRunId&&!i.nativeSubmission&&i.lastRunNativeSubmission));
  await save(ops+'/api-activation.json',{passed:true,scope:'main Germany only',at:new Date().toISOString(),candidate:s.candidate,corePidBefore:before.pid,nativeOwners:owners,nativeOwnersRestarted:false,
   preservedActiveInputs:switched.preserved,sourceInputsResent:false,disabledSchedulesPreserved:disabled.map(i=>i.id),migratedSchedules:migrated.map(i=>({id:i.id,nextAt:i.scheduledAt,nativeRunId:i.nativeRunId,previousTurnId:i.lastRunNativeSubmission.turnId})),transaction:switched.result});
  console.log(JSON.stringify({passed:true,apiInstalled:true,activeInputsPreserved:switched.preserved.length,disabledSchedulesPreserved:disabled.length,migratedSchedules:migrated.length}));
 }finally{if(lease)try{const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
}else if(process.argv[2]==='ui'){
 assert.equal((await json(ops+'/api-activation.json')).passed,true);
 assert.equal(await fs.realpath(root+'/dist'),s.candidate+'/dist');
 await save(ops+'/live-save.json',{passed:true,source:s.source,readOnly:true,browserVerification:'Isolated Chromium preview passed; live startup measurement follows activation.'});
 run('flock',['-n','/run/code-ai-ui-deployment.lock',process.execPath,'--dns-result-order=ipv6first',root+'/ops/work-mode-save-20261020/publish.mjs','activate'],{env:{...process.env,PM2_HOME:'/root/.pm2',CODE_AI_UI_RELEASE_OPS:ops}});
 await fs.rename(ops+'/final-receipt.json',ops+'/ui-activation.json');
 console.log(JSON.stringify({passed:true,uiInstalled:true}));
}else throw Error('api or ui required');
