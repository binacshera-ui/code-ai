/** Replace only transport/owner at proven idle. App code was switched separately.
 * Active native turns, goals, queued native input and background terminals block.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {idleTransaction} from './idle-contract.mjs';
import {stopBudgetMs,waitOwnerStopped} from './owner-stop-contract.mjs';
const [file]=process.argv.slice(2),r=JSON.parse(await fs.readFile(file,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=(p,a)=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:90000,env:{...process.env,PM2_HOME:'/root/.pm2'}}).trim();
const ctl=a=>run('systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),...a]);
const coreUnits={'beam-10g':'code-ai-remote-beam-10g.service',pci:'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'};
const queueFiles={main:'/root/projects/code-ai/.code-ai/queue/state.json','beam-10g':'/var/lib/code-ai-remote/beam-10g/queue/state.json',pci:'/var/lib/code-ai-pci/queue/state.json','ubuntu-gpu-lab':'/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json'};
const stateFile=r.hostOpsDirectory?r.hostOpsDirectory+'/status.json':r.candidate+'/owner-update-status.json',sleep=ms=>new Promise(y=>setTimeout(y,ms));
const json=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const status=async(phase,extra={})=>fs.writeFile(stateFile,JSON.stringify({buildId:r.buildId,phase,observedAt:new Date().toISOString(),...extra},null,2),{mode:0o600});
async function identity(pid){const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[19];}
function corePid(){return r.id==='main'?JSON.parse(run('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'])).find(p=>p.name==='code-ai-app').pid:Number(ctl(['show',coreUnits[r.id],'-p','MainPID','--value']));}
async function census(){
 const liveRoot=r.id==='main'?await fs.realpath('/root/projects/code-ai/dist'):await fs.realpath(ctl(['show',coreUnits[r.id],'-p','WorkingDirectory','--value']));
 assert.equal(liveRoot,r.id==='main'?r.candidate+'/dist':r.candidate,'A successor core release superseded this pending owner update');
 const observedPid=corePid(),observedGeneration=await identity(observedPid);
 const profiles=[];
 for(const p of r.ownerUpdates){
  const args=[r.nodeExecutable,(r.hostOpsDirectory||r.candidate+'/host-frame-ops')+'/owner-census.mjs',r.candidate,p.codexHome];
  const text=process.getuid()===p.uid?run(args[0],args.slice(1)):run('/usr/sbin/runuser',['-u',p.username,'--',...args]);
  const proof=JSON.parse(text);assert.equal(proof.brokerSha256,p.oldBrokerSha256);profiles.push(proof);
 }
 const queue=await json(queueFiles[r.id]).catch(e=>{if(e.code==='ENOENT')return{items:[]};throw e;});assert.ok(Array.isArray(queue.items));
 return{profiles,queue:queue.items.map(i=>({status:i.status,nativeSubmission:i.nativeSubmission||null})),corePid:observedPid,coreGeneration:observedGeneration};
}
async function thaw(fence){for(const p of fence)try{if(await identity(p.pid)===p.generation)process.kill(p.pid,'SIGCONT');}catch{}}
async function freeze(current){
 const records=[];try{
  const pid=corePid();assert.ok(pid>1);assert.equal(pid,current.corePid);const generation=await identity(pid);assert.equal(generation,current.coreGeneration);
  records.push({pid,generation});process.kill(pid,'SIGSTOP');
  // Stop only this core's descendants, never PM2's other applications.
  const descendants=new Set([pid]);const entries=await fs.readdir('/proc');
  const parents=[];for(const entry of entries.filter(e=>/^\d+$/.test(e)))try{const s=await fs.readFile('/proc/'+entry+'/status','utf8');parents.push([Number(entry),Number(/^PPid:\s+(\d+)/m.exec(s)?.[1])]);}catch{}
  for(let pass=0;pass<20;pass++){let changed=false;for(const [child,parent]of parents)if(descendants.has(parent)&&!descendants.has(child)){descendants.add(child);changed=true;}if(!changed)break;}
  assert.ok(descendants.size<256);
  const nativePids=new Set(current.profiles.map(p=>p.nativePid));
  for(const child of [...descendants].filter(p=>p!==pid)){
   assert.ok(!nativePids.has(child));try{const generation=await identity(child);records.push({pid:child,generation});process.kill(child,'SIGSTOP');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}
  }
  for(const p of current.profiles){assert.ok(!nativePids.has(p.runnerPid));assert.equal(await identity(p.runnerPid),p.runnerGeneration);records.push({pid:p.runnerPid,generation:p.runnerGeneration,role:'runner'});process.kill(p.runnerPid,'SIGSTOP');}
  return records;
 }catch(e){await thaw(records);throw e;}
}
async function ready(p,sha){const end=Date.now()+30000;do{try{const o=await json(p.ownerDirectory+'/ownership.json'),v=await json(p.ownerDirectory+'/ready.json');if(o.brokerModuleSha256===sha&&v.brokerModuleSha256===sha&&await identity(o.nativePid)===o.nativeIdentity.startTime)return o;}catch{}await sleep(200);}while(Date.now()<end);throw Error('owner_readiness_failed');}
async function replace(fence,current){
 const changes=[];
 for(const p of r.ownerUpdates){const bytes=await fs.readFile(p.planFile);assert.equal(hash(bytes),p.planSha256);const plan=JSON.parse(bytes);assert.equal(plan.brokerModuleSha256,p.oldBrokerSha256);
  const next={...plan,brokerModule:r.candidate+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:r.newBrokerSha256};
  assert.equal(hash(await fs.readFile(next.brokerModule)),r.newBrokerSha256);
  const backup=(r.hostOpsDirectory||r.candidate)+'/owner-predecessor-'+p.id+'.json';await fs.writeFile(backup,bytes,{mode:0o600,flag:'wx'});
  changes.push({p,bytes,next});
 }
 const units=changes.map(x=>'code-ai-native-owner-'+x.p.id+'.service');
 let changed=false,startAttempted=false;
 try{
  const readUnit=name=>Object.fromEntries(ctl(['show',name,'-p','ActiveState','-p','MainPID','-p','TimeoutStopUSec']).split('\n').map(s=>s.split('=')));
  const stopped=changes.map(({p})=>{const c=current.profiles.find(c=>c.home===p.codexHome);assert.ok(c);return{name:'code-ai-native-owner-'+p.id+'.service',prior:[{pid:c.runnerPid,generation:c.runnerGeneration},{pid:c.nativePid,generation:c.nativeGeneration}]};});
  const timeoutMs=Math.max(...stopped.map(u=>stopBudgetMs(readUnit(u.name).TimeoutStopUSec)));
  ctl(['stop','--no-block',...units]);
  // Only thaw runners whose stop jobs are queued; core admission remains fenced.
  await thaw(fence.filter(f=>f.role==='runner'));
  await waitOwnerStopped({units:stopped,readUnit,readFile:fs.readFile.bind(fs),sleep,timeoutMs});
  for(const {p}of changes){
   const args=[r.nodeExecutable,(r.hostOpsDirectory||r.candidate+'/host-frame-ops')+'/owner-predecessor-cleanup.mjs','lock',p.planFile,p.runnerSha256,p.artifactsSha256,p.planSha256];
   const proof=JSON.parse(process.getuid()===p.uid?run(args[0],args.slice(1)):run('/usr/sbin/runuser',['-u',p.username,'--',...args]));assert.equal(proof.predecessorRecoveryVerified,true);assert.equal(proof.nativeStarted,false);
  }
  for(const {p,next}of changes){const tmp=p.planFile+'.large-'+r.buildId;await fs.writeFile(tmp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});if(process.getuid()===0)await fs.chown(tmp,p.uid,p.gid);await fs.rename(tmp,p.planFile);}changed=true;
  startAttempted=true;ctl(['start',...units]);const proofs=[];for(const {p}of changes){const o=await ready(p,r.newBrokerSha256);proofs.push({profileId:p.id,nativePid:o.nativePid,brokerSha256:o.brokerModuleSha256});}
  await status('complete',{installed:true,nativeOwners:proofs,nativeOwnerReplacedOnlyAtProvenIdle:!r.forceInterruption,ownerAuthorizedInterruption:!!r.forceInterruption,credentialRotation:false,inputsResent:false,scheduledJobsCancelled:false});
  return proofs;
 }catch{
  if(!startAttempted){
   // No successor native generation has been started. Restore every original
   // plan (including partial writes) while core admission is still fenced.
   let rollbackVerified=false;
   try{
    for(const{p,bytes}of changes){const tmp=p.planFile+'.rollback-'+r.buildId;await fs.writeFile(tmp,bytes,{mode:0o600,flag:'wx'});if(process.getuid()===0)await fs.chown(tmp,p.uid,p.gid);await fs.rename(tmp,p.planFile);}
    ctl(['start',...units]);for(const{p}of changes)await ready(p,p.oldBrokerSha256);rollbackVerified=true;
   }catch{ /* Fail closed. Do not claim an unverified predecessor restored. */ }
   await status('failed',{installed:false,reason:'owner_prestart_failed',rollbackVerified,inputsResent:false});throw Error('owner_prestart_failed');
  }
  // Admission is still fenced, but do not assume a newly started GUI/goal idle.
  // Leave any new native generation alive; rollback needs a new idle proof.
  await status('failed',{installed:false,reason:'owner_readback_failed',plansChanged:changed,activeSuccessorNotKilled:true});throw Error('owner_readback_failed');
 }
}
try{
 const completed=await json(stateFile).catch(e=>{if(e.code==='ENOENT')return{};throw e;});
 if(completed.phase==='complete'){for(const p of r.ownerUpdates)await ready(p,r.newBrokerSha256);process.exit(0);}
 const manifest=await json(r.candidate+'/release-files.json');for(const[f,h]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(r.candidate+'/'+f)),h);
 for(;;){
  const priorActive=r.predecessorMaintenanceUnit&&Number(ctl(['show',r.predecessorMaintenanceUnit,'-p','MainPID','--value']))>0;
  if(priorActive){await status('waiting-for-prior-worker',{installed:false});await sleep(15000);continue;}
  let alreadyInstalled=true;
  for(const p of r.ownerUpdates){const o=await json(p.ownerDirectory+'/ownership.json');if(o.brokerModuleSha256!==r.newBrokerSha256)alreadyInstalled=false;}
  if(alreadyInstalled){for(const p of r.ownerUpdates)await ready(p,r.newBrokerSha256);await status('complete',{installed:true,installedByPriorWorker:true,inputsResent:false});break;}
  const result=await idleTransaction({census,freeze,thaw,replace});if(result.applied){console.log(JSON.stringify({installed:true,buildId:r.buildId}));break;}await status('waiting-for-idle',{installed:false,reason:result.reason});await sleep(15000);
 }
}catch{let previous=await json(stateFile).catch(()=>({}));if(previous.phase!=='failed')await status('failed',{installed:false,reason:'owner_idle_gate_failed'});process.exitCode=1;}
