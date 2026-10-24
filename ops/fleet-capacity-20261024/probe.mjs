import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fleetClient} from '../focus-notifications-20261020/fleet-live.mjs';
const run=promisify(execFile),ops='/root/projects/code-ai/ops/fleet-capacity-20261024';
const api=await fleetClient();
const targets=[
 {id:'pci',alias:'code-ai-pci-host',node:'/srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node',service:'code-ai-remote-pci.service',queue:'/var/lib/code-ai-pci/queue/state.json'},
 {id:'beam-10g',alias:'beam-10g',node:'/opt/node-v24.18.0-linux-x64/bin/node',service:'code-ai-remote-beam-10g.service',queue:'/var/lib/code-ai-remote/beam-10g/queue/state.json'},
 {id:'personal-windows-me',alias:'personal-windows-ssh'},
];
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const results=await Promise.all(targets.map(async target=>{
 const report={id:target.id};
 try{
  const health=await api(target.id,'/remote-agent/health');
  Object.assign(report,{controlPlaneReachable:true,version:health.version,ready:health.ready,hostname:health.hostname,
   profiles:(health.profiles||[]).map(p=>({id:p.id,provider:p.provider,mode:p.mode,codexVersion:p.codexVersion,authenticated:p.authenticated,transportReady:p.transportReady,versionMatched:p.versionMatched,nativePid:p.nativePid}))});
 }catch(error){report.controlPlaneReachable=false;report.controlPlaneError=error.message;}
 try{
  let command,input;
  if(target.service){
   input=`import fs from 'node:fs/promises';import {execFileSync}from'node:child_process';import os from'node:os';
    const service=${JSON.stringify(target.service)},ctl=(...args)=>execFileSync('systemctl',args,{encoding:'utf8'}).trim();
    const root=ctl('show',service,'-p','WorkingDirectory','--value');
    const req=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));
    const release=JSON.parse(await fs.readFile(root+'/release.json','utf8'));
    const queue=JSON.parse(await fs.readFile(${JSON.stringify(target.queue)},'utf8'));
    const space=await fs.statfs(root);
    console.log(JSON.stringify({hostname:os.hostname(),uid:process.getuid(),service,active:ctl('is-active',service),pid:Number(ctl('show',service,'-p','MainPID','--value')),root,version:release.version,
     request:{nodeExecutable:req.nodeExecutable,sharedProfiles:req.sharedProfiles,terminalNativeBinary:req.terminalNativeBinary,buildId:req.buildId},
     queueCounts:Object.fromEntries([...new Set(queue.items.map(i=>i.status))].map(s=>[s,queue.items.filter(i=>i.status===s).length])),
     activeWork:queue.items.filter(i=>['running','queued','cancelling'].includes(i.status)).map(i=>({id:i.id,profileId:i.profileId,status:i.status,phase:i.nativeSubmission?.deliveryPhase,hasSession:!!i.sessionId,correctClient:i.nativeSubmission?.clientUserMessageId==='code-ai:'+(i.nativeRunId||i.id)})),
     disk:{available:space.bavail*space.bsize,total:space.blocks*space.bsize}}));`;
   command='sudo -n '+quote(target.node)+' --input-type=module -e '+quote(input);
  }else command='hostname';
  const {stdout}=await run('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',target.alias,command],{encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024});
  report.sshReachable=true;report.ssh=target.service?JSON.parse(stdout):{hostname:stdout.trim()};
 }catch(error){report.sshReachable=false;report.sshError=String(error.stderr||error.message).slice(0,600);}
 return report;
}));
await fs.writeFile(ops+'/before.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(results,null,2));
