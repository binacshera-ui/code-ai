/** Main Germany only. Replace adapter/Node supervisor, adopt the SAME native PID.
 * A persistent flock, pinned custody and a one-use private ticket fence adoption.
 * Neither history/lock inodes nor native session inputs are deleted or replayed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {withNativeHandoff} from '../native-large-frames/native-handoff.mjs';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
const root='/root/projects/code-ai',ops=root+'/ops/codex-rpc-repair';
const staged=JSON.parse(await fs.readFile(ops+'/staged.json','utf8')),r=staged.request;
assert.equal(r.id,'main');assert.equal(r.sharedProfiles,'developer,developer2');
const run=(p,a,o={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:120000,env:{...process.env,PM2_HOME:'/root/.pm2'},...o});
const ctl=a=>run('/usr/bin/systemctl',a).trim(),pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
const hash=b=>createHash('sha256').update(b).digest('hex'),json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const sleep=ms=>new Promise(y=>setTimeout(y,ms));
const generation=async pid=>{const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[19];};
const main=()=>JSON.parse(run(pm2,['jlist'])).find(x=>x.name==='code-ai-app');
const attemptId=String(Date.now());
const backup=r.candidate+'/private-rpc-repair-backup/attempt-'+attemptId;await fs.mkdir(backup,{recursive:true,mode:0o700});
const receipt={format:'code-ai-codex-rpc-repair-activation',version:1,buildId:r.buildId,attemptId,backup,scope:'main Germany only',complete:false,startedAt:new Date().toISOString(),phase:'preflight'};
const save=()=>fs.writeFile(ops+'/activation.json',JSON.stringify(receipt,null,2),{mode:0o600});
const controller=root+'/.code-ai/queue/deployment-drain/controller.json';let lease=null;const migrated=[];
async function atomicOwned(filename,bytes){const s=await fs.stat(filename),tmp=filename+'.rpc-'+r.buildId;await fs.writeFile(tmp,bytes,{mode:s.mode&0o777,flag:'wx'});await fs.chown(tmp,s.uid,s.gid);await fs.rename(tmp,filename);}
async function identityPreserved(p){const o=await json(p.directory+'/ownership.json');assert.equal(o.nativePid,p.before.nativePid);assert.equal(o.nativeIdentity.startTime,p.before.nativeIdentity.startTime);assert.equal(await generation(o.nativePid),p.before.nativeIdentity.startTime);return o;}
async function adapterToReplace(p,current){
  try{if(await generation(current.runnerPid)===current.runnerIdentity.startTime)return{pid:current.runnerPid,startTime:current.runnerIdentity.startTime};}catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
  // Recover only our documented failed first adapter transaction. The live
  // writer is still pinned by its original custody. Resolve the SAME service's
  // actual lock holder, never a guessed PID or another Codex application.
  assert.ok(staged.predecessorAttempt);
  const ticket=await json(p.directory+'/broker-handoff.json'),bytes=await fs.readFile(p.directory+'/ownership.json');
  const plan=await json(p.planFile);
  assert.equal(ticket.custodySha256,hash(bytes));assert.equal(ticket.brokerModuleSha256,plan.brokerModuleSha256);
  assert.equal(plan.runnerModule,staged.predecessorAttempt+'/ops/native-owner/profile-runner.mjs');
  assert.equal(ticket.runnerModuleSha256,hash(await fs.readFile(plan.runnerModule)));
  assert.equal(await fs.lstat(current.frontendSocket).then(()=>true,()=>false),false);
  const entry=await fs.lstat(p.directory+'/owner.lock',{bigint:true}),major=(entry.dev>>8n)&0xfffn,minor=(entry.dev&0xffn)|((entry.dev>>12n)&0xffffff00n);
  const owners=(await fs.readFile('/proc/locks','utf8')).split('\n').flatMap(line=>{const a=line.trim().split(/\s+/),d=a[5]?.split(':');return a[1]==='FLOCK'&&d?.length===3&&BigInt(parseInt(d[0],16))===major&&BigInt(parseInt(d[1],16))===minor&&d[2]===entry.ino.toString()?[Number(a[4])]:[]});
  assert.equal(owners.length,1);const pid=owners[0],args=(await fs.readFile('/proc/'+pid+'/cmdline')).toString().split('\0');
  assert.ok(args.includes(plan.runnerModule)&&args.includes('--lock-held')&&args.includes(p.planFile));
  const status=await fs.readFile('/proc/'+pid+'/status','utf8');assert.equal(Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]),Number(ctl(['show',p.unit,'-p','MainPID','--value'])));
  assert.equal(hash(await fs.readFile('/proc/'+pid+'/cgroup')),current.nativeIdentity.cgroupSha256);
  assert.equal(await fs.realpath('/proc/'+pid+'/exe'),await fs.realpath(r.nodeExecutable));
  return{pid,startTime:await generation(pid),recoveringFailedAdapter:true};
}
async function handoff(p,brokerPath,brokerSha){
  const current=await identityPreserved(p),bytes=await fs.readFile(p.directory+'/ownership.json');
  const adapter=await adapterToReplace(p,current);
  const plan=await json(p.planFile);assert.equal(plan.profileId,p.id);
  assert.equal(hash(await fs.readFile(brokerPath)),brokerSha);
  const dropin=p.unitDropin;
  const unitText=(killMode,restart)=>`[Service]\nKillMode=${killMode}\nRestart=${restart}\nExecStart=\nExecStart=${r.nodeExecutable} ${r.candidate}/ops/native-owner/profile-runner.mjs ${p.planFile}\n`;
  await fs.mkdir(dropin.slice(0,dropin.lastIndexOf('/')),{recursive:true});
  await fs.writeFile(dropin,unitText('process','no'),{mode:0o644});ctl(['daemon-reload']);
  assert.equal(ctl(['show',p.unit,'-p','KillMode','--value']),'process');assert.equal(ctl(['show',p.unit,'-p','Restart','--value']),'no');
  const next={...plan,brokerModule:brokerPath,brokerModuleSha256:brokerSha,runnerModule:r.candidate+'/ops/native-owner/profile-runner.mjs'};
  const ticket=p.directory+'/broker-handoff.json';const ticketExists=await fs.lstat(ticket).then(()=>true,()=>false);assert.ok(!ticketExists||adapter.recoveringFailedAdapter);
  const s=await fs.stat(p.planFile);
  const ticketBytes=JSON.stringify({format:'code-ai-broker-handoff',version:1,custodySha256:hash(bytes),brokerModuleSha256:brokerSha,runnerModuleSha256:staged.runnerSha256});
  if(ticketExists){await fs.cp(ticket,backup+'/'+p.id+'-failed-adopter-ticket.json');await atomicOwned(ticket,ticketBytes);}
  else{await fs.writeFile(ticket,ticketBytes,{mode:0o600,flag:'wx'});await fs.chown(ticket,s.uid,s.gid);}
  // Adapter only. The native process is deliberately not signalled.
  assert.equal(await generation(adapter.pid),adapter.startTime);process.kill(adapter.pid,'SIGKILL');
  const deadline=Date.now()+15000;while(Number(ctl(['show',p.unit,'-p','MainPID','--value']))){if(Date.now()>deadline)throw Error('old_adapter_stop_timeout');await sleep(100);}
  assert.equal(await generation(current.nativePid),current.nativeIdentity.startTime);
  await atomicOwned(p.planFile,JSON.stringify(next,null,2));ctl(['start',p.unit]);
  const end=Date.now()+45000;let observed;
  do{observed=await identityPreserved(p);const ready=await json(p.directory+'/ready.json').catch(()=>({}));
    if(observed.brokerModuleSha256===brokerSha&&ready.brokerModuleSha256===brokerSha&&ctl(['is-active',p.unit])==='active')break;
    if(Date.now()>end)throw Error('adopted_owner_readiness_timeout');await sleep(100);
  }while(true);
  assert.notEqual(observed.runnerPid,current.runnerPid);assert.equal(await fs.lstat(ticket).then(()=>true,()=>false),false);
  assert.equal((await fs.lstat(p.directory+'/owner.lock')).ino,p.lockInode);
  assert.equal((await fs.lstat(p.directory+'/engine.sock')).ino,p.engineInode);
  // Native belongs to the same unit cgroup. Restore its normal lifecycle policy.
  await fs.writeFile(dropin,unitText('control-group','on-failure'),{mode:0o644});ctl(['daemon-reload']);
  assert.equal(ctl(['show',p.unit,'-p','KillMode','--value']),'control-group');
  return {profileId:p.id,nativePid:observed.nativePid,startTime:observed.nativeIdentity.startTime,brokerSha256:observed.brokerModuleSha256,writerGenerationPreserved:true,lockInodePreserved:true,engineEndpointPreserved:true};
}
try{
  assert.equal(await fs.realpath(root+'/dist'),r.baseline+'/dist');
  const qualification=await json(ops+'/native-qualification.json');assert.equal(qualification.passed,true);
  assert.equal(qualification.brokerSha256,staged.brokerSha256);assert.equal(qualification.runnerSha256,staged.runnerSha256);
  const manifest=await json(r.candidate+'/release-files.json');for(const[f,h]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(r.candidate+'/'+f)),h);
  const status=await requestController(controller,{action:'status'});lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:r.buildId,ttlMs:120000});
  const beforeMain=main(),items=(await json(root+'/.code-ai/queue/state.json')).items;
  const {parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(r.candidate+'/runtime-auth.mjs').href);
  const auth=async record=>{const env={...record.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+record.pid+'/environ')),CODE_AI_AUTH_BASELINE_MODULE:r.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:r.authenticationBaselineSha256};await preserveRuntimeAuthentication(env);return env;};
  const previous=await auth(beforeMain);
  await fs.writeFile(backup+'/main-pm2.json',JSON.stringify(beforeMain),{mode:0o600});await fs.cp(root+'/.code-ai/queue/state.json',backup+'/queue-before.json');await fs.chmod(backup+'/queue-before.json',0o600);
  const profiles=[];
  for(const id of ['developer2','developer']){
    const directory='/home/'+id+'/code-ai-native-owner',unit='code-ai-native-owner-'+id+'.service';
    const before=await json(directory+'/ownership.json');assert.equal(ctl(['is-active',unit]),'active');
    const planFile=directory+'/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';const planBytes=await fs.readFile(planFile),plan=JSON.parse(planBytes);
    if(before.brokerModuleSha256!==plan.brokerModuleSha256){assert.equal(id,'developer');assert.equal(plan.brokerModule,staged.predecessorAttempt+'/server/codexSharedOwnerBroker.mjs');}
    assert.equal(hash(await fs.readFile(plan.brokerModule)),plan.brokerModuleSha256);
    assert.ok(['control-group','process'].includes(ctl(['show',unit,'-p','KillMode','--value'])));
    for(const[f,name]of [[planFile,'plan'],[directory+'/ownership.json','custody'],[directory+'/broker-journal.json','journal']]){
      try{await fs.cp(f,backup+'/'+id+'-'+name+'.json');await fs.chmod(backup+'/'+id+'-'+name+'.json',0o600);}
      catch(error){if(name!=='journal'||error.code!=='ENOENT')throw error;}
    }
    const unitDropin='/etc/systemd/system/'+unit+'.d/99-codex-rpc-repair.conf';
    if(await fs.lstat(unitDropin).then(()=>true,()=>false)){
      const allowed=[];for(const candidate of [r.candidate,staged.predecessorAttempt].filter(Boolean))for(const[killMode,restart]of[['control-group','on-failure'],['process','no']])allowed.push(`[Service]\nKillMode=${killMode}\nRestart=${restart}\nExecStart=\nExecStart=${r.nodeExecutable} ${candidate}/ops/native-owner/profile-runner.mjs ${planFile}\n`);
      assert.ok(allowed.includes(await fs.readFile(unitDropin,'utf8')));
      await fs.cp(unitDropin,backup+'/'+id+'-unit-dropin.conf');
    }
    profiles.push({id,directory,unit,planFile,plan,planBytes,before,unitDropin,wasFailedAdapter:before.brokerModuleSha256!==plan.brokerModuleSha256,lockInode:(await fs.lstat(directory+'/owner.lock')).ino,engineInode:(await fs.lstat(directory+'/engine.sock')).ino});
  }
  const liveLease=await requestController(controller,{action:'status'});
  lease=await requestController(controller,{action:'renew',runtimeEpoch:liveLease.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation,releaseId:r.buildId,ttlMs:120000});
  const switched=await withNativeHandoff({pid:beforeMain.pid,items,profiles:r.sharedProfiles.split(','),replace:async()=>{
    const owners=[];
    try{
      // The controller belongs to the suspended core. Never call it inside
      // this bounded handoff; acquire/renew before fencing and release after.
      for(const p of profiles){receipt.phase='adapter-'+p.id;await save();owners.push(await handoff(p,r.candidate+'/server/codexSharedOwnerBroker.mjs',staged.brokerSha256));migrated.push(p);}
      receipt.phase='core-install';await save();
      const result=JSON.parse(run(r.nodeExecutable,[r.candidate+'/install.mjs','activate',r.requestFile],{cwd:r.candidate}).trim());assert.equal(result.installed,true);return{...result,owners};
    }catch(error){
      let rollback=true;for(const p of [...migrated].reverse()){
        if(p.wasFailedAdapter){receipt.restoredWorkingAdapterNotRolledBackToFailedStartup=true;continue;}
        try{await handoff(p,p.plan.brokerModule,p.plan.brokerModuleSha256);}catch{rollback=false;}
      }
      receipt.adapterRollbackVerified=rollback;throw error;
    }
  }});
  assert.equal(await fs.realpath(root+'/dist'),r.candidate+'/dist');const afterMain=main();assert.equal(afterMain.pm2_env.status,'online');
  const next=await auth(afterMain);assert.ok(['CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET','DATABASE_URL','CODEX_REMOTE_AGENT_TOKEN'].every(k=>previous[k]===next[k]));
  const afterItems=(await json(root+'/.code-ai/queue/state.json')).items;for(const i of switched.preserved){const a=afterItems.find(x=>x.id===i.id);assert.ok(a);assert.equal(a.sessionId,i.sessionId);if(a.nativeSubmission)assert.equal(a.nativeSubmission.clientUserMessageId,i.clientId);}
  Object.assign(receipt,{complete:true,finishedAt:new Date().toISOString(),activeRelease:r.candidate,corePidBefore:beforeMain.pid,corePidAfter:afterMain.pid,owners:switched.result.owners,preservedInputIds:switched.preserved.map(x=>x.id),credentialsBytePreserved:true,inputsResent:false,nativeWritersRestarted:false,otherServersModified:false});
  await save();console.log(JSON.stringify({complete:true,buildId:r.buildId,nativeWritersPreserved:true,preservedActiveInputs:switched.preserved.length}));
}catch(error){Object.assign(receipt,{complete:false,failedAt:new Date().toISOString(),errorClass:error.name,errorCode:/^[A-Z_0-9]+$/.test(error.code||'')?error.code:'ACTIVATION_GATE_FAILED',controllerReason:/^[a-z_]{1,80}$/.test(error.reason||'')?error.reason:null});await save();process.exitCode=1;
}finally{if(lease)try{const status=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:status.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
