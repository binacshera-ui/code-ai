import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const ops='/root/projects/code-ai/ops/ai-work-mode-timing-20261020';
const c=JSON.parse(await fs.readFile(ops+'/capture.json','utf8'));
assert.equal(await fs.realpath('/root/projects/code-ai/dist'),c.baseline+'/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),c.predecessorPointer);
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const [file,digest] of Object.entries(c.files))assert.equal(sha(await fs.readFile(c.source+'/'+file)),digest,'Frozen source changed: '+file);
const free=await fs.statfs('/');assert.ok(free.bavail*free.bsize>Math.max(100_000_000_000,free.blocks*free.bsize*.15));
const resume=process.argv.includes('--resume-frontend');
const previous=resume?JSON.parse(await fs.readFile(ops+'/manual-build.json','utf8')):null;
const workspace=previous?.workspace||await fs.mkdtemp('/mnt/hdd/code-ai-builds/ai-work-mode-timing-manual-');
if(!resume){await fs.cp(c.source,workspace,{recursive:true});await fs.symlink(await fs.realpath(c.baseline+'/node_modules'),workspace+'/node_modules');}
const node='/root/.nvm/versions/node/v24.12.0/bin/node';
const buildId=previous?.buildId||randomUUID();
const receipt=previous||{format:'code-ai-owner-authorized-local-build',version:1,buildId,source:c.source,sourceSha256:c.sourceSha256,workspace,
 host:os.hostname(),authorization:'פרוס במסלול הישיר והידני',buildType:'owner-authorized-main-server-isolated-build',
 node,dependenciesReusedReadOnly:true,beamBuild:false,startedAt:new Date().toISOString(),checks:[]};
await fs.writeFile(ops+'/manual-build.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
const env={...process.env,PATH:path.dirname(node)+':'+process.env.PATH,NODE_OPTIONS:'--max-old-space-size=5120',
 CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_STORAGE_ROOT:workspace+'/.test-state'};
async function run(phase,args=['build-ai-timing.mjs',phase]){
 const log=await fs.open(workspace+'/'+phase+'.log','wx',0o600);
 const started=Date.now();const proc=spawn(node,args,{cwd:workspace,env,stdio:['ignore',log.fd,log.fd]});
 const code=await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',resolve);});await log.close();
 receipt.checks.push({phase,exitCode:code,durationMs:Date.now()-started,log:workspace+'/'+phase+'.log'});
 await fs.writeFile(ops+'/manual-build.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 assert.equal(code,0,phase+' failed; see '+workspace+'/'+phase+'.log');
 console.log(JSON.stringify({phase,passed:true,durationMs:Date.now()-started}));
}
if(resume){
 assert.equal(receipt.sourceSha256,c.sourceSha256);assert.ok(receipt.checks.some(x=>x.phase==='test'&&x.exitCode===0));
 assert.ok((await fs.readFile(workspace+'/build.log','utf8')).includes('ERR_PNPM_UNSAFE_MODULES_DIR'));
 for(const [file,digest]of Object.entries(c.files))assert.equal(sha(await fs.readFile(workspace+'/'+file)),digest);
 const require=createRequire(workspace+'/package.json');
 const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js');
 await run('backend-syntax',['--check',workspace+'/dist/app.mjs']);
 await run('frontend-build',[vite,'build']);
 receipt.buildRecovery='Direct Node/Vite entrypoint; pnpm auto-install refused shared dependency path before changing it. Same source, backend and passed tests retained.';
}else{await run('test');await run('build');}
receipt.files={};async function tree(rel='dist'){for(const e of(await fs.readdir(workspace+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(rel,e.name);if(e.isDirectory())await tree(f);else{assert.ok(e.isFile());receipt.files[f]=sha(await fs.readFile(workspace+'/'+f));}}}await tree();
receipt.passed=true;receipt.finishedAt=new Date().toISOString();
await fs.writeFile(ops+'/manual-build.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:true,buildId,workspace,sourceSha256:c.sourceSha256,artifactFiles:Object.keys(receipt.files).length}));
