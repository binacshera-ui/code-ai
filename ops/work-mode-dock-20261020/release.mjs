import fs from'node:fs/promises';import path from'node:path';import os from'node:os';import assert from'node:assert/strict';
import{createHash,randomUUID}from'node:crypto';import{spawn,execFileSync}from'node:child_process';
import{fleetClient}from'../focus-notifications-20261020/fleet-live.mjs';
const project='/root/projects/code-ai',ops=project+'/ops/work-mode-dock-20261020',node='/root/.nvm/versions/node/v24.12.0/bin/node';
const runuser=execFileSync('sh',['-c','command -v runuser'],{encoding:'utf8'}).trim();assert.ok(path.isAbsolute(runuser));
const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const resume=process.argv.includes('--resume-build'),previous=resume?await read(ops+'/manual-build.json'):null;
const pointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),predecessor=await read(path.dirname(pointer)+'/manifest.json');
const baseline=path.dirname(await fs.realpath(project+'/dist'));assert.equal(baseline,predecessor.backendBaseline);
const free=await fs.statfs('/');assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
const source=previous?.source||await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-mode-dock-source-20261020-');
const changed=['CodexMobileApp.tsx','WorkModeStatus.tsx','workModeUi.test.tsx'].map(f=>'client/src/components/codex/'+f);
if(!resume){
await fs.cp(predecessor.capturedSource,source,{recursive:true});
for(const f of changed)await fs.copyFile(project+'/'+f,source+'/'+f);
await fs.copyFile(ops+'/build.mjs',source+'/build-ui-dock.mjs');
const pkg=await read(source+'/package.json');pkg.scripts={test:'node build-ui-dock.mjs test',build:'node build-ui-dock.mjs build'};
await fs.writeFile(source+'/package.json',JSON.stringify(pkg,null,2)+'\n');
}
async function hashTree(root){const files={};async function walk(rel=''){for(const e of(await fs.readdir(root+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(rel,e.name);if(e.isDirectory())await walk(f);else{assert.ok(e.isFile());files[f]=sha(await fs.readFile(root+'/'+f));}}}await walk();return files;}
const files=await hashTree(source),original=await hashTree(predecessor.capturedSource);
assert.ok(Object.keys(original).every(f=>f in files));
assert.deepEqual(Object.keys(files).filter(f=>files[f]!==original[f]).sort(),[...changed,'build-ui-dock.mjs','package.json'].sort(),'Only declared UI changes allowed');
const sourceSha256=sha(JSON.stringify(files));
const c={source,sourceSha256,baseline,predecessorPointer:pointer,predecessor,changed,files,delivery:'owner-authorized-local',frontendOnly:true,createdAt:new Date().toISOString()};
await fs.writeFile(ops+'/capture.json',JSON.stringify(c,null,2)+'\n',{mode:0o600});
const workspace=previous?.workspace||await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-mode-dock-build-20261020-');if(!resume)await fs.cp(source,workspace,{recursive:true});
async function buildOwner(dir){await fs.chown(dir,65534,65534);await fs.chmod(dir,0o755);for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=dir+'/'+e.name;if(e.isDirectory())await buildOwner(f);else{assert.ok(e.isFile());await fs.chown(f,65534,65534);await fs.chmod(f,0o644);}}}if(!resume)await buildOwner(workspace);
// Keep dependency contents shared/read-only, but let Vite create its config and
// optimization caches in this build's own modules directory, never production's.
if(await fs.lstat(workspace+'/node_modules').then(s=>s.isSymbolicLink()).catch(()=>false))await fs.rename(workspace+'/node_modules',workspace+'/node_modules.shared-readonly');
await fs.mkdir(workspace+'/node_modules',{recursive:true});await fs.chown(workspace+'/node_modules',65534,65534);await fs.chmod(workspace+'/node_modules',0o755);
for(const name of await fs.readdir(project+'/node_modules')){
 if(['.vite','.vite-temp','.cache'].includes(name))continue;
 try{await fs.symlink(project+'/node_modules/'+name,workspace+'/node_modules/'+name);}catch(e){if(e.code!=='EEXIST')throw e;}
}
const b=previous||{format:'code-ai-owner-authorized-local-build',version:1,buildId:randomUUID(),source,sourceSha256,workspace,host:os.hostname(),
 authorization:'פרוס במסלול הישיר והידני',request:'תוכנית המשימות בכפתור בתחתית השיחה — UI בלבד',
 buildType:'owner-authorized-main-server-isolated-ui-build',builder:'user-server',beamBuild:false,beamAttested:false,buildUid:65534,startedAt:new Date().toISOString(),checks:[]};
const saveBuild=()=>fs.writeFile(ops+'/manual-build.json',JSON.stringify(b,null,2)+'\n',{mode:0o600});await saveBuild();
assert.equal(b.sourceSha256,sourceSha256);
for(const phase of['test','build']){
 if(resume&&b.checks.some(x=>x.phase===phase&&x.exitCode===0))continue;
 const logPath=workspace+'/'+phase+(resume?'-resume':'')+'.log',log=await fs.open(logPath,'wx',0o600),started=Date.now();
 const proc=spawn(runuser,['-u','nobody','--',node,'build-ui-dock.mjs',phase],{cwd:workspace,
  env:{PATH:path.dirname(node)+':/usr/bin:/bin',HOME:workspace,LANG:'C.UTF-8',TZ:'UTC',NODE_OPTIONS:'--max-old-space-size=4096'},stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',resolve);});await log.close();
 b.checks.push({phase,exitCode:code,durationMs:Date.now()-started,log:logPath});await saveBuild();assert.equal(code,0,'UI '+phase+' failed; inspect saved log');
 console.log(JSON.stringify({phase,passed:true,durationMs:Date.now()-started}));
}
b.files=Object.fromEntries(Object.entries(await hashTree(workspace+'/dist/public')).map(([f,h])=>['dist/public/'+f,h]));b.passed=true;b.finishedAt=new Date().toISOString();await saveBuild();
assert.equal(await fs.realpath(project+'/dist'),baseline+'/dist');assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),pointer);
const api=await fleetClient(),checks=[];
for(const [server,profile]of[['local','developer'],['beam-10g','beam-admin'],['pci','pci-admin']]){
 const prior=await read(project+'/ops/work-modes-routing-20261020/'+server+'-acceptance.json');
 const prefs=await api(server,'/session-focus-mode?'+new URLSearchParams({profileId:profile,sessionKey:prior.sessionId}));
 const runs=await api(server,'/work-mode-runs?'+new URLSearchParams({profileId:profile,sessionKey:prior.sessionId}));
 assert.ok(prefs.focusMode&&Array.isArray(runs.runs));checks.push({server,readOnly:true,preferencesReadable:true,runsReadable:true});
}
await fs.writeFile(ops+'/live-save.json',JSON.stringify({passed:true,source,readOnly:true,preferenceWrites:false,taskSubmissions:false,checks},null,2)+'\n',{mode:0o600});
const env={...process.env,CODE_AI_UI_RELEASE_OPS:ops};
execFileSync(node,[project+'/ops/work-mode-save-20261020/publish.mjs','prepare'],{stdio:'inherit',env});
execFileSync(node,[project+'/ops/work-modes-ui-20261020/static-preflight.mjs','/var/www/code-ai-ui/releases/'+sourceSha256.slice(0,12),ops],{stdio:'inherit'});
execFileSync('flock',['-n','/run/code-ai-ui-deployment.lock',node,project+'/ops/work-mode-save-20261020/publish.mjs','activate'],{stdio:'inherit',env});
console.log(JSON.stringify({installed:true,frontendOnly:true,sourceSha256,backendUnchanged:true,workspace,buildUid:65534}));
