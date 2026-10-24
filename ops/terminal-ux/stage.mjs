import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdir,symlink,realpath,chmod} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',dir=root+'/ops/terminal-ux';
const capture=JSON.parse(await readFile(dir+'/capture.json','utf8'));
const artifact=capture.stage+'/dist',buildId=randomUUID();
assert.equal(await realpath(root+'/dist'),capture.baseline+'/dist');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(artifact+'/release-files.json','utf8'));
for(const [f,h]of Object.entries(manifest.files))assert.equal(hash(await readFile(artifact+'/'+f)),h);
assert.equal(JSON.parse(await readFile(artifact+'/qualification/terminal-browser.json','utf8')).passed,true);
const installed=JSON.parse(await readFile(root+'/ops/native-unlock-release/staged-b6196953-8f40-4acb-a040-1b31a912bea6-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json','utf8'));
const main=JSON.parse(await readFile(root+'/ops/shared-defaults-fix/staged-local.json','utf8'));
const archive=capture.stage+'/terminal-release.tar';execFileSync('tar',['-cf',archive,'-C',artifact,'.']);await chmod(archive,0o600);
const archiveHash=hash(await readFile(archive));
const targets=[];
for(const previous of installed.targets){
 const old=previous.id==='main'?main:previous;
 const baseline=old.candidate;
 const candidate=old.id==='main'?'/mnt/hdd/code-ai-builds/terminal-ux-live-'+buildId
   :old.id==='ubuntu-gpu-lab'?'/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/terminal-ux-'+buildId
   :old.id==='pci'?'/srv/beam254/code-ai-native/releases/terminal-ux-'+buildId
   :'/opt/code-ai-releases/terminal-ux-'+buildId;
 const native=old.ownerProfiles[0];
 const r={...old,buildId,baseline,candidate,buildOrigin:'local',localBuildExplicitlyAuthorized:true,attemptId:'terminal-ux',releaseOrder:String(Date.now()),
  expectedBaselineSha256:old.expectedServerSha256,expectedServerSha256:manifest.files['dist/server.js'],expectedAppSha256:manifest.files['dist/app.mjs'],
  terminalNativeBinary:native.nativeBinary,terminalNativeBinarySha256:native.nativeBinarySha256,
  requestFile:candidate+'/deployment-request.json'};
 if(r.id==='main'){r.uploadBaselineModule=baseline+'/dist/server.js';r.uploadBaselineSha256=old.expectedServerSha256;}
 const host={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'}[r.id];
 if(host){
  const archiveRemote='/var/tmp/code-ai-terminal-ux-'+buildId+'.tar';
  execFileSync('scp',['-q','-o','BatchMode=yes','-o','ConnectTimeout=10',archive,host+':'+archiveRemote],{timeout:120000,stdio:'pipe'});
  const code=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},archive=${JSON.stringify(archiveRemote)};
   const hash=b=>crypto.createHash('sha256').update(b).digest('hex');if(hash(fs.readFileSync(archive))!==${JSON.stringify(archiveHash)})throw Error('archive_hash');
   fs.mkdirSync(r.candidate,{mode:0o755});cp.execFileSync('tar',['-xf',archive,'-C',r.candidate]);
   fs.symlinkSync(fs.realpathSync(r.baseline+'/node_modules'),r.candidate+'/node_modules');
   if(r.id==='ubuntu-gpu-lab')fs.copyFileSync(r.baseline+'/runner.mjs',r.candidate+'/runner.mjs');
   if(r.id==='beam-10g')fs.symlinkSync(r.environmentFile,r.candidate+'/.remote-agent.env');
   fs.writeFileSync(r.requestFile,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
   process.stdout.write(cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile],{cwd:r.candidate,encoding:'utf8',stdio:'pipe'}));`;
  console.log(execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:code,encoding:'utf8',timeout:120000,stdio:'pipe'}).trim());
 }else{
  await mkdir(candidate,{mode:0o755});await cp(artifact,candidate,{recursive:true});
  await symlink(await realpath(baseline+'/node_modules'),candidate+'/node_modules');
  await writeFile(r.requestFile,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
  console.log(execFileSync(r.nodeExecutable,[candidate+'/install.mjs','preflight',r.requestFile],{cwd:candidate,encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'}}).trim());
 }
 targets.push(r);
}
await writeFile(dir+'/staged.json',JSON.stringify({buildId,source:capture.stage,buildOrigin:'local',artifactFilesVerified:true,targets},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({staged:true,buildId,targets:targets.map(r=>r.id),installedEffects:false}));
