/** Durable one-time disruptive replacement; only explicit owner request can arm.
 * Never resends input; stops only our waiting rollout workers before taking custody.
 */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {idleTransaction} from './idle-contract.mjs';import {stopBudgetMs,waitOwnerStopped} from './owner-stop-contract.mjs';
import {maintenanceRetirementSafe,authorizedReplacement} from './forced-owner-contract.mjs';
const file=process.argv[2],r=JSON.parse(await fs.readFile(file,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(r.forceInterruption,true);assert.equal(r.ownerAuthorizedInterruption,true);
const source=await fs.readFile(new URL('./activate-owner-idle.mjs',import.meta.url),'utf8');assert.equal(hash(source),r.helperSha256);
const helpers=source.slice(source.indexOf('const [file]'),source.indexOf('\ntry{\n const completed='));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const worker=await new AsyncFunction('assert','fs','path','execFileSync','createHash','idleTransaction','stopBudgetMs','waitOwnerStopped','process',helpers+'\nreturn {census,freeze,thaw,replace,corePid,identity,status};')(assert,fs,path,execFileSync,createHash,idleTransaction,stopBudgetMs,waitOwnerStopped,process);
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:60000}).trim(),ctl=args=>run('systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),...args]);
const json=async f=>JSON.parse(await fs.readFile(f,'utf8')),sleep=ms=>new Promise(y=>setTimeout(y,ms));
async function state(pid){const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[0];}
async function selfIdle(){
 if(r.id!=='main')return true;
 const {readManagedNativeHistory}=await import(pathToFileURL(r.candidate+'/server/codexQueuedRecovery.mjs'));
 const result=await readManagedNativeHistory({codexHome:r.maintenanceHome,method:'thread/read',params:{threadId:r.maintenanceThreadId,includeTurns:false}});
 return result.thread?.status?.type==='idle';
}
async function retire(){
 for(const m of r.retireWorkers){
  const pid=Number(ctl(['show',m.unit,'-p','MainPID','--value']));if(!pid)continue;
  const exec=ctl(['show',m.unit,'-p','ExecStart','--value']);assert.ok(exec.includes(m.opsDirectory+'/activate-owner-idle.mjs'));
  const generation=await worker.identity(pid);ctl(['kill','--kill-whom=all','--signal=SIGSTOP',m.unit]);let stopped=false;
  try{
   assert.equal(await worker.identity(pid),generation);assert.equal(await state(pid),'T');
   const previous=await json(m.statusFile),owners=[];
   for(const p of r.ownerUpdates){const o=await json(p.ownerDirectory+'/ownership.json');owners.push({unitActive:ctl(['show','code-ai-native-owner-'+p.id+'.service','-p','ActiveState','--value']),runnerState:await state(o.runnerPid),nativeState:await state(o.nativePid)});}
   const jobs=ctl(['list-jobs','--no-legend']).split('\n').filter(line=>r.ownerUpdates.some(p=>line.includes('code-ai-native-owner-'+p.id+'.service')));
   if(!maintenanceRetirementSafe({phase:previous.phase,coreState:await state(worker.corePid()),owners,ownerJobs:jobs}))return false;
   ctl(['stop','--no-block',m.unit]);ctl(['kill','--kill-whom=all','--signal=SIGCONT',m.unit]);stopped=true;
   const deadline=Date.now()+10000;while(Number(ctl(['show',m.unit,'-p','MainPID','--value']))>0){assert.ok(Date.now()<deadline,'maintenance_stop_timeout');await sleep(100);}
   ctl(['disable',m.unit]);
  }finally{if(!stopped)try{ctl(['kill','--kill-whom=all','--signal=SIGCONT',m.unit]);}catch{}}
 }
 return true;
}
async function checkpointAndReplace(fence,current){
 const checkpoints=[];
 for(const p of r.ownerUpdates){
  const args=[r.nodeExecutable,r.hostOpsDirectory+'/native-authorized-interrupt.mjs',r.candidate,p.codexHome];
  const output=process.getuid()===p.uid?run(args[0],args.slice(1)):run('/usr/sbin/runuser',['-u',p.username,'--',...args]);
  const proof=JSON.parse(output);assert.equal(proof.inputsResent,false);checkpoints.push({profileId:p.id,...proof});
 }
 await fs.writeFile(r.hostOpsDirectory+'/native-interruption-checkpoints.json',JSON.stringify({observedAt:new Date().toISOString(),ownerAuthorizedInterruption:true,checkpoints},null,2),{mode:0o600});
 current=await worker.census();return worker.replace(fence,current);
}
try{
 for(;;){
  if(!await selfIdle()){await worker.status('waiting-for-maintenance-turn-end',{installed:false,ownerAuthorizedInterruption:true});await sleep(5000);continue;}
  if(!await retire()){await worker.status('waiting-for-prior-worker-transaction',{installed:false});await sleep(5000);continue;}
  const result=await authorizedReplacement({authorized:true,...worker,replace:checkpointAndReplace,selfIdle});
  if(result.applied){
   const verified=JSON.parse(run(r.nodeExecutable,[r.hostOpsDirectory+'/verify-installed-host.mjs',r.requestFile]));assert.equal(verified.live,true);assert.equal(verified.buildId,r.buildId);
   let mail=null;
   if(r.id==='main'){
    const {readManagedNativeHistory}=await import(pathToFileURL(r.candidate+'/server/codexQueuedRecovery.mjs'));
    const p=await readManagedNativeHistory({codexHome:'/home/developer/.codex',method:'thread/items/list',params:{threadId:'01a11590-d7e3-7191-9a84-b92cd21d47c9',turnId:'01a129ef-5fbc-7e23-a7b5-7ccd0c33a80a',limit:1,sortDirection:'asc'}});
    assert.equal(p.data[0]?.item?.clientId,'code-ai:852579e9-e2dd-4c70-b3fb-62152d802cee');assert.equal(p.data[0]?.item?.content?.filter(i=>i.type==='image').length,10);
    mail={exactStableInputVerified:true,imageCount:10,historyReadableAfterOwnerReplacement:true,inputResent:false};
   }
   await worker.status('complete',{installed:true,ownerAuthorizedInterruption:true,liveReadback:verified,mail,inputsResent:false,credentialRotation:false,scheduledJobsCancelled:false});
   console.log(JSON.stringify({installed:true,buildId:r.buildId,ownerAuthorizedInterruption:true}));break;
  }
  await worker.status('waiting-for-maintenance-turn-end',{installed:false,ownerAuthorizedInterruption:true});await sleep(5000);
 }
}catch{await worker.status('failed',{installed:false,reason:'authorized_owner_replacement_failed',inputsResent:false});process.exitCode=1;}
