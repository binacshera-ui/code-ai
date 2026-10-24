/** One release, one Ubuntu. Observe reconnection, then invoke the tested idle gate. */
import assert from'node:assert/strict';import fs from'node:fs/promises';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const dir='/root/projects/code-ai/ops/ubuntu-native-admission',node='/root/.nvm/versions/node/v24.12.0/bin/node';
const pin=JSON.parse(await fs.readFile(dir+'/monitor-pin.json','utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const run=(p,a,o={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:120000,...o});
const ssh=(script)=>run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5','personal-ubuntu-ssh','/home/refael/.local/lib/node-v24.21.0-linux-x64/bin/node -'],{input:script});
const sleep=ms=>new Promise(y=>setTimeout(y,ms));
const status=async(phase,details={})=>fs.writeFile(dir+'/automatic-deployment-status.json',JSON.stringify({buildId:pin.buildId,phase,observedAt:new Date().toISOString(),...details},null,2),{mode:0o600});
try{
 for(const[f,h]of Object.entries(pin.scripts))assert.equal(hash(await fs.readFile(dir+'/'+f)),h);
 for(;;){let online=false;try{let s=JSON.parse(ssh('console.log(JSON.stringify({hostname:require("os").hostname(),uid:process.getuid()}))'));assert.equal(s.hostname,'gpu-lab');assert.equal(s.uid,1000);online=true;}catch{}
  if(!online){await status('waiting-for-ubuntu-tunnel',{installed:false,loopbackPort:44023});await sleep(15000);continue;}
  let staged;try{staged=JSON.parse(await fs.readFile(dir+'/staged.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;run(node,[dir+'/stage.mjs']);staged=JSON.parse(await fs.readFile(dir+'/staged.json','utf8'));}
  assert.equal(staged.buildId,pin.buildId);const r=staged.target;
  const unit='code-ai-ubuntu-admission-'+pin.buildId+'.service';
  // After orders startup only. Requires would kill this transaction when it
  // intentionally stops the predecessor services at the proven idle point.
  const unitText='[Unit]\nDescription=Qualified Code AI Ubuntu permission-profile update at idle\nAfter=code-ai-native-owner-ubuntu-refael.service code-ai-ubuntu-agent.service\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart='+r.nodeExecutable+' '+r.candidate+'/host-admission-ops/activate-idle.mjs '+r.requestFile+'\nTimeoutStartSec=infinity\nRemainAfterExit=yes\n\n[Install]\nWantedBy=default.target\n';
  ssh(`let fs=require('fs'),cp=require('child_process'),d='/home/refael/.config/systemd/user/',f=d+${JSON.stringify(unit)},text=${JSON.stringify(unitText)};fs.mkdirSync(d,{recursive:true});if(fs.existsSync(f)){if(fs.readFileSync(f,'utf8')!==text)throw Error('unit_drift');}else fs.writeFileSync(f,text,{mode:0o600,flag:'wx'});cp.execFileSync('systemctl',['--user','daemon-reload']);cp.execFileSync('systemctl',['--user','enable',${JSON.stringify(unit)}],{stdio:'pipe'});cp.execFileSync('systemctl',['--user','start','--no-block',${JSON.stringify(unit)}]);console.log(JSON.stringify({idleGateScheduled:true}));`);
  await status('ubuntu-idle-gate-scheduled',{installed:false,unit});
  for(;;){let current;try{current=JSON.parse(ssh(`let fs=require('fs');console.log(fs.readFileSync(${JSON.stringify(r.candidate+'/idle-activation-status.json')},'utf8'));`));}catch{await sleep(15000);continue;}
   await status(current.phase,{installed:current.phase==='complete',remoteStatus:current});
   if(current.phase==='failed')throw Error('remote_idle_gate_failed');
   if(current.phase==='complete'){
    const verified=JSON.parse(ssh(`let cp=require('child_process');console.log(cp.execFileSync(${JSON.stringify(r.nodeExecutable)},[${JSON.stringify(r.candidate+'/host-admission-ops/verify-installed-host.mjs')},${JSON.stringify(r.requestFile)}],{encoding:'utf8',stdio:'pipe'}));`));assert.equal(verified.live,true);
    const receipt=JSON.parse(ssh(`console.log(require('fs').readFileSync(${JSON.stringify(r.candidate+'/verified-activation-receipt.json')},'utf8'));`));
    await fs.writeFile(dir+'/final-receipt.json',JSON.stringify({format:'code-ai-ubuntu-admission-final',version:1,buildId:pin.buildId,installed:true,verified,receipt},null,2),{mode:0o600});await status('complete',{installed:true,verified});process.exit(0);
   }await sleep(15000);
  }
 }
}catch{await status('failed',{installed:false,reason:'automatic_deployment_gate_failed'});process.exitCode=1;}
