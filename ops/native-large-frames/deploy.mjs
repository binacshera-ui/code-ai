import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {requestController} from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';
const root='/root/projects/code-ai',dir=root+'/ops/native-large-frames';
const stage=JSON.parse(await readFile(dir+'/staged.json','utf8'));
const receipt={format:'code-ai-native-large-frames-release',version:1,buildId:stage.buildId,buildOrigin:'beam',startedAt:new Date().toISOString(),complete:false,
 hosts:[],windowsDeployed:false,personalChromeVerified:false,credentialRotation:false,nativeOwnerRestarted:false};
const save=async()=>{await writeFile(dir+'/final-receipt.json.tmp',JSON.stringify(receipt,null,2),{mode:0o600});await rename(dir+'/final-receipt.json.tmp',dir+'/final-receipt.json');};
const run=(p,a,options={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:240000,env:{...process.env,PM2_HOME:'/root/.pm2'},...options}).trim();
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const invoke=(r,script)=>hosts[r.id]?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+r.requestFile],{input:script}):run(r.nodeExecutable,['--input-type=module','-',r.requestFile],{input:script});
const activationModule=await readFile(root+'/ops/native-unlock-release/activate-host.mjs','utf8');
const verifier=await readFile(root+'/ops/native-unlock-release/verify-installed-host.mjs','utf8');
const handoff=await readFile(dir+'/native-handoff.mjs','utf8');
const queues={main:'/root/projects/code-ai/.code-ai/queue/state.json','beam-10g':'/var/lib/code-ai-remote/beam-10g/queue/state.json',pci:'/var/lib/code-ai-pci/queue/state.json','ubuntu-gpu-lab':'/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json'};
const activate=r=>`import fs from 'node:fs/promises';import {execFileSync}from'node:child_process';
 const handoff=await import('data:text/javascript;base64,${Buffer.from(handoff).toString('base64')}');
 const r=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
 const ctl=a=>execFileSync('/usr/bin/systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),...a],{encoding:'utf8',stdio:'pipe'}).trim();
 const services={'beam-10g':'code-ai-remote-beam-10g.service',pci:'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'};
 const pid=r.id==='main'?JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',stdio:'pipe'})).find(p=>p.name==='code-ai-app').pid:Number(ctl(['show',services[r.id],'-p','MainPID','--value']));
 let items=[];try{items=JSON.parse(await fs.readFile(${JSON.stringify(queues[r.id])},'utf8')).items||[];}catch(e){if(e.code!=='ENOENT')throw e;}
 const directory=p=>p.userHome+'/code-ai-native-owner';
 const nativeBefore=[];for(const p of r.ownerProfiles){const c=JSON.parse(await fs.readFile(directory(p)+'/ownership.json','utf8'));nativeBefore.push({home:p.codexHome,pid:c.nativePid,startTime:c.nativeIdentity.startTime});}
 const switched=await handoff.withNativeHandoff({pid,items,profiles:r.sharedProfiles.split(','),replace:async()=>{
  const output=execFileSync(r.nodeExecutable,['--input-type=module','-',r.requestFile],{input:${JSON.stringify(activationModule)},encoding:'utf8',stdio:'pipe',timeout:240000,env:process.env});return JSON.parse(output.trim());}});
 for(const n of nativeBefore){const p=r.ownerProfiles.find(p=>p.codexHome===n.home);const c=JSON.parse(await fs.readFile(directory(p)+'/ownership.json','utf8'));if(c.nativePid!==n.pid||c.nativeIdentity.startTime!==n.startTime)throw Error('Native owner generation changed');}
 await fs.writeFile(r.candidate+'/native-preserving-handoff.json',JSON.stringify({preserved:switched.preserved,suspended:switched.suspended,nativeOwnerGenerationPreserved:true}),{mode:0o600});
 console.log(JSON.stringify({installed:switched.result.installed,credentialConfigurationBytePreserved:switched.result.credentialConfigurationBytePreserved,preservedInputs:switched.preserved.length,nativeOwnerGenerationPreserved:true}));`;
const controller=root+'/.code-ai/queue/deployment-drain/controller.json';let lease,id,phase='prepared';await save();
try{
 for(const r of [...stage.targets.filter(r=>r.id!=='main'),stage.targets.find(r=>r.id==='main')]){
  id=r.id;phase='activate';
  if(r.id==='main'){
   const status=await requestController(controller,{action:'status'});
   lease=await requestController(controller,{action:'acquire',runtimeEpoch:status.runtimeEpoch,ownerToken:randomUUID(),releaseId:stage.buildId,ttlMs:120000});
   receipt.interruptionPolicy='Owner-authorized core replacement. Exact durable native inputs detached without cancellation; native owners unchanged.';
   receipt.preSwitchActiveCounts=Object.fromEntries(Object.entries(lease.participants).map(([name,p])=>[name,p.active]));
  }
  const activated=JSON.parse(invoke(r,activate(r)));assert.equal(activated.credentialConfigurationBytePreserved,true);
  phase='live-readback';const checked=JSON.parse(invoke(r,verifier));
  receipt.hosts.push({id:r.id,live:true,pid:checked.pid,profiles:checked.profiles,credentialsPreserved:true,
   nativeOwnerGenerationPreserved:true,preservedInputs:activated.preservedInputs});await save();
  if(r.id==='main'&&lease){const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});lease=null;}
 }
 phase='mail-readback';run(stage.targets.find(r=>r.id==='main').nodeExecutable,[dir+'/mail-readback.mjs']);
 receipt.mail=JSON.parse(await readFile(dir+'/mail-readback.json','utf8'));
 receipt.nativeQualification=JSON.parse(await readFile(dir+'/native-qualification.json','utf8'));
 receipt.complete=receipt.hosts.length===4&&receipt.mail.exactNativeTurnMatched&&!receipt.mail.stillQueued;
 receipt.nativeOwnerUpgradePending=true;
 receipt.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({complete:receipt.complete,receipt:dir+'/final-receipt.json'}));
}catch{
 receipt.failure={id,phase,reason:'release_gate_failed'};await save();
 if(lease){try{const current=await requestController(controller,{action:'status'});await requestController(controller,{action:'release',runtimeEpoch:current.runtimeEpoch,ownerToken:lease.ownerToken,generation:lease.generation});}catch{}}
 console.error(JSON.stringify({complete:false,id,phase,receipt:dir+'/final-receipt.json'}));process.exitCode=1;
}
