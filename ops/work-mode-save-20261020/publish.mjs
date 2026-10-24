import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {observeUi} from '../work-modes-ui-20261020/observe-ui.mjs';
const ops=process.env.CODE_AI_UI_RELEASE_OPS||'/root/projects/code-ai/ops/work-mode-save-20261020';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const c=await read(ops+'/capture.json');
const manual=c.delivery==='owner-authorized-local'?await read(ops+'/manual-build.json'):null;
let accepted,result;
if(manual){
 assert.equal(manual.passed,true);assert.equal(manual.beamBuild,false);assert.equal(manual.sourceSha256,c.sourceSha256);
 assert.equal(manual.authorization,'פרוס במסלול הישיר והידני');
 for(const [file,digest]of Object.entries(manual.files))assert.equal(sha(await fs.readFile(manual.workspace+'/'+file)),digest,'Local artifact changed');
 accepted={buildId:manual.buildId};result={buildId:manual.buildId,artifact:manual.workspace};
}else{
 const current=await read(ops+'/build-current.json');accepted=await read(current.acceptedFile);result=await read(current.resultFile);
 assert.equal(accepted.observedStatus,'IMPORTED');assert.equal(result.buildId,accepted.buildId);
}
const pointer='/etc/nginx/code-ai-ui/current.locations.conf';
// Static UI output may live on HDD when the root filesystem's reserve is low.
// This is scoped by the captured release, not a global relocation or cleanup.
const releaseBase=c.staticReleaseRoot||'/var/www/code-ai-ui/releases';
assert.ok(['/var/www/code-ai-ui/releases','/mnt/hdd/code-ai-ui/releases'].includes(releaseBase),'Unsupported UI storage root');
const release=releaseBase+'/'+c.sourceSha256.slice(0,12), publicRoot=release+'/public';
const nginxFile=await fs.realpath('/etc/nginx/sites-enabled/code-ai');
const mainPid=()=>Number(JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}})).find(p=>p.name==='code-ai-app').pid);
async function baseline(){
 assert.equal(await fs.realpath(pointer),c.predecessorPointer,'Accepted UI advanced; re-integrate first');
 assert.equal(path.dirname(await fs.realpath('/root/projects/code-ai/dist')),process.argv[2]==='activate'?(c.activationBackendBaseline||c.baseline):c.baseline,'Backend changed');
}
await baseline();
if(process.argv[2]==='prepare'){
 const verification=manual?{ok:true,buildId:manual.buildId,artifact:manual.workspace,sourceSha256:manual.sourceSha256,buildType:manual.buildType,beamAttestation:false}
  :JSON.parse(execFileSync('/usr/local/bin/bina-build',['verify-import',accepted.buildId,'--import-root',c.importRoot||'/mnt/hdd/code-ai-builds/work-modes-ui-import-20261020'],{encoding:'utf8'}));
 assert.equal(verification.artifact,result.artifact);
 await fs.mkdir(releaseBase,{recursive:true,mode:0o755});
 const free=await fs.statfs(releaseBase);assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
 await fs.mkdir(release,{mode:0o755});
 for(const dir of[path.dirname(releaseBase),releaseBase,release])await fs.chmod(dir,0o755);
 await fs.cp(result.artifact+'/dist/public',publicRoot,{recursive:true});
 for(const name of await fs.readdir(c.predecessor.release+'/public/assets')){
  const prior=c.predecessor.release+'/public/assets/'+name,target=publicRoot+'/assets/'+name;
  try{await fs.copyFile(prior,target,1);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(sha(await fs.readFile(prior)),sha(await fs.readFile(target)),'Hashed asset collision');}
 }
 const files={};async function tree(rel=''){
  await fs.chmod(publicRoot+'/'+rel,0o755);
  for(const e of await fs.readdir(publicRoot+'/'+rel,{withFileTypes:true})){
   const name=path.join(rel,e.name);
   if(e.isDirectory())await tree(name);else{assert.ok(e.isFile());await fs.chmod(publicRoot+'/'+name,0o644);files[name]=sha(await fs.readFile(publicRoot+'/'+name));}
  }
 }await tree();
 const oldLocations=await fs.readFile(c.predecessorPointer,'utf8');
 assert.ok(oldLocations.includes(c.predecessor.release+'/public'));
 const locations=oldLocations.replaceAll(c.predecessor.release+'/public',publicRoot);
 await fs.writeFile(release+'/locations.conf',locations,{mode:0o644});
 for(const file of Object.keys(files))execFileSync('runuser',['-u','www-data','--','/usr/bin/test','-r',publicRoot+'/'+file]);
 const manifest={release,sourceSha256:c.sourceSha256,capturedSource:c.source,beamBuildId:manual?null:accepted.buildId,...(manual?{manualBuildId:manual.buildId,buildType:manual.buildType}:{}),verification,files,backendBaseline:c.activationBackendBaseline||c.baseline,predecessor:c.predecessor.release,nginxConfigSha256:sha(await fs.readFile(nginxFile)),locationsSha256:sha(locations)};
 await fs.writeFile(release+'/manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
 console.log(JSON.stringify({prepared:true,release,sourceSha256:c.sourceSha256,buildId:accepted.buildId,buildType:manual?.buildType||'beam-qualified',publicFiles:Object.keys(files).length}));
}else if(process.argv[2]==='activate'){
 const manifest=await read(release+'/manifest.json'), preflight=await read(ops+'/static-preflight.json'), live=await read(ops+'/live-save.json');
 assert.ok(preflight.passed&&live.passed);assert.equal(live.source,c.source);
 assert.equal(preflight.sourceSha256,c.sourceSha256);assert.equal(preflight.locationsSha256,manifest.locationsSha256);
 assert.equal(sha(await fs.readFile(release+'/locations.conf')),manifest.locationsSha256);
 assert.equal(sha(await fs.readFile(nginxFile)),manifest.nginxConfigSha256,'NGINX baseline changed');
 for(const [file,hash]of Object.entries(manifest.files))assert.equal(sha(await fs.readFile(publicRoot+'/'+file)),hash,'Qualified file changed');
 const activeBackend=c.activationBackendBaseline||c.baseline;
 const before=mainPid(), backendHash=sha(await fs.readFile(activeBackend+'/dist/app.mjs'));
 assert.ok(before>0);await baseline();
 async function point(target){const temp=pointer+'.'+randomUUID();await fs.symlink(target,temp);await fs.rename(temp,pointer);}
 await point(release+'/locations.conf');
 let reloadRequested=false;
 try{
  execFileSync('nginx',['-t'],{stdio:'pipe'});reloadRequested=true;execFileSync('systemctl',['reload','nginx'],{stdio:'pipe'});
  const checks=[];
  for(const origin of['https://app-codex.bina-cshera.co.il','https://app-code-ai.bina-cshera.co.il']){
   const handoff=await observeUi(origin+'/',manifest.files['index.html'],c.predecessor.files['index.html']);
   for(const route of['/index.html','/session/developer/01a05cd0-8a16-7752-9558-1dbe4f9ebd3f?server=local','/chat','/workbench']){
    const {response}=await observeUi(origin+route,manifest.files['index.html'],c.predecessor.files['index.html']);assert.ok(response.headers.get('cache-control')?.includes('no-store'));
   }
   const html=await fs.readFile(publicRoot+'/index.html','utf8'),asset=html.match(/<script[^>]+src="([^"]+)"/)[1];
   const response=await fetch(origin+asset);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),manifest.files[asset.slice(1)]);
   const missing=await fetch(origin+'/assets/work-mode-save-missing.js');assert.equal(missing.status,404);
   for(const name of await fs.readdir(c.predecessor.release+'/public/assets'))assert.equal((await fetch(origin+'/assets/'+name,{method:'HEAD'})).status,200);
   checks.push({origin,shellAndBundleHashesVerified:true,handoffAttempts:handoff.attempts,retainedOldAssets:true});
  }
  assert.equal(mainPid(),before,'Application unexpectedly restarted');assert.equal(sha(await fs.readFile(activeBackend+'/dist/app.mjs')),backendHash);
  const receipt={installed:true,frontendOnly:true,release,sourceSha256:c.sourceSha256,beamBuildId:manual?null:accepted.buildId,...(manual?{manualBuildId:manual.buildId,buildType:manual.buildType}:{}),finishedAt:new Date().toISOString(),checks,saveContract:live,staticPreflight:preflight,applicationPidBefore:before,applicationPidAfter:mainPid(),applicationRestarted:false,remoteServicesRestarted:false,interruptedAgentRuns:0,nginxReloaded:true,browserVerification:live.browserVerification||'Not performed by this publisher; see release-specific browser qualification.',rollbackPointer:c.predecessorPointer};
  await fs.writeFile(ops+'/final-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
 }catch(error){
  assert.equal(await fs.realpath(pointer),release+'/locations.conf','Refusing to overwrite concurrent successor');
  await point(c.predecessorPointer);execFileSync('nginx',['-t'],{stdio:'pipe'});if(reloadRequested)execFileSync('systemctl',['reload','nginx'],{stdio:'pipe'});
  await fs.writeFile(ops+'/activation-failure.json',JSON.stringify({release,error:error.message,rolledBack:true,at:new Date().toISOString()},null,2),{mode:0o600});throw error;
 }
}else throw Error('Expected prepare or activate');
