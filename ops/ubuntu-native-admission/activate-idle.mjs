/** Ubuntu only. A durable idle gate; no credentials/config values in output. */
import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';
import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{createRequire}from'node:module';
import{pathToFileURL}from'node:url';import{isIdle,idleTransaction}from'./idle-contract.mjs';
const[rFile]=process.argv.slice(2),r=JSON.parse(await fs.readFile(rFile,'utf8'));
assert.equal(r.id,'ubuntu-gpu-lab');assert.equal(process.getuid(),1000);
const core='code-ai-ubuntu-agent.service',owner='code-ai-native-owner-ubuntu-refael.service';
const ownerDir='/home/refael/code-ai-native-owner',planFile=ownerDir+'/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';
const queueFile='/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json';
const hash=b=>createHash('sha256').update(b).digest('hex'),sleep=ms=>new Promise(y=>setTimeout(y,ms));
const run=(p,a)=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:180000,cwd:r.candidate}).trim();
const ctl=a=>run('systemctl',['--user',...a]);
const W=createRequire(r.candidate+'/package.json')('ws');
const{parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(r.candidate+'/runtime-auth.mjs'));
const statusFile=r.candidate+'/idle-activation-status.json';
async function status(phase,extra={}){await fs.writeFile(statusFile,JSON.stringify({format:'code-ai-ubuntu-idle-activation',version:1,buildId:r.buildId,phase,observedAt:new Date().toISOString(),...extra},null,2),{mode:0o600});}
async function json(file,missing){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&missing!==undefined)return missing;throw e;}}
async function generation(pid){assert.ok(Number.isInteger(pid)&&pid>1);let s=await fs.readFile('/proc/'+pid+'/status','utf8');assert.equal(Number(/^Uid:\s+(\d+)/m.exec(s)?.[1]),1000);
 let t=await fs.readFile('/proc/'+pid+'/stat','utf8');return t.slice(t.lastIndexOf(')')+2).trim().split(/\s+/)[19];}
async function census(){
 let w=new W('ws+unix://'+ownerDir+'/engine.sock:/',{handshakeTimeout:3000,maxPayload:8*1024*1024}),n=0,p=new Map();
 const rpc=(method,params)=>new Promise((y,x)=>{let id=++n,t=setTimeout(()=>{p.delete(id);x(Error('census_timeout'));},5000);p.set(id,{y,x,t});w.send(JSON.stringify({id,method,params}));});
 w.on('error',()=>{});w.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}let v=p.get(f.id);if(!v)return;p.delete(f.id);clearTimeout(v.t);f.error?v.x(Error('census_refused')):v.y(f.result);});
 try{await new Promise((y,x)=>{w.once('open',y);w.once('error',x);});let init=await rpc('initialize',{clientInfo:{name:'code-ai-idle-release-gate',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.codexHome,'/home/refael/.codex');w.send(JSON.stringify({method:'initialized',params:{}}));
  let l=await rpc('thread/loaded/list',{});assert.ok(Array.isArray(l.data));assert.ok(!l.nextCursor);let threads=[];
  for(let id of l.data){let t=await rpc('thread/read',{threadId:id,includeTurns:false}),q=await rpc('thread/queue/list',{threadId:id,limit:100}),g=await rpc('thread/goal/get',{threadId:id});
   assert.ok(Array.isArray(q.data));assert.ok(!q.nextCursor);assert.ok(Object.hasOwn(g,'goal'));
   threads.push({status:t.thread.status.type,queued:q.data.length,activeGoal:!!g.goal&&!['complete','completed','paused','blocked'].includes(g.goal.status)});
  }
  const state=await json(queueFile),j=await json(ownerDir+'/broker-journal.json',{records:[]});assert.ok(Array.isArray(state.items)&&Array.isArray(j.records));
  return{threads,queue:state.items.map(i=>({status:i.status})),journal:j.records.map(j=>({phase:j.phase,turnComplete:j.turnComplete}))};
 }finally{w.terminate();for(let v of p.values()){clearTimeout(v.t);v.x(Error('census_closed'));}}
}
async function thaw(records){for(let rec of records)try{if(await generation(rec.pid)===rec.generation)process.kill(rec.pid,'SIGCONT');}catch{}}
async function freeze(expectedSha=r.oldBrokerSha256){let records=[];try{
 const o=await json(ownerDir+'/ownership.json');assert.equal(o.brokerModuleSha256,expectedSha);assert.equal(await generation(o.runnerPid),o.runnerIdentity.startTime);
 const group=ctl(['show',core,'-p','ControlGroup','--value']);assert.ok(group.startsWith('/user.slice/'));
 const pids=(await fs.readFile('/sys/fs/cgroup'+group+'/cgroup.procs','utf8')).trim().split(/\s+/).map(Number);assert.ok(pids.length&&pids.length<30);
 for(const pid of [o.runnerPid,...pids]){assert.notEqual(pid,o.nativePid);const gen=await generation(pid);records.push({pid,generation:gen});process.kill(pid,'SIGSTOP');}
 return records;
 }catch(e){await thaw(records);throw e;}}
async function environment(pid){let e=parseRuntimeEnvironment(await fs.readFile('/proc/'+pid+'/environ'));e.CODE_AI_AUTH_BASELINE_MODULE=r.authenticationBaselineModule;e.CODE_AI_AUTH_BASELINE_SHA256=r.authenticationBaselineSha256;await preserveRuntimeAuthentication(e);return e;}
async function waitState(unit,expected,ms=30000){let end=Date.now()+ms;do{if(ctl(['show',unit,'-p','ActiveState','--value'])===expected)return;await sleep(150);}while(Date.now()<end);throw Error('unit_state_timeout');}
async function ownerReady(brokerHash){let end=Date.now()+20000;do{try{let o=await json(ownerDir+'/ownership.json'),v=await json(ownerDir+'/ready.json');if(v.brokerModuleSha256===brokerHash&&o.brokerModuleSha256===brokerHash&&await generation(o.nativePid)===o.nativeIdentity.startTime)return o;}catch{}await sleep(200);}while(Date.now()<end);throw Error('owner_readiness_timeout');}
async function replace(frozen){
 assert.equal(ctl(['show',core,'-p','WorkingDirectory','--value']),r.baseline);
 const oldPid=Number(ctl(['show',core,'-p','MainPID','--value'])),before=await environment(oldPid),fixed=[r.environmentFile,r.pairingFile].filter(Boolean),bytes=await Promise.all(fixed.map(f=>fs.readFile(f)));
 const oldPlan=await fs.readFile(planFile),plan=JSON.parse(oldPlan);assert.equal(hash(oldPlan),r.planSha256);assert.equal(plan.brokerModuleSha256,r.oldBrokerSha256);
 assert.equal(hash(await fs.readFile(r.candidate+'/server/codexSharedOwnerBroker.mjs')),r.newBrokerSha256);
 const newPlan={...plan,brokerModule:r.candidate+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:r.newBrokerSha256};
 const oldNative=await json(ownerDir+'/ownership.json');let stopped=false,changed=false;
 try{
  await fs.writeFile(r.candidate+'/predecessor-owner-plan.json',oldPlan,{mode:0o600,flag:'wx'});
  ctl(['stop','--no-block',core,owner]);stopped=true;
  // systemd has enqueued stop jobs; resume only fenced original generations.
  await thaw(frozen);await waitState(core,'inactive');await waitState(owner,'inactive');
  const tmp=planFile+'.admission-'+r.buildId;await fs.writeFile(tmp,JSON.stringify(newPlan,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,planFile);changed=true;
  ctl(['start',owner]);const custody=await ownerReady(r.newBrokerSha256);assert.notEqual(custody.nativePid,oldNative.nativePid);
  run(r.nodeExecutable,[r.candidate+'/install.mjs','activate',rFile]);const receipt=await json(r.candidate+'/activation-receipt.json');assert.equal(receipt.installed,true);
  const pid=Number(ctl(['show',core,'-p','MainPID','--value'])),after=await environment(pid);assert.notEqual(pid,oldPid);
  for(const k of ['CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET','DATABASE_URL','CODEX_REMOTE_AGENT_TOKEN'])assert.equal(after[k],before[k]);
  for(let i=0;i<fixed.length;i++)assert.ok(bytes[i].equals(await fs.readFile(fixed[i])));
  assert.equal(after.CODE_AI_CODEX_SHARED_OWNER_PROFILES,r.sharedProfiles);
  const proof={...receipt,mainPidBefore:oldPid,mainPidAfter:pid,credentialConfigurationBytePreserved:true,originalPairingAndEnvironmentFilesBytePreserved:true,
   sharedOwnerEnabled:true,brokerModuleSha256:r.newBrokerSha256,nativePidBefore:oldNative.nativePid,nativePidAfter:custody.nativePid,
   nativeOwnerReplacedOnlyAtProvenIdle:true,failedMessageAutomaticallyResent:false,credentialRotation:false,verifiedAt:new Date().toISOString()};
  await fs.writeFile(r.candidate+'/verified-activation-receipt.json',JSON.stringify(proof,null,2),{mode:0o600});return proof;
 }catch(e){
  // Never kill newly admitted work to roll back. Preserve it and flag intervention.
  let safe=false;
  const restore=async(fence=[])=>{ctl(['stop','--no-block',owner]);await thaw(fence);await waitState(owner,'inactive');if(changed){const tmp=planFile+'.rollback-'+r.buildId;await fs.writeFile(tmp,oldPlan,{mode:0o600,flag:'wx'});await fs.rename(tmp,planFile);}ctl(['start',owner]);await ownerReady(r.oldBrokerSha256);if(ctl(['show',core,'-p','ActiveState','--value'])!=='active')ctl(['start',core]);};
  if(stopped){if(ctl(['show',owner,'-p','ActiveState','--value'])==='inactive'){await restore();safe=true;}
   else{const rollback=await idleTransaction({census,freeze:()=>freeze(changed?r.newBrokerSha256:r.oldBrokerSha256),thaw,replace:restore});safe=rollback.applied;}}
  await status('failed',{rollbackOwnerRestored:stopped&&safe,activeSuccessorWorkPreserved:!safe,reason:'activation_gate_failed'});throw Error('activation_gate_failed');
 }
}
try{
 const existing=await json(statusFile,{});
 if(existing.phase==='complete'){
  assert.equal(ctl(['show',core,'-p','WorkingDirectory','--value']),r.candidate);
  await ownerReady(r.newBrokerSha256);process.exit(0);
 }
 run(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',rFile]);
 for(;;){let result=await idleTransaction({census,freeze,thaw,replace});
  if(result.applied){await status('complete',{installed:true,brokerModuleSha256:r.newBrokerSha256});console.log(JSON.stringify({installed:true,buildId:r.buildId,idleGateVerified:true}));break;}
  await status('waiting-for-idle',{installed:false,reason:result.reason});await sleep(15000);
 }
}catch{let last=await json(statusFile,{});if(last.phase!=='failed')await status('failed',{installed:false,reason:'idle_activation_failed'});process.exitCode=1;}
