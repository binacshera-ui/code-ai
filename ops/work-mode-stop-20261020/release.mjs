import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fleetClient} from '../focus-notifications-20261020/fleet-live.mjs';
const project='/root/projects/code-ai',ops=project+'/ops/work-mode-stop-20261020';
const node=process.execPath,read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const pointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
const predecessor=await read(path.dirname(pointer)+'/manifest.json');
const baseline=path.dirname(await fs.realpath(project+'/dist'));assert.equal(baseline,predecessor.backendBaseline);
const free=await fs.statfs('/');assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-mode-stop-source-20261020-');
await fs.cp(predecessor.capturedSource,source,{recursive:true});
const changed=['CodexMobileApp.tsx','WorkModeStatus.tsx','workModeUi.test.tsx','workModeOwnerActions.ts','workModeOwnerActions.test.ts']
  .map(f=>'client/src/components/codex/'+f);
for(const f of changed)await fs.copyFile(project+'/'+f,source+'/'+f);
await fs.copyFile(ops+'/build.mjs',source+'/build-ui-owner-stop.mjs');
const pkg=await read(source+'/package.json');pkg.scripts={test:'node build-ui-owner-stop.mjs test',build:'node build-ui-owner-stop.mjs build'};
await fs.writeFile(source+'/package.json',JSON.stringify(pkg,null,2)+'\n');
async function tree(root){const files={};async function walk(rel=''){for(const e of (await fs.readdir(root+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(rel,e.name);if(e.isDirectory())await walk(f);else{assert.ok(e.isFile());files[f]=sha(await fs.readFile(root+'/'+f));}}}await walk();return files;}
const files=await tree(source),prior=await tree(predecessor.capturedSource);
assert.ok(Object.keys(prior).every(f=>f in files));
assert.deepEqual(Object.keys(files).filter(f=>files[f]!==prior[f]).sort(),[...changed,'build-ui-owner-stop.mjs','package.json'].sort());
const sourceSha256=sha(JSON.stringify(files));
await fs.writeFile(ops+'/capture.json',JSON.stringify({source,sourceSha256,baseline,predecessorPointer:pointer,predecessor,
  changed,files,delivery:'owner-authorized-local',frontendOnly:true},null,2)+'\n',{mode:0o600});
const workspace=await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-mode-stop-build-20261020-');await fs.cp(source,workspace,{recursive:true});
async function ownership(dir){await fs.chown(dir,65534,65534);await fs.chmod(dir,0o755);for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=dir+'/'+e.name;if(e.isDirectory())await ownership(f);else{assert.ok(e.isFile());await fs.chown(f,65534,65534);await fs.chmod(f,0o644);}}}await ownership(workspace);
await fs.mkdir(workspace+'/node_modules');await fs.chown(workspace+'/node_modules',65534,65534);await fs.chmod(workspace+'/node_modules',0o755);
for(const name of await fs.readdir(project+'/node_modules'))if(!['.vite','.vite-temp','.cache'].includes(name))await fs.symlink(project+'/node_modules/'+name,workspace+'/node_modules/'+name);
const b={format:'code-ai-owner-authorized-local-build',version:1,buildId:randomUUID(),source,sourceSha256,workspace,
 authorization:'פרוס במסלול הישיר והידני',request:'עצירה והמשך במצב הגיוני ללא חסימת תוכנית',builder:'user-server',beamBuild:false,beamAttested:false,
 buildType:'owner-authorized-main-server-isolated-ui-build',buildUid:65534,startedAt:new Date().toISOString(),checks:[]};
const save=()=>fs.writeFile(ops+'/manual-build.json',JSON.stringify(b,null,2)+'\n',{mode:0o600});await save();
const runuser=execFileSync('sh',['-c','command -v runuser'],{encoding:'utf8'}).trim();
for(const phase of ['test','build']){
 const logPath=workspace+'/'+phase+'.log',log=await fs.open(logPath,'wx',0o600),started=Date.now();
 const child=spawn(runuser,['-u','nobody','--',node,'build-ui-owner-stop.mjs',phase],{cwd:workspace,
  env:{PATH:path.dirname(node)+':/usr/bin:/bin',HOME:workspace,LANG:'C.UTF-8',TZ:'UTC',NODE_OPTIONS:'--max-old-space-size=4096'},stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await log.close();
 b.checks.push({phase,exitCode:code,durationMs:Date.now()-started,log:logPath});await save();assert.equal(code,0,phase+' failed: '+logPath);
 console.log(JSON.stringify({phase,passed:true,durationMs:Date.now()-started}));
}
b.files=Object.fromEntries(Object.entries(await tree(workspace+'/dist/public')).map(([f,h])=>['dist/public/'+f,h]));
b.passed=true;b.finishedAt=new Date().toISOString();await save();
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),pointer);
const api=await fleetClient();const runs=await api('local','/work-mode-runs?profileId=developer&sessionKey=01a13216-0efb-77f0-be75-930e85233261');
assert.ok(Array.isArray(runs.runs));
await fs.writeFile(ops+'/live-save.json',JSON.stringify({passed:true,source,readOnly:true,checks:[{server:'local',runsReadable:true}],
 taskSubmissions:false,backendRestart:false},null,2)+'\n',{mode:0o600});
const env={...process.env,CODE_AI_UI_RELEASE_OPS:ops};
execFileSync(node,[project+'/ops/work-mode-save-20261020/publish.mjs','prepare'],{stdio:'inherit',env});
execFileSync(node,[project+'/ops/work-modes-ui-20261020/static-preflight.mjs','/var/www/code-ai-ui/releases/'+sourceSha256.slice(0,12),ops],{stdio:'inherit'});
execFileSync('flock',['-n','/run/code-ai-ui-deployment.lock',node,project+'/ops/work-mode-save-20261020/publish.mjs','activate'],{stdio:'inherit',env});
console.log(JSON.stringify({installed:true,frontendOnly:true,sourceSha256,backendUnchanged:true}));
