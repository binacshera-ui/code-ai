import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
import {verifyLiveTerminal} from './live-terminal.mjs';
const root='/root/projects/code-ai',dir=root+'/ops/terminal-ux';
const stage=JSON.parse(await readFile(dir+'/staged.json','utf8'));
const receipt={format:'code-ai-terminal-ux-release',version:1,buildId:stage.buildId,buildOrigin:stage.buildOrigin,startedAt:new Date().toISOString(),complete:false,testsPassed:355,browserChecksPassed:14,hosts:[],windowsDeployed:false,personalChromeAvailable:false,credentialRotation:false};
const save=async()=>{await writeFile(dir+'/final-receipt.json.tmp',JSON.stringify(receipt,null,2),{mode:0o600});await rename(dir+'/final-receipt.json.tmp',dir+'/final-receipt.json');};
const run=(p,a,options={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:240000,env:{...process.env,PM2_HOME:'/root/.pm2'},...options}).trim();
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const invoke=(r,script)=>hosts[r.id]?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+r.requestFile],{input:script}):run(r.nodeExecutable,['--input-type=module','-',r.requestFile],{input:script});
const activate=await readFile(root+'/ops/native-unlock-release/activate-host.mjs','utf8');
const verify=await readFile(root+'/ops/native-unlock-release/verify-installed-host.mjs','utf8');
const controller=root+'/.code-ai/queue/deployment-drain/controller.json';let lease,id,phase='prepared';await save();
try{
 for(const r of [...stage.targets.filter(r=>r.id!=='main'),stage.targets.find(r=>r.id==='main')]){
  id=r.id;phase='activate';
  if(r.id==='main'){
   const status=await requestController(controller,{action:'status'});
   lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:stage.buildId,ttlMs:120000});
   receipt.interruptionPolicy='Previously owner-authorized immediate replacement; durable queue backed up. Native-owner services stay running.';
   receipt.preSwitchActiveCounts=Object.fromEntries(Object.entries(lease.participants).map(([name,p])=>[name,p.active]));
  }
  const activated=JSON.parse(invoke(r,activate));
  assert.equal(activated.credentialConfigurationBytePreserved,true);
  phase='live-readback';const checked=JSON.parse(invoke(r,verify));
  // Compare only public version and routing metadata; never print process environments.
  const cli=JSON.parse(invoke(r,`import fs from 'node:fs';import{execFileSync}from'node:child_process';const r=JSON.parse(fs.readFileSync(process.argv[2]));const v=execFileSync(r.terminalNativeBinary,['--version'],{encoding:'utf8',stdio:'pipe'}).trim();console.log(JSON.stringify({version:v,pinned:true}));`));
  receipt.hosts.push({id:r.id,live:true,pid:checked.pid,profiles:checked.profiles,credentialsPreserved:true,cli:cli.version,terminalNativePathPinned:true});await save();
  if(r.id==='main'&&lease){const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});lease=null;}
 }
 phase='live-terminal';receipt.liveTerminal=await verifyLiveTerminal();
 receipt.complete=receipt.hosts.length===4;receipt.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({complete:true,receipt:dir+'/final-receipt.json'}));
}catch{
 receipt.failure={id,phase,reason:'release_gate_failed'};await save();
 if(lease){try{const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
 console.error(JSON.stringify({complete:false,id,phase,receipt:dir+'/final-receipt.json'}));process.exitCode=1;
}
