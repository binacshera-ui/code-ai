import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',ops=root+'/ops/scheduler-startup-20261023';
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const digest=async p=>hash(await fs.readFile(p));
const save=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const backendFiles=['server/codexQueue.ts','server/codexService.ts','server/agentService.ts','server/codexQueueRecurrence.mjs',
 'server/codexQueueRecurrence.test.mjs','server/codexQueue.recurrenceRecovery.test.ts'];
const additionalTests=['codexQueue.retry.test.ts','codexQueue.persistence.test.ts','codexQueue.drafts.test.ts',
 'codexQueue.cancellationRecovery.test.ts','codexQueue.stopSchedule.test.ts','codexAppServer.test.ts','codexSharedSubmission.test.mjs'].map(n=>'server/'+n);
const uiFiles=['client/src/components/codex/CodexMobileApp.tsx','client/src/components/codex/startupLoading.test.mjs'];
async function tree(dir,rel='') {
 const out={};for(const e of(await fs.readdir(dir+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const name=path.join(rel,e.name);if(e.isDirectory())Object.assign(out,await tree(dir,name));else{assert.ok(e.isFile());out[name]=await digest(dir+'/'+name);}}
 return out;
}
async function copy(dir,file){await fs.mkdir(path.dirname(dir+'/'+file),{recursive:true});await fs.copyFile(root+'/'+file,dir+'/'+file);}
async function own(dir){await fs.chown(dir,65534,65534);await fs.chmod(dir,0o755);for(const e of await fs.readdir(dir,{withFileTypes:true})){
 const f=dir+'/'+e.name;if(e.isDirectory())await own(f);else{assert.ok(e.isFile());await fs.chown(f,65534,65534);await fs.chmod(f,0o644);}}}
async function dependencies(dir){await fs.mkdir(dir+'/node_modules');await fs.chown(dir+'/node_modules',65534,65534);for(const name of await fs.readdir(root+'/node_modules')){
 if(!['.vite','.vite-temp','.cache','systeminformation'].includes(name))await fs.symlink(root+'/node_modules/'+name,dir+'/node_modules/'+name);}
 await fs.symlink(dir+'/.deps/systeminformation',dir+'/node_modules/systeminformation');}
async function build(dir,phase,label=phase){await fs.mkdir(dir+'/qualification',{recursive:true});await fs.chown(dir+'/qualification',65534,65534);
 const log=await fs.open(dir+'/qualification/'+label+'-scheduler.log','wx',0o600);
 const child=spawn('/usr/sbin/runuser',['-u','nobody','--',process.execPath,'build-scheduler.mjs',phase],{cwd:dir,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',TMPDIR:dir+'/qualification',NODE_OPTIONS:'--max-old-space-size=4096'},stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});await log.close();assert.equal(code,0,phase+' build failed: '+dir+'/qualification/'+label+'-scheduler.log');}
async function finish(capture,manifest){
 const {candidate,source,workspace,sourceSha256}=capture;
 const release=await json(candidate+'/release.json');Object.assign(release,{version:path.basename(candidate),buildId:capture.buildId,builtAt:new Date().toISOString(),builder:'user-server',beamAttested:false});await save(candidate+'/release.json',release);
 const names=[...new Set([...Object.keys(manifest.files),...backendFiles,...additionalTests,'build-scheduler.mjs',...Object.keys(await tree(candidate+'/qualification')).map(f=>'qualification/'+f)])];
 const releaseFiles=Object.fromEntries(await Promise.all(names.map(async f=>[f,await digest(candidate+'/'+f)])));
 await save(candidate+'/release-files.json',{format:'code-ai-release-files',version:1,files:releaseFiles});
 const baseline=capture.baseline,request=await json(baseline+'/fleet-request.json');Object.assign(request,{candidate,baseline,buildId:capture.buildId,releaseOrder:String(Date.now()),attemptId:'scheduler-'+randomUUID(),ownerAuthorizedInterruption:true,
  expectedBaselineSha256:await digest(baseline+'/dist/server.js'),expectedServerSha256:releaseFiles['dist/server.js'],expectedAppSha256:releaseFiles['dist/app.mjs'],uploadBaselineModule:baseline+'/dist/server.js',uploadBaselineSha256:await digest(baseline+'/dist/server.js')});
 delete request.featureEnvironmentFile;await save(candidate+'/fleet-request.json',request);
 const proof=JSON.parse(execFileSync(request.nodeExecutable,[candidate+'/install.mjs','preflight',candidate+'/fleet-request.json'],{cwd:candidate,encoding:'utf8',timeout:120000}));assert.equal(proof.prepared,true);
 await save(ops+'/staged.json',{...capture,request,passed:true,backendFiles,preflight:proof});
 await save(ops+'/manual-build.json',{passed:true,beamBuild:false,sourceSha256,source,workspace,authorization:'פרוס במסלול הישיר והידני',buildId:capture.buildId,files:Object.fromEntries(Object.entries(await tree(workspace+'/dist/public')).map(([f,h])=>['dist/public/'+f,h])),builder:'user-server',beamAttested:false,buildType:'owner-authorized-main-server-isolated-ui-build'});
 console.log(JSON.stringify({passed:true,candidate,workspace,sourceSha256}));
}
if(process.argv[2]==='build'){
 const baseline=path.dirname(await fs.realpath(root+'/dist')),uiPointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
 const predecessor=await json(path.dirname(uiPointer)+'/manifest.json'), manifest=await json(baseline+'/release-files.json');
 const candidate=await fs.mkdtemp('/mnt/hdd/code-ai-builds/scheduler-api-20261023-');
 for(const[file,expected]of Object.entries(manifest.files)){assert.equal(await digest(baseline+'/'+file),expected,'Baseline changed '+file);await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(baseline+'/'+file,candidate+'/'+file);}
 for(const file of [...backendFiles,...additionalTests])await copy(candidate,file);
 await fs.copyFile(ops+'/build.mjs',candidate+'/build-scheduler.mjs');
 const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/scheduler-ui-source-20261023-');await fs.cp(predecessor.capturedSource,source,{recursive:true});
 for(const file of uiFiles)await copy(source,file);await fs.copyFile(ops+'/build.mjs',source+'/build-scheduler.mjs');
 const files=await tree(source),old=await tree(predecessor.capturedSource);
 assert.ok(Object.keys(old).every(f=>f in files));assert.deepEqual(Object.keys(files).filter(f=>files[f]!==old[f]).sort(),[...uiFiles,'build-scheduler.mjs'].sort());
 const sourceSha256=hash(JSON.stringify(files)),workspace=await fs.mkdtemp('/mnt/hdd/code-ai-builds/scheduler-ui-build-20261023-');await fs.cp(source,workspace,{recursive:true});
 await fs.mkdir(workspace+'/.deps',{recursive:true});await fs.cp(baseline+'/.deps/systeminformation',workspace+'/.deps/systeminformation',{recursive:true});
 await own(candidate);await own(workspace);await dependencies(candidate);await dependencies(workspace);
 const capture={baseline,candidate,source,workspace,uiPointer,predecessorPointer:uiPointer,predecessor,files,sourceSha256,buildId:randomUUID(),
  changed:uiFiles,delivery:'owner-authorized-local',frontendOnly:true,staticReleaseRoot:'/mnt/hdd/code-ai-ui/releases'};
 await save(ops+'/capture.json',capture);
 await Promise.all([build(candidate,'backend'),build(workspace,'ui')]);
 await finish(capture,manifest);
}else if(process.argv[2]==='resume'){
 const c=await json(ops+'/capture.json');assert.equal(await fs.realpath(root+'/dist'),c.baseline+'/dist');
 // Reuse the successful unchanged UI artifact. Only fixture placement and
 // qualification concurrency changed; product inputs are identical.
 for(const file of backendFiles.filter(f=>!f.endsWith('.test.ts')))assert.equal(await digest(root+'/'+file),await digest(c.candidate+'/'+file));
 await copy(c.candidate,'server/codexQueue.recurrenceRecovery.test.ts');
 await fs.chown(c.candidate+'/server/codexQueue.recurrenceRecovery.test.ts',65534,65534);
 await fs.copyFile(ops+'/build.mjs',c.candidate+'/build-scheduler.mjs');await fs.chown(c.candidate+'/build-scheduler.mjs',65534,65534);
 await build(c.candidate,'backend','backend-resume');await finish(c,await json(c.baseline+'/release-files.json'));
}else if(process.argv[2]==='prepare-ui'){
 const c=await json(ops+'/capture.json');c.activationBackendBaseline=c.candidate;await save(ops+'/capture.json',c);
 execFileSync(process.execPath,[root+'/ops/work-mode-save-20261020/publish.mjs','prepare'],{stdio:'inherit',env:{...process.env,CODE_AI_UI_RELEASE_OPS:ops}});
 execFileSync(process.execPath,[root+'/ops/work-modes-ui-20261020/static-preflight.mjs',c.staticReleaseRoot+'/'+c.sourceSha256.slice(0,12),ops],{stdio:'inherit'});
}else throw Error('build or prepare-ui required');
