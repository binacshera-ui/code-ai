import assert from'node:assert/strict';import fs from'node:fs/promises';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const dir='/root/projects/code-ai/ops/ubuntu-native-admission',hash=b=>createHash('sha256').update(b).digest('hex');
const run=(p,a,o={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:120000,...o});
const buildId=JSON.parse(await fs.readFile(dir+'/beam-corrected-accepted.json','utf8')).buildId;
const imported=JSON.parse(run('bina-build',['verify-import',buildId,'--import-root','/mnt/hdd/code-ai-builds/ubuntu-native-admission-imports']));
const artifact=imported.artifact+'/dist',manifest=JSON.parse(await fs.readFile(artifact+'/release-files.json','utf8'));
for(const[f,h]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(artifact+'/'+f)),h);
const old=JSON.parse(await fs.readFile('/root/projects/code-ai/ops/queued-recovery/staged.json','utf8')).targets.find(r=>r.id==='ubuntu-gpu-lab');
const candidate='/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/ubuntu-native-admission-'+buildId;
let r={...old,buildId,baseline:old.candidate,candidate,buildOrigin:'beam',localBuildExplicitlyAuthorized:false,attemptId:'ubuntu-native-admission',releaseOrder:String(Date.now()),
 expectedBaselineSha256:old.expectedServerSha256,expectedServerSha256:manifest.files['dist/server.js'],expectedAppSha256:manifest.files['dist/app.mjs'],requestFile:candidate+'/deployment-request.json',
 oldBrokerSha256:'c3b035526684259b4653f6af53863411a528c46a6deb671531fb5729ae1e12e2',newBrokerSha256:manifest.files['server/codexSharedOwnerBroker.mjs']};
try{const previous=JSON.parse(await fs.readFile(dir+'/staging-request.json','utf8'));r.releaseOrder=previous.releaseOrder;assert.deepEqual(r,previous);}
catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(dir+'/staging-request.json',JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});}
const archive=dir+'/release.tar';run('tar',['-cf',archive,'-C',artifact,'.']);await fs.chmod(archive,0o600);
const archiveHash=hash(await fs.readFile(archive)),remoteArchive='/var/tmp/code-ai-ubuntu-admission-'+buildId+'.tar';
run('scp',['-q',archive,'personal-ubuntu-ssh:'+remoteArchive]);
const remote=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},hash=b=>crypto.createHash('sha256').update(b).digest('hex');
if(hash(fs.readFileSync(${JSON.stringify(remoteArchive)}))!==${JSON.stringify(archiveHash)})throw Error('archive_hash');
if(!fs.existsSync(r.candidate)){fs.mkdirSync(r.candidate);cp.execFileSync('tar',['-xf',${JSON.stringify(remoteArchive)},'-C',r.candidate]);}fs.chmodSync(r.candidate,0o755);
let m=JSON.parse(fs.readFileSync(r.candidate+'/release-files.json'));for(let[f,h]of Object.entries(m.files))if(hash(fs.readFileSync(r.candidate+'/'+f))!==h)throw Error('file_hash');
if(fs.existsSync(r.candidate+'/node_modules')){if(fs.realpathSync(r.candidate+'/node_modules')!==fs.realpathSync(r.baseline+'/node_modules'))throw Error('dependencies_drift');}else fs.symlinkSync(fs.realpathSync(r.baseline+'/node_modules'),r.candidate+'/node_modules');
if(fs.existsSync(r.candidate+'/runner.mjs')){if(hash(fs.readFileSync(r.candidate+'/runner.mjs'))!==hash(fs.readFileSync(r.baseline+'/runner.mjs')))throw Error('runner_drift');}else fs.copyFileSync(r.baseline+'/runner.mjs',r.candidate+'/runner.mjs');
const p='/home/refael/code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json',b=fs.readFileSync(p),plan=JSON.parse(b);if(plan.brokerModuleSha256!==r.oldBrokerSha256)throw Error('owner_drift');r.planSha256=hash(b);
if(fs.existsSync(r.requestFile)){if(JSON.stringify(JSON.parse(fs.readFileSync(r.requestFile)))!==JSON.stringify(r))throw Error('request_drift');}else fs.writeFileSync(r.requestFile,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});fs.mkdirSync(r.candidate+'/host-admission-ops',{mode:0o700,recursive:true});
process.stdout.write(cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile],{cwd:r.candidate,encoding:'utf8',stdio:'pipe'}));`;
console.log(run('ssh',['personal-ubuntu-ssh',r.nodeExecutable+' -'],{input:remote}).trim());
const scripts=['activate-idle.mjs','idle-contract.mjs','idle-contract.test.mjs'];
for(const f of scripts)run('scp',['-q',dir+'/'+f,'personal-ubuntu-ssh:'+candidate+'/host-admission-ops/'+f]);
run('scp',['-q','/root/projects/code-ai/ops/native-unlock-release/verify-installed-host.mjs','personal-ubuntu-ssh:'+candidate+'/host-admission-ops/verify-installed-host.mjs']);
const scriptHashes=Object.fromEntries(await Promise.all(scripts.map(async f=>[f,hash(await fs.readFile(dir+'/'+f))])));
console.log(run('ssh',['personal-ubuntu-ssh',r.nodeExecutable+' -'],{input:`let fs=require('fs'),cp=require('child_process'),crypto=require('crypto'),dir=${JSON.stringify(candidate+'/host-admission-ops')};for(let[f,h]of Object.entries(${JSON.stringify(scriptHashes)}))if(crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+f)).digest('hex')!==h)throw Error('operations_hash');let s=cp.execFileSync(${JSON.stringify(r.nodeExecutable)},['--test','--test-reporter=tap',dir+'/idle-contract.test.mjs'],{encoding:'utf8'});if(!s.includes('# pass 4')||!s.includes('# fail 0'))throw Error('idle_tests');console.log(JSON.stringify({idleGateTests:4,operationsHashesMatched:true,installedEffects:false}));`}).trim());
await fs.writeFile(dir+'/staged.json',JSON.stringify({buildId,artifact,artifactTreeSha256:imported.artifactTreeSha256,target:r,scriptHashes},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({staged:true,buildId,target:r.id,activationPerformed:false}));
