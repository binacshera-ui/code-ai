import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{createHash,randomUUID}from'node:crypto';import{execFileSync}from'node:child_process';
const ops='/root/projects/code-ai/ops/work-modes-routing-20261020';
const capture=JSON.parse(await fs.readFile(ops+'/capture.json','utf8'));
const current=JSON.parse(await fs.readFile(ops+'/build-current.json','utf8'));
const accepted=JSON.parse(await fs.readFile(current.acceptedFile,'utf8'));
const result=JSON.parse(await fs.readFile(current.resultFile,'utf8'));
assert.equal(accepted.observedStatus,'IMPORTED');assert.equal(result.buildId,accepted.buildId);
const importRoot='/mnt/hdd/code-ai-builds/work-modes-routing-import-20261020';
const verification=JSON.parse(execFileSync('/usr/local/bin/bina-build',['verify-import',accepted.buildId,'--import-root',importRoot],{encoding:'utf8'}));
assert.equal(path.dirname(await fs.realpath('/root/projects/code-ai/dist')),capture.baseline,'Accepted predecessor changed');
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const manifest=JSON.parse(await fs.readFile(capture.baseline+'/release-files.json','utf8'));
for(const [file,sha]of Object.entries(manifest.files))assert.equal(await digest(capture.baseline+'/'+file),sha,'Accepted release changed');
const candidate='/mnt/hdd/code-ai-builds/work-modes-routing-20261020-'+capture.sourceSha256.slice(0,12);
await fs.mkdir(candidate,{mode:0o755});
// Only qualified public release members cross the boundary. Never copy auth
// environment files, queue backups or a predecessor's deployment requests.
for(const file of Object.keys(manifest.files)){
 await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(capture.baseline+'/'+file,candidate+'/'+file);
}
for(const file of capture.changed){await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(capture.source+'/'+file,candidate+'/'+file);}
const artifact=result.artifact||path.join(result.destination,'artifact');
assert.ok(artifact.startsWith(importRoot+'/'));
await fs.cp(artifact+'/dist',candidate+'/dist',{recursive:true,force:true});
await fs.copyFile(ops+'/install.mjs',candidate+'/install.mjs');
await fs.symlink(await fs.realpath(capture.baseline+'/node_modules'),candidate+'/node_modules');
const buildProof={format:'code-ai-work-modes-routing-qualified',version:1,sourceSha256:capture.sourceSha256,
 baseline:capture.baseline,buildId:accepted.buildId,beamSourceSha256:accepted.request.sourceSha256,
 importedArtifact:artifact,verification,changed:capture.changed,frontendReusedUnchanged:true,
 foundation:'Existing canonical case backend and per-host authenticated API; no new store/engine or copied canonical credentials'};
await fs.writeFile(candidate+'/qualification/work-modes-routing.json',JSON.stringify(buildProof,null,2)+'\n');
await fs.writeFile(candidate+'/release.json',JSON.stringify({version:path.basename(candidate),sourceSha256:capture.sourceSha256,
 expectedCodexVersion:'0.163.0',builtAt:new Date().toISOString(),buildType:'beam-verified-backend-successor',buildId:accepted.buildId},null,2)+'\n');
const files={};async function walk(relative=''){for(const e of await fs.readdir(candidate+'/'+relative,{withFileTypes:true})){const file=path.join(relative,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())files[file]=await digest(candidate+'/'+file);else assert.equal(file,'node_modules');}}
await walk();await fs.writeFile(candidate+'/release-files.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2)+'\n');
const req=JSON.parse(await fs.readFile(capture.baseline+'/fleet-request.json','utf8'));
Object.assign(req,{candidate,baseline:capture.baseline,buildId:randomUUID(),releaseOrder:String(Date.now()),attemptId:'work-modes-routing-20261020',
 ownerAuthorizedInterruption:true,expectedBaselineSha256:await digest(capture.baseline+'/dist/server.js'),expectedServerSha256:await digest(candidate+'/dist/server.js'),
 expectedAppSha256:await digest(candidate+'/dist/app.mjs'),uploadBaselineModule:capture.baseline+'/dist/server.js',uploadBaselineSha256:await digest(capture.baseline+'/dist/server.js')});
delete req.featureEnvironmentFile;
await fs.writeFile(candidate+'/fleet-request.json',JSON.stringify(req,null,2)+'\n',{mode:0o600,flag:'wx'});
const runtime=JSON.parse(execFileSync(req.nodeExecutable,[candidate+'/scripts/verify-runtime-programs.mjs'],{encoding:'utf8',cwd:candidate}));assert.equal(runtime.runtimeProgramsVerified,true);assert.ok(runtime.programs.some(p=>p.name==='workMode'));
const preflight=JSON.parse(execFileSync(req.nodeExecutable,[candidate+'/install.mjs','preflight',candidate+'/fleet-request.json'],{encoding:'utf8',cwd:candidate}));assert.equal(preflight.prepared,true);
const prepared={candidate,baseline:capture.baseline,sourceSha256:capture.sourceSha256,buildId:accepted.buildId,preflight,runtimePrograms:runtime.programs.length,preparedAt:new Date().toISOString()};
await fs.writeFile(ops+'/prepared.json',JSON.stringify(prepared,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(prepared));
