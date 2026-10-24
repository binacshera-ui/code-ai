import fs from 'node:fs/promises';import {execFileSync}from'node:child_process';
const dir='/root/projects/code-ai/ops/native-large-frames',s=JSON.parse(await fs.readFile(dir+'/staged.json','utf8'));
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const coreUnits={'beam-10g':'code-ai-remote-beam-10g.service',pci:'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'};
const rows=[];
const scheduled=JSON.parse(await fs.readFile(dir+'/owner-upgrades-scheduled.json','utf8'));
const authorized=JSON.parse(await fs.readFile(dir+'/authorized-owner-replacement.json','utf8').catch(e=>{if(e.code==='ENOENT')return'{"units":[]}';throw e;}));
for(const r of s.targets){
 const pending=authorized.units.find(u=>u.id===r.id)||scheduled.units.find(u=>u.id===r.id);
 const code=`const fs=require('fs'),cp=require('child_process'),r=${JSON.stringify({id:r.id,candidate:r.candidate,buildId:r.buildId,ownerProfiles:r.ownerProfiles,pending})};
 let status=null;try{status=JSON.parse(fs.readFileSync(r.candidate+'/owner-update-status.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let currentStatus=null;try{if(r.pending?.hostOpsDirectory)currentStatus=JSON.parse(fs.readFileSync(r.pending.hostOpsDirectory+'/status.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const ctl=(unit,fields)=>cp.execFileSync('systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),'show',unit,...fields.flatMap(f=>['-p',f])],{encoding:'utf8',stdio:'pipe'}).trim();
 const core=r.id==='main'?{pm2:JSON.parse(cp.execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'}})).filter(p=>p.name==='code-ai-app').map(p=>({pid:p.pid,status:p.pm2_env.status}))}:ctl(${JSON.stringify(coreUnits[r.id]||'')},['Requires','After','ActiveState','SubState','MainPID','Result','WorkingDirectory']);
 const owners=r.ownerProfiles.map(p=>{const c=JSON.parse(fs.readFileSync(p.userHome+'/code-ai-native-owner/ownership.json'));return{id:p.id,pid:c.nativePid,brokerSha256:c.brokerModuleSha256,state:ctl('code-ai-native-owner-'+p.id+'.service',['ActiveState','Result'])};});
 console.log(JSON.stringify({id:r.id,status:currentStatus||status,priorStatus:currentStatus?status:null,core,owners,maintenance:ctl(r.pending?.unit||'code-ai-large-frames-'+r.buildId+'.service',['LoadState','ActiveState','SubState','MainPID','UnitFileState'])}));`;
 let raw;try{raw=hosts[r.id]?execFileSync('ssh',['-o','BatchMode=yes',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:code,encoding:'utf8',stdio:'pipe',timeout:30000}):execFileSync(r.nodeExecutable,['-'],{input:code,encoding:'utf8',stdio:'pipe',timeout:30000});}catch{console.error(JSON.stringify({id:r.id,readbackFailed:true}));process.exit(1);}
 rows.push(JSON.parse(raw));
}
await fs.writeFile(dir+'/owner-status-readback.json',JSON.stringify({observedAt:new Date().toISOString(),hosts:rows},null,2),{mode:0o600});
console.log(JSON.stringify(rows));
