import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdir,symlink,realpath,chmod,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const capture=JSON.parse(await readFile(dir+'/capture.json','utf8'));
const buildId=JSON.parse(await readFile(dir+'/beam-final-accepted.json','utf8')).buildId;
const importRoot='/mnt/hdd/code-ai-builds/queued-recovery-imports';
const run=(p,a,opts={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:120000,...opts});
const imported=JSON.parse(run('bina-build',['verify-import',buildId,'--import-root',importRoot]));
assert.equal(imported.buildId,buildId);
const artifact=imported.artifact+'/dist';
assert.equal(await realpath(root+'/dist'),capture.baseline+'/dist');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(artifact+'/release-files.json','utf8'));
for(const [f,h]of Object.entries(manifest.files))assert.equal(hash(await readFile(artifact+'/'+f)),h);
assert.equal(JSON.parse(await readFile(artifact+'/qualification/terminal-browser.json','utf8')).passed,true);
assert.equal(JSON.parse(await readFile(artifact+'/qualification/queued-recovery.json','utf8')).installedEffects,false);
const installed=JSON.parse(await readFile(root+'/ops/terminal-ux/staged.json','utf8'));
const archive=capture.stage+'/queued-recovery-release.tar';run('tar',['-cf',archive,'-C',artifact,'.']);await chmod(archive,0o600);
const archiveHash=hash(await readFile(archive)),targets=[];
for(const old of installed.targets){
 const baseline=old.candidate;
 const candidate=old.id==='main'?'/mnt/hdd/code-ai-builds/queued-recovery-live-'+buildId
  :old.id==='ubuntu-gpu-lab'?'/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/queued-recovery-'+buildId
  :old.id==='pci'?'/srv/beam254/code-ai-native/releases/queued-recovery-'+buildId
  :'/opt/code-ai-releases/queued-recovery-'+buildId;
 const r={...old,buildId,baseline,candidate,buildOrigin:'beam',localBuildExplicitlyAuthorized:false,
  attemptId:'queued-recovery',releaseOrder:String(Date.now()),
  expectedBaselineSha256:old.expectedServerSha256,expectedServerSha256:manifest.files['dist/server.js'],
  expectedAppSha256:manifest.files['dist/app.mjs'],requestFile:candidate+'/deployment-request.json'};
 if(r.id==='main'){r.uploadBaselineModule=baseline+'/dist/server.js';r.uploadBaselineSha256=old.expectedServerSha256;}
 const host={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'}[r.id];
 if(host){
  const remoteArchive='/var/tmp/code-ai-queued-recovery-'+buildId+'.tar';
  run('scp',['-q','-o','BatchMode=yes','-o','ConnectTimeout=10',archive,host+':'+remoteArchive]);
  const code=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},archive=${JSON.stringify(remoteArchive)};
   const hash=b=>crypto.createHash('sha256').update(b).digest('hex');if(hash(fs.readFileSync(archive))!==${JSON.stringify(archiveHash)})throw Error('archive_hash');
   if(!fs.existsSync(r.candidate)){fs.mkdirSync(r.candidate,{mode:0o755});cp.execFileSync('tar',['-xf',archive,'-C',r.candidate]);}
   if(!fs.lstatSync(r.candidate).isDirectory())throw Error('candidate_not_directory');
   if(hash(fs.readFileSync(r.candidate+'/release-files.json'))!==${JSON.stringify(hash(await readFile(artifact+'/release-files.json')))})throw Error('manifest_binding');
   const manifest=JSON.parse(fs.readFileSync(r.candidate+'/release-files.json','utf8'));
   for(const [f,h]of Object.entries(manifest.files))if(hash(fs.readFileSync(r.candidate+'/'+f))!==h)throw Error('candidate_file_hash');
   if(hash(fs.readFileSync(r.candidate+'/dist/app.mjs'))!==r.expectedAppSha256||hash(fs.readFileSync(r.candidate+'/dist/server.js'))!==r.expectedServerSha256)throw Error('candidate_binding');
   // Immutable imports can give the archive root mode 0555. Only this staged
   // root needs owner write access for host-local links and receipts; artifact
   // file bytes remain unchanged and are verified again by the installer.
   fs.chmodSync(r.candidate,0o755);
   const link=(from,to)=>{const target=fs.realpathSync(from);if(fs.existsSync(to)){if(fs.realpathSync(to)!==target)throw Error('staging_link_drift');}else fs.symlinkSync(target,to);};
   link(r.baseline+'/node_modules',r.candidate+'/node_modules');
   if(r.id==='ubuntu-gpu-lab'){const from=r.baseline+'/runner.mjs',to=r.candidate+'/runner.mjs';if(fs.existsSync(to)){if(hash(fs.readFileSync(from))!==hash(fs.readFileSync(to)))throw Error('runner_drift');}else fs.copyFileSync(from,to);}
   if(r.id==='beam-10g')link(r.environmentFile,r.candidate+'/.remote-agent.env');
   if(fs.existsSync(r.requestFile)){const previous=JSON.parse(fs.readFileSync(r.requestFile,'utf8'));previous.releaseOrder=r.releaseOrder;if(JSON.stringify(previous)!==JSON.stringify(r))throw Error('request_drift');}else fs.writeFileSync(r.requestFile,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
   process.stdout.write(cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile],{cwd:r.candidate,encoding:'utf8',stdio:'pipe'}));`;
  console.log(run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:code}).trim());
 }else{
  try{assert.ok((await lstat(candidate)).isDirectory());}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(candidate,{mode:0o755});await cp(artifact,candidate,{recursive:true});}
  for(const [f,h]of Object.entries(manifest.files))assert.equal(hash(await readFile(candidate+'/'+f)),h);
  await chmod(candidate,0o755);
  const dependencyTarget=await realpath(baseline+'/node_modules');
  try{assert.equal(await realpath(candidate+'/node_modules'),dependencyTarget);}catch(e){if(e.code!=='ENOENT')throw e;await symlink(dependencyTarget,candidate+'/node_modules');}
  try{const previous=JSON.parse(await readFile(r.requestFile,'utf8'));previous.releaseOrder=r.releaseOrder;assert.deepEqual(previous,r);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(r.requestFile,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});}
  console.log(run(r.nodeExecutable,[candidate+'/install.mjs','preflight',r.requestFile],{cwd:candidate,env:{...process.env,PM2_HOME:'/root/.pm2'}}).trim());
 }
 targets.push(r);
}
await writeFile(dir+'/staged.json',JSON.stringify({buildId,source:capture.stage,buildOrigin:'beam',artifact:imported.artifact,artifactTreeSha256:imported.artifactTreeSha256,targets},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({staged:true,buildId,targets:targets.map(r=>r.id),activationPerformed:false}));
