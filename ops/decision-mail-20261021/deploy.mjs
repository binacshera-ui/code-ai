import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const repo='/root/projects/bina-cshera-root/bina-cshera-2.0',ops='/root/projects/code-ai/ops/decision-mail-20261021';
const node=process.execPath,sha=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const pm2bin='/root/.nvm/versions/node/v24.12.0/bin/pm2';
const list=()=>JSON.parse(execFileSync(pm2bin,['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}}));
const current=()=>{const p=list().find(p=>p.name==='bina-cshera-failure-runtime');assert.ok(p&&p.pid>0);return p;};
async function tree(dir){const out={};async function walk(rel=''){for(const e of(await fs.readdir(dir+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='node_modules')continue;const f=path.join(rel,e.name);if(e.isDirectory())await walk(f);else if(e.isFile())out[f]=sha(await fs.readFile(dir+'/'+f));}}await walk();return out;}
async function own(dir){await fs.chown(dir,65534,65534);await fs.chmod(dir,0o755);for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=dir+'/'+e.name;if(e.isDirectory())await own(f);else if(e.isFile()){await fs.chown(f,65534,65534);await fs.chmod(f,0o644);}}}
const service='platform/failure-handling';
if(process.argv[2]==='prepare'){
 const free=await fs.statfs('/');assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
 const p=current();assert.equal(p.pm2_env.pm_exec_path,repo+'/'+service+'/src/index.js');
 const workspace=process.argv[3]||await fs.mkdtemp('/mnt/hdd/code-ai-builds/decision-mail-20261021-');
 assert.match(workspace,/^\/mnt\/hdd\/code-ai-builds\/decision-mail-20261021-[a-zA-Z0-9]+$/);
 for(const component of ['failure-handling','shared-runtime']){
  const rel='platform/'+component;await fs.mkdir(workspace+'/'+rel,{recursive:true});
  for(const file of ['src','package.json',...(component==='failure-handling'?['tests','package-lock.json']:[])])await fs.cp(repo+'/'+rel+'/'+file,workspace+'/'+rel+'/'+file,{recursive:true});
 }
 await fs.copyFile(ops+'/qualify.mjs',workspace+'/qualify.mjs');
 await fs.copyFile('/home/developer/.codex/skills/live-production-deployment/scripts/verify-release-candidate.mjs',workspace+'/verify-release-candidate.mjs');
 const files=await tree(workspace),digest=sha(JSON.stringify(files));
 await own(workspace);await fs.symlink(repo+'/'+service+'/node_modules',workspace+'/'+service+'/node_modules').catch(e=>{if(e.code!=='EEXIST')throw e;});
 const logPath=workspace+(process.argv[3]?'/qualification-resume.log':'/qualification.log'),log=await fs.open(logPath,'wx',0o600);
 const runuser=execFileSync('sh',['-c','command -v runuser'],{encoding:'utf8'}).trim();
 const child=spawn(runuser,['-u','nobody','--',node,workspace+'/qualify.mjs',workspace,workspace+'/qualification.json'],{cwd:workspace,
  env:{PATH:path.dirname(node)+':/usr/bin:/bin',HOME:workspace,LANG:'C.UTF-8'},stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});await log.close();
 assert.equal(code,0,'Qualification failed: '+logPath);
 const qualification=await read(workspace+'/qualification.json');assert.equal(qualification.passed,true);
 const state={workspace,digest,files,qualification,logPath,original:{pid:p.pid,id:p.pm_id,script:p.pm2_env.pm_exec_path,cwd:p.pm2_env.pm_cwd},
  builder:'user-server',beamAttested:false,qualificationUid:65534,preparedAt:new Date().toISOString(),service:'bina-cshera-failure-runtime'};
 await fs.writeFile(ops+'/candidate.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({prepared:true,digest,workspace,qualification}));
}else if(process.argv[2]==='activate'){
 const c=await read(ops+'/candidate.json'),p=current();assert.equal(p.pid,c.original.pid);assert.equal(p.pm_id,c.original.id);
 const hashes=await tree(c.workspace);for(const[f,h]of Object.entries(c.files))assert.equal(hashes[f],h,'Candidate changed: '+f);
 for(const f of Object.keys(c.files).filter(f=>f.startsWith('platform/')))assert.equal(sha(await fs.readFile(repo+'/'+f)),c.files[f],'Source advanced: '+f);
 const rollback=await fs.mkdtemp('/mnt/hdd/code-ai-builds/decision-mail-rollback-20261021-');
 for(const component of ['failure-handling','shared-runtime'])await fs.cp(c.workspace+'/platform/'+component,rollback+'/platform/'+component,{recursive:true,dereference:false});
 const prior=execFileSync('git',['show','HEAD:platform/failure-handling/src/core/failure-service.js'],{cwd:repo});
 await fs.writeFile(rollback+'/'+service+'/src/core/failure-service.js',prior);await fs.chmod(rollback,0o755);
 process.env.PM2_HOME='/root/.pm2';const require=createRequire(import.meta.url),pm2=require('/root/.nvm/versions/node/v24.12.0/lib/node_modules/pm2');
 await new Promise((resolve,reject)=>pm2.connect(e=>e?reject(e):resolve()));
 const restart=root=>new Promise((resolve,reject)=>pm2.restart({apps:[{name:c.service,script:root+'/'+service+'/src/index.js',cwd:root+'/'+service,
  interpreter:node,kill_timeout:15000,autorestart:true}]},e=>e?reject(e):resolve()));
 const {loadRuntimeConfig}=await import(pathToFileURL(c.workspace+'/'+service+'/src/config/runtime.js'));
 const cfg=await loadRuntimeConfig(),url='http://127.0.0.1:'+cfg.server.port,headers=cfg.server.authToken?{authorization:cfg.server.authToken}:{};
 const health=async()=>{const r=await fetch(url+'/healthz',{headers:{...headers,connection:'close'},signal:AbortSignal.timeout(4000)});assert.equal(r.status,200);assert.equal((await r.json()).service,'failure-handling');};
 const receipt={...c,rollback,startedAt:new Date().toISOString(),personalRecipientCause:{mode:'shadow',shadowTo:'ra0586501257@gmail.com'},codeAiRestarted:false,otherServicesRestarted:false};
 try{
  await health();
  // This legacy service has no background worker. Require no established HTTP
  // requests before its one scoped fork-mode replacement, never restart Codex.
  for(let n=0;n<3;n++){
   const sockets=execFileSync('ss',['-Hnt','state','established','sport','=',':'+cfg.server.port],{encoding:'utf8'}).trim();
   assert.equal(sockets,'','Active failure-handling request; retry this activation after it drains');
   await new Promise(resolve=>setTimeout(resolve,300));
  }
  const started=Date.now();await restart(c.workspace);
  let ready=false;for(let n=0;n<20;n++){try{await health();ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}
  assert.equal(ready,true,'New service not ready');const fresh=current();
  assert.equal(fresh.pm2_env.pm_exec_path,c.workspace+'/'+service+'/src/index.js');assert.notEqual(fresh.pid,p.pid);
  const response=await fetch(url+'/v1/incident-cases?limit=20',{headers,signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
  const cases=(await response.json()).incident_cases;assert.ok(Array.isArray(cases));
  receipt.casesReadable=true;receipt.decisionCasesRetained=cases.filter(c=>c.metadata?.decision_mode===true).length;
  receipt.replacementAndReadinessMs=Date.now()-started;receipt.activePid=fresh.pid;receipt.installed=true;
  await new Promise((resolve,reject)=>pm2.dump(e=>e?reject(e):resolve()));receipt.pm2Saved=true;
 }catch(error){receipt.error=error.message;if(current().pid!==p.pid){await restart(rollback);await health();receipt.rolledBack=true;}throw error;}
 finally{pm2.disconnect();receipt.finishedAt=new Date().toISOString();await fs.writeFile(ops+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});}
 console.log(JSON.stringify({installed:receipt.installed,pid:receipt.activePid,replacementAndReadinessMs:receipt.replacementAndReadinessMs,casesReadable:receipt.casesReadable,codeAiRestarted:false}));
}else throw Error('Expected prepare or activate');
