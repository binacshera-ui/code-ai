import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,symlink,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [controllerBuildId]=process.argv.slice(2);assert.match(controllerBuildId,/^[a-f0-9-]{36}$/);
const buildId='b6196953-8f40-4acb-a040-1b31a912bea6',transactionId=buildId+'-'+controllerBuildId;
const artifact='/mnt/hdd/code-ai-builds/native-owner-controller-imports/'+controllerBuildId+'/artifact/dist';
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifestBytes=await readFile(artifact+'/release-files.json'),manifest=JSON.parse(manifestBytes);
for(const [file,sha]of Object.entries(manifest.files)){assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'));assert.equal(hash(await readFile(artifact+'/'+file)),sha);}
const original=JSON.parse(await readFile('ops/native-unlock-release/staged-'+buildId+'.json','utf8'));
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const archive='/mnt/hdd/code-ai-builds/native-owner-controller-imports/'+controllerBuildId+'/public-controller.tar';
execFileSync('tar',['-cf',archive,'-C',artifact,'.'],{stdio:'pipe'});const archiveSha=hash(await readFile(archive));
const targets=[];
for(const old of original.targets){
  const ownerControllerDirectory=old.id==='main'?'/mnt/hdd/code-ai-builds/native-owner-controller-live-'+controllerBuildId
    :old.id==='ubuntu-gpu-lab'?'/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-owner-controller-'+controllerBuildId
    :'/opt/code-ai-releases/native-owner-controller-'+controllerBuildId;
  const r={...old,ownerControllerBuildId:controllerBuildId,ownerControllerDirectory,ownerControllerManifestSha256:hash(manifestBytes),
    requestFile:old.candidate+'/deployment-request-with-owner-controller-'+controllerBuildId+'.json',
    ...(old.id==='beam-10g'?{previousPartialOwnerBuildId:buildId}:{} )};
  const host=hosts[r.id],remote='/var/tmp/code-ai-owner-controller-'+controllerBuildId+'.tar';
  if(host)execFileSync('scp',['-q','-o','BatchMode=yes','-o','ConnectTimeout=10',archive,host+':'+remote],{stdio:'pipe',timeout:90000});
  const script=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},a=${JSON.stringify(host?remote:archive)};
    const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
    if(hash(fs.readFileSync(a))!==${JSON.stringify(archiveSha)})throw Error('Controller archive changed');
    if(fs.existsSync(r.ownerControllerDirectory))throw Error('Controller directory already present');
    fs.mkdirSync(r.ownerControllerDirectory,{mode:0o755});cp.execFileSync('tar',['-xf',a,'-C',r.ownerControllerDirectory],{stdio:'pipe'});
    const bytes=fs.readFileSync(r.ownerControllerDirectory+'/release-files.json');if(hash(bytes)!==r.ownerControllerManifestSha256)throw Error('Controller manifest changed');
    for(const [f,sha]of Object.entries(JSON.parse(bytes).files))if(hash(fs.readFileSync(r.ownerControllerDirectory+'/'+f))!==sha)throw Error('Controller artifact changed');
    fs.chmodSync(r.ownerControllerDirectory,0o755);
    fs.symlinkSync(fs.realpathSync(r.candidate+'/node_modules'),r.ownerControllerDirectory+'/node_modules');
    fs.writeFileSync(r.requestFile,JSON.stringify(r,null,2)+'\\n',{mode:0o600,flag:'wx'});
    cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile],{cwd:r.candidate,stdio:'pipe',timeout:90000});
    console.log(JSON.stringify({id:r.id,controllerStaged:true,corePreflightPassed:true,installedEffects:false}));`;
  const output=host?execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:script,encoding:'utf8',stdio:'pipe',timeout:120000})
    :execFileSync(r.nodeExecutable,['-'],{input:script,encoding:'utf8',stdio:'pipe',timeout:120000});
  console.log(output.trim());targets.push(r);
}
await writeFile('ops/native-unlock-release/staged-'+transactionId+'.json',JSON.stringify({buildId,controllerBuildId,controllerManifestSha256:hash(manifestBytes),targets},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({allFourControllersStaged:true,coreUnchanged:true,transactionId}));
