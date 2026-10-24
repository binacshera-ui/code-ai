import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import{createHash,randomUUID}from'node:crypto';import{execFileSync}from'node:child_process';
const ops='/root/projects/code-ai/ops/ai-work-mode-timing-20261020';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const c=await read(ops+'/capture.json'),b=await read(ops+'/manual-build.json');
const digest=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
assert.equal(b.passed,true);assert.equal(b.beamBuild,false);assert.equal(b.sourceSha256,c.sourceSha256);
assert.equal(await fs.realpath('/root/projects/code-ai/dist'),c.baseline+'/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),c.predecessorPointer);
for(const [file,sha]of Object.entries(c.files))assert.equal(await digest(c.source+'/'+file),sha,'Captured source changed');
for(const [file,sha]of Object.entries(b.files))assert.equal(await digest(b.workspace+'/'+file),sha,'Built artifact changed');
const manifest=await read(c.baseline+'/release-files.json');
for(const [file,sha]of Object.entries(manifest.files))assert.equal(await digest(c.baseline+'/'+file),sha,'Accepted predecessor changed');
const candidate='/mnt/hdd/code-ai-builds/work-modes-ai-timing-20261020-'+c.sourceSha256.slice(0,12);
await fs.mkdir(candidate,{mode:0o755});
for(const file of Object.keys(manifest.files)){
 await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(c.baseline+'/'+file,candidate+'/'+file);
}
for(const file of c.changed){await fs.mkdir(path.dirname(candidate+'/'+file),{recursive:true});await fs.copyFile(c.source+'/'+file,candidate+'/'+file);}
await fs.cp(b.workspace+'/dist',candidate+'/dist',{recursive:true,force:true});
await fs.symlink(await fs.realpath(c.baseline+'/node_modules'),candidate+'/node_modules');
const proof={format:'code-ai-manual-timing-qualified',version:1,buildId:b.buildId,sourceSha256:c.sourceSha256,
 buildType:b.buildType,authorization:b.authorization,host:b.host,checks:b.checks,source:c.source,artifact:b.workspace,beamBuild:false,baseline:c.baseline};
await fs.writeFile(candidate+'/qualification/ai-timing.json',JSON.stringify(proof,null,2)+'\n');
await fs.writeFile(candidate+'/release.json',JSON.stringify({version:path.basename(candidate),sourceSha256:c.sourceSha256,expectedCodexVersion:'0.163.0',builtAt:b.finishedAt,buildType:b.buildType,buildId:b.buildId},null,2)+'\n');
const files={};async function walk(rel=''){for(const e of await fs.readdir(candidate+'/'+rel,{withFileTypes:true})){const file=path.join(rel,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())files[file]=await digest(candidate+'/'+file);else assert.equal(file,'node_modules');}}await walk();
await fs.writeFile(candidate+'/release-files.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2)+'\n');
const req=await read(c.baseline+'/fleet-request.json');
Object.assign(req,{candidate,baseline:c.baseline,buildId:randomUUID(),releaseOrder:String(Date.now()),attemptId:'ai-timing-manual-'+randomUUID(),ownerAuthorizedInterruption:true,
 expectedBaselineSha256:await digest(c.baseline+'/dist/server.js'),expectedServerSha256:await digest(candidate+'/dist/server.js'),expectedAppSha256:await digest(candidate+'/dist/app.mjs'),
 uploadBaselineModule:c.baseline+'/dist/server.js',uploadBaselineSha256:await digest(c.baseline+'/dist/server.js')});delete req.featureEnvironmentFile;
await fs.writeFile(candidate+'/fleet-request.json',JSON.stringify(req,null,2)+'\n',{mode:0o600,flag:'wx'});
const run=(args)=>JSON.parse(execFileSync(req.nodeExecutable,args,{encoding:'utf8',cwd:candidate,timeout:120000}));
assert.equal(run([candidate+'/scripts/verify-runtime-programs.mjs']).runtimeProgramsVerified,true);
const preflight=run([candidate+'/install.mjs','preflight',candidate+'/fleet-request.json']);assert.equal(preflight.prepared,true);
c.delivery='owner-authorized-local';c.activationBackendBaseline=candidate;
await fs.writeFile(ops+'/capture.json',JSON.stringify(c,null,2)+'\n',{mode:0o600});
const prepared={candidate,baseline:c.baseline,sourceSha256:c.sourceSha256,buildId:b.buildId,preflight,buildType:b.buildType,preparedAt:new Date().toISOString()};
await fs.writeFile(ops+'/prepared.json',JSON.stringify(prepared,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(prepared));
