import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
import {liveApi} from './live-api.mjs';
import {liveSmoke} from './live-smoke.mjs';
const root='/root/projects/code-ai',dir=root+'/ops/shared-defaults-fix';
const r=JSON.parse(await readFile(dir+'/staged-local.json','utf8'));
const control=root+'/.code-ai/queue/deployment-drain/controller.json';
const exec=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:180000,env:{...process.env,PM2_HOME:'/root/.pm2'},...options});
const receipt={startedAt:new Date().toISOString(),buildId:r.buildId,buildOrigin:'local',candidate:r.candidate,baseline:r.baseline,complete:false};
const save=()=>writeFile(dir+'/deployment-receipt.json',JSON.stringify(receipt,null,2));
let lease;
try{
 assert.equal(await realpath(root+'/dist'),r.baseline+'/dist');
 const before=await liveApi();
 const owners=Object.fromEntries(['developer','developer2'].map(p=>[p,exec('systemctl',['show','code-ai-native-owner-'+p+'.service','-p','MainPID','--value']).trim()]));
 const status=await requestController(control,{action:'status'});
 lease=await requestController(control,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:r.buildId,ttlMs:120000});
 for(const name of ['queue','agent','native-codex']){assert.equal(lease.participants[name].active,0);assert.equal(lease.participants[name].inFlight,0);}
 receipt.queueAdmissionFenced=true;receipt.noActiveQueueJobs=true;
 receipt.interruptionPolicy='User explicitly requested full local deployment; web service and its terminal connections restart. Native owners stay running.';
 await save();
 const output=exec(r.nodeExecutable,[root+'/ops/native-unlock-release/activate-host.mjs',r.candidate+'/deployment-request.json'],{cwd:r.candidate});
 receipt.activation=JSON.parse(output.trim());
 const current=await requestController(control,{action:'status'});
 await requestController(control,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});lease=null;
 const after=await liveApi();
 assert.ok(['CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET','DATABASE_URL','CODEX_REMOTE_AGENT_TOKEN'].every(k=>before.env[k]===after.env[k]));
 receipt.credentialsPreserved=true;
 for(const [p,pid]of Object.entries(owners))assert.equal(exec('systemctl',['show','code-ai-native-owner-'+p+'.service','-p','MainPID','--value']).trim(),pid);
 receipt.nativeOwnersNotRestarted=true;await save();
 receipt.live=await liveSmoke();receipt.complete=true;receipt.finishedAt=new Date().toISOString();await save();
 console.log(JSON.stringify({complete:true,receipt:dir+'/deployment-receipt.json',buildId:r.buildId}));
}catch(e){
 receipt.failure={message:String(e.message).slice(0,1200),code:e.code||null};await save();
 if(lease){try{const s=await requestController(control,{action:'status'});await requestController(control,{action:'release',runtimeEpoch:s.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
 console.error(JSON.stringify({complete:false,failure:receipt.failure,receipt:dir+'/deployment-receipt.json'}));process.exitCode=1;
}
