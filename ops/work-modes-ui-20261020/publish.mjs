import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{createHash,randomUUID}from'node:crypto';
import{fleetClient}from'../focus-notifications-20261020/fleet-live.mjs';
import{observeUi}from'./observe-ui.mjs';
const ops='/root/projects/code-ai/ops/work-modes-ui-20261020';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const c=await read(ops+'/capture.json'),current=await read(ops+'/build-current.json'),accepted=await read(current.acceptedFile),result=await read(current.resultFile);
assert.equal(accepted.observedStatus,'IMPORTED');assert.equal(result.buildId,accepted.buildId);
const verified=JSON.parse(execFileSync('/usr/local/bin/bina-build',['verify-import',accepted.buildId,'--import-root','/mnt/hdd/code-ai-builds/work-modes-ui-import-20261020'],{encoding:'utf8'}));
assert.equal(path.dirname(await fs.realpath('/root/projects/code-ai/dist')),c.baseline,'Backend baseline changed');
const nginxFile=await fs.realpath('/etc/nginx/sites-enabled/code-ai');assert.equal(nginxFile,'/etc/nginx/sites-available/code-ai');
const config=await fs.readFile(nginxFile,'utf8');assert.ok(!config.includes('code-ai-qualified-ui:begin'),'An existing UI publisher requires baseline reconciliation');
const release='/var/www/code-ai-ui/releases/'+c.sourceSha256.slice(0,12),publicRoot=release+'/public';
const free=await fs.statfs('/var/www');assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
await fs.mkdir(release,{recursive:true,mode:0o755});
// The native owner's umask is private (077). Public artifacts need traversable
// parents too, not just readable leaf files. These directories contain public
// release files only; no application state or authentication is placed here.
for(const directory of ['/var/www/code-ai-ui','/var/www/code-ai-ui/releases',release]){
 const info=await fs.lstat(directory);assert.ok(info.isDirectory()&&!info.isSymbolicLink());await fs.chmod(directory,0o755);
}
await fs.cp(result.artifact+'/dist/public',publicRoot,{recursive:true});
// Hashed assets from the accepted shell remain available to already-open tabs.
for(const name of await fs.readdir(c.baseline+'/dist/public/assets')){
 const target=publicRoot+'/assets/'+name,prior=c.baseline+'/dist/public/assets/'+name;
 try{await fs.copyFile(prior,target,1);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(sha(await fs.readFile(target)),sha(await fs.readFile(prior)),'Hashed asset name collision');}
}
const files={};async function tree(rel=''){for(const e of await fs.readdir(publicRoot+'/'+rel,{withFileTypes:true})){const name=path.join(rel,e.name);if(e.isDirectory()){await fs.chmod(publicRoot+'/'+name,0o755);await tree(name);}else{assert.ok(e.isFile());await fs.chmod(publicRoot+'/'+name,0o644);files[name]=sha(await fs.readFile(publicRoot+'/'+name));}}}await fs.chmod(publicRoot,0o755);await tree();
const preflight=await read(ops+'/static-preflight.json');assert.equal(preflight.passed,true,'Complete isolated static contract required');
execFileSync('runuser',['-u','www-data','--','/usr/bin/test','-r',publicRoot+'/index.html'],{stdio:'pipe'});
for(const file of Object.keys(files).filter(f=>f.startsWith('assets/')))
 execFileSync('runuser',['-u','www-data','--','/usr/bin/test','-r',publicRoot+'/'+file],{stdio:'pipe'});
const headers='add_header X-Frame-Options "SAMEORIGIN" always;\nadd_header X-Content-Type-Options "nosniff" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;\n';
const shell=`root ${publicRoot};\ntry_files /index.html =404;\n${headers}add_header Cache-Control "no-store, no-cache, must-revalidate" always;\nadd_header Pragma "no-cache" always;\n`;
const locations=`# Qualified CODE-AI frontend; API/WebSocket/queue traffic stays on its existing backend.\nlocation ^~ /assets/ { root ${publicRoot}; try_files $uri =404; ${headers}add_header Cache-Control "public, max-age=31536000, immutable"; }\nlocation = / { ${shell} }\nlocation = /index.html { ${shell} }\nlocation ~ ^/(?:chat|workbench|session)(?:/|$) { ${shell} }\nlocation = /sw.js { root ${publicRoot}; try_files /sw.js =404; ${headers}add_header Cache-Control "no-store, no-cache, must-revalidate" always; add_header Service-Worker-Allowed "/" always; }\n`;
await fs.writeFile(release+'/locations.conf',locations,{mode:0o644});
assert.equal(preflight.sourceSha256,c.sourceSha256);assert.equal(preflight.locationsSha256,sha(locations),'Qualified static configuration changed');
await fs.writeFile(release+'/manifest.json',JSON.stringify({release,sourceSha256:c.sourceSha256,beamBuildId:accepted.buildId,verification:verified,files,backendBaseline:c.baseline,capturedSource:c.source},null,2)+'\n',{mode:0o644});
const api=await fleetClient();
const checks=[];for(const id of['local','beam-10g','pci']){
 const prior=await read('/root/projects/code-ai/ops/work-modes-routing-20261020/'+id+'-acceptance.json');
 const profile=id==='local'?'developer':id==='pci'?'pci-admin':'beam-admin';
 const prefs=await api(id,`/session-focus-mode?profileId=${profile}&sessionKey=${prior.sessionId}`);
 const runs=await api(id,`/work-mode-runs?profileId=${profile}&sessionKey=${prior.sessionId}`),cases=await api(id,'/incident-cases');
 assert.equal(prefs.focusMode.rationalEnabled,true);assert.equal(prefs.focusMode.decisionEnabled,true);assert.ok(runs.runs.length);assert.ok(cases.cases.some(x=>x.caseId===prior.caseId));checks.push({id,preferences:true,runs:true,cases:true});
}
const mainPid=()=>Number(JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}})).find(p=>p.name==='code-ai-app').pid);
const pidBefore=mainPid(),backendHash=sha(await fs.readFile(c.baseline+'/dist/app.mjs'));
const backup=ops+'/nginx-before.conf';try{await fs.writeFile(backup,config,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await fs.readFile(backup,'utf8'),config,'Previous rollback baseline changed');}
const includeRoot='/etc/nginx/code-ai-ui',pointer=includeRoot+'/current.locations.conf';await fs.mkdir(includeRoot,{recursive:true,mode:0o755});
await fs.symlink(release+'/locations.conf',pointer);
const marker='    # code-ai-qualified-ui:begin\n    include '+pointer+';\n    # code-ai-qualified-ui:end\n\n';
const anchor='    location / {\n';assert.equal(config.split(anchor).length,2,'Unique fallback location required');
const temp=nginxFile+'.ui-'+randomUUID();await fs.writeFile(temp,config.replace(anchor,marker+anchor),{mode:0o644});
// Configuration and release pointers are unchanged until all source/artifact/API gates pass.
assert.equal(await fs.readFile(nginxFile,'utf8'),config,'Concurrent NGINX change');
await fs.rename(temp,nginxFile);
let activated=false;
try{
 execFileSync('nginx',['-t'],{stdio:'pipe'});execFileSync('systemctl',['reload','nginx'],{stdio:'pipe'});activated=true;
 const origin='https://app-codex.bina-cshera.co.il',predecessorShell=sha(await fs.readFile(c.baseline+'/dist/public/index.html'));
 const handoff=await observeUi(origin+'/',files['index.html'],predecessorShell);
 for(const route of['/','/session/developer/01a05cd0-8a16-7752-9558-1dbe4f9ebd3f?server=local','/chat','/workbench','/index.html']){
  const {response}=await observeUi(origin+route,files['index.html'],predecessorShell);assert.ok(response.headers.get('cache-control')?.includes('no-store'));
 }
 const html=await fs.readFile(publicRoot+'/index.html','utf8'),asset=html.match(/<script[^>]+src="([^"]+)"/)[1];
 const script=await fetch(origin+asset);assert.equal(script.status,200);assert.equal(sha(Buffer.from(await script.arrayBuffer())),files[asset.slice(1)]);
 const missing=await fetch(origin+'/assets/code-ai-missing-test.js');assert.equal(missing.status,404);assert.ok(!String(missing.headers.get('content-type')).includes('javascript'));
 for(const name of await fs.readdir(c.baseline+'/dist/public/assets')){const r=await fetch(origin+'/assets/'+name,{method:'HEAD'});assert.equal(r.status,200,'Retained asset '+name);}
 assert.equal(mainPid(),pidBefore,'Application unexpectedly restarted');assert.equal(sha(await fs.readFile(c.baseline+'/dist/app.mjs')),backendHash);
 const receipt={format:'code-ai-qualified-ui-deployment',version:1,release,sourceSha256:c.sourceSha256,beamBuildId:accepted.buildId,
  finishedAt:new Date().toISOString(),installed:true,frontendOnly:true,backendBaseline:c.baseline,backendAppSha256:backendHash,
  applicationPidBefore:pidBefore,applicationPidAfter:mainPid(),applicationRestarted:false,remoteServicesRestarted:false,
  nginxReloaded:true,interruptedAgentRuns:0,backendContracts:checks,retainedOldHashedAssets:true,staticPreflight:preflight,handoffAttempts:handoff.attempts,
  servedShellAndBundleHashesVerified:true,missingAssets404:true,personalBrowserUsed:false,
  browserVerification:'Not performed: session browser reports MODE_UNBOUND; component render tests run on approved BEAM builder',
  rollback:{nginxBackup:backup,priorBackend:c.baseline},files};
 await fs.writeFile(ops+'/final-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({...receipt,files:Object.keys(files).length}));
}catch(error){
 await fs.writeFile(nginxFile,config,{mode:0o644});execFileSync('nginx',['-t'],{stdio:'pipe'});if(activated)execFileSync('systemctl',['reload','nginx'],{stdio:'pipe'});
 await fs.rename(pointer,pointer+'.not-activated-'+Date.now());await fs.writeFile(ops+'/activation-failure-'+Date.now()+'.json',JSON.stringify({message:error.message,rolledBack:true,release,at:new Date().toISOString()},null,2),{mode:0o600});throw error;
}
