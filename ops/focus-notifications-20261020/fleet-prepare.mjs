import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';

const source='/mnt/hdd/code-ai-builds/mode-runtime-20261020-f448c9677666';
const release=JSON.parse(await fs.readFile(source+'/release.json','utf8'));
const manifest=JSON.parse(await fs.readFile(source+'/release-files.json','utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const targets={
 'beam-10g':{ssh:'beam-10g',node:'/opt/node-v24.18.0-linux-x64/bin/node',root:'/opt/code-ai-releases',service:'code-ai-remote-beam-10g.service'},
 pci:{ssh:'code-ai-pci-host',node:'/srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node',root:'/srv/beam254/code-ai-native/releases',service:'code-ai-remote-pci.service'},
};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const sshArgs=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8'];
function ssh(target,script){execFileSync(process.execPath,['--input-type=module','--check'],{input:script});return execFileSync('ssh',[...sshArgs,target.ssh,'sudo -n '+quote(target.node)+' --input-type=module -'],{input:script,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024}).trim();}
const [phase,id]=process.argv.slice(2);const target=targets[id];assert.ok(target);
const candidate=target.root+'/'+release.version;
const reportFile=path.resolve('ops/focus-notifications-20261020/'+id+'-prepare.json');
if(phase==='prepare'){
 for(const [name,digest]of Object.entries(manifest.files)){
  assert.ok(!path.isAbsolute(name)&&!name.split('/').includes('..'));
  assert.equal(hash(await fs.readFile(source+'/'+name)),digest,'Qualified source changed: '+name);
 }
 const before=JSON.parse(ssh(target,`
  import fs from 'node:fs/promises';import {execFileSync}from'node:child_process';
  const ctl=(...a)=>execFileSync('systemctl',a,{encoding:'utf8'}).trim();
  const baseline=ctl('show',${JSON.stringify(target.service)},'-p','WorkingDirectory','--value');
  const req=JSON.parse(await fs.readFile(baseline+'/fleet-request.json','utf8'));
  const candidate=${JSON.stringify(candidate)};
  let staged=false;
  try{await fs.access(candidate);const manifest=JSON.parse(await fs.readFile(candidate+'/release-files.json','utf8'));if(JSON.stringify(manifest)!==${JSON.stringify(JSON.stringify(manifest))})throw Error('Existing candidate is not this artifact');await fs.access(candidate+'/fleet-request.json').then(()=>{throw Error('Existing request requires reconciliation')},e=>{if(e.code!=='ENOENT')throw e});staged=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!staged)await fs.mkdir(candidate,{mode:0o755});
  console.log(JSON.stringify({baseline,staged,nodeExecutable:req.nodeExecutable,mainPid:Number(ctl('show',${JSON.stringify(target.service)},'-p','MainPID','--value'))}));`));
 if(!before.staged){
 const files=[...Object.keys(manifest.files),'release-files.json'];
 const tar=spawn('tar',['-C',source,'--null','-T','-','-czf','-'],{stdio:['pipe','pipe','pipe']});
 const transfer=spawn('ssh',[...sshArgs,target.ssh,'sudo -n tar -xzf - -C '+quote(candidate)],{stdio:['pipe','pipe','pipe']});
 let errors='';tar.stderr.on('data',b=>errors+=b);transfer.stderr.on('data',b=>errors+=b);
 tar.stdout.pipe(transfer.stdin);tar.stdin.end(files.join('\0')+'\0');
 const done=proc=>new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',code=>code===0?resolve():reject(Error('Artifact transfer failed '+code+' '+errors)));});
 await Promise.all([done(tar),done(transfer)]);
 }
 const prepared=JSON.parse(ssh(target,`
  import fs from 'node:fs/promises';import {createHash,randomUUID}from'node:crypto';import {execFileSync}from'node:child_process';
  const baseline=${JSON.stringify(before.baseline)},candidate=${JSON.stringify(candidate)};
  const req=JSON.parse(await fs.readFile(baseline+'/fleet-request.json','utf8'));
  const sha=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
  await fs.symlink(await fs.realpath(baseline+'/node_modules'),candidate+'/node_modules');
  try{await fs.copyFile(baseline+'/.remote-agent.env',candidate+'/.remote-agent.env',1);await fs.chmod(candidate+'/.remote-agent.env',0o600)}catch(e){if(e.code!=='ENOENT')throw e;}
  Object.assign(req,{id:${JSON.stringify(id)},baseline,candidate,buildId:randomUUID(),releaseOrder:String(Date.now()),attemptId:'fleet-20261020-'+randomUUID(),ownerAuthorizedInterruption:true,
    expectedBaselineSha256:await sha(baseline+'/dist/server.js'),expectedServerSha256:await sha(candidate+'/dist/server.js'),expectedAppSha256:await sha(candidate+'/dist/app.mjs')});
  await fs.writeFile(candidate+'/fleet-request.json',JSON.stringify(req,null,2)+'\\n',{mode:0o600,flag:'wx'});
  const output=execFileSync(req.nodeExecutable,[candidate+'/install.mjs','preflight',candidate+'/fleet-request.json'],{encoding:'utf8',cwd:candidate,timeout:120000});
  console.log(JSON.stringify({id:${JSON.stringify(id)},baseline,candidate,nodeExecutable:req.nodeExecutable,expectedVersion:${JSON.stringify(release.version)},preflight:JSON.parse(output),preparedAt:new Date().toISOString()}));`));
 await fs.writeFile(reportFile,JSON.stringify({...prepared,before},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(prepared));
}else if(phase==='activate'||phase==='reactivate'){
 const prepared=JSON.parse(await fs.readFile(reportFile,'utf8'));assert.equal(prepared.candidate,candidate);
 const verifier=await fs.readFile('/home/developer/.codex/skills/live-production-deployment/scripts/verify-release-candidate.mjs','utf8');
 const gate=JSON.parse(ssh(target,`
  import {execFileSync}from'node:child_process';
  console.log(execFileSync(${JSON.stringify(prepared.nodeExecutable)},['--input-type=module','-','--candidate',${JSON.stringify(candidate)},'--active',${JSON.stringify(prepared.baseline)},'--require','package.json','--require','dist/server.js','--require','dist/app.mjs','--require','dist/codex-shared-stdio.mjs'],{input:${JSON.stringify(verifier)},encoding:'utf8'}));`));
 assert.equal(gate.ok,true);
 const receipt=JSON.parse(ssh(target,`
  import fs from'node:fs/promises';import {execFileSync}from'node:child_process';
  const candidate=${JSON.stringify(candidate)};const req=JSON.parse(await fs.readFile(candidate+'/fleet-request.json','utf8'));
  const output=execFileSync(req.nodeExecutable,[candidate+'/install.mjs','activate',candidate+'/fleet-request.json'],{encoding:'utf8',cwd:candidate,timeout:150000});console.log(output);`));
 await fs.writeFile(path.resolve('ops/focus-notifications-20261020/'+id+'-'+(phase==='reactivate'?'reactivation':'activation')+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
}else throw Error('Expected prepare or activate');
