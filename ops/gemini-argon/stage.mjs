import assert from 'node:assert/strict';
import {readFile,writeFile,cp,symlink,realpath,mkdir,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const ops='/root/projects/code-ai/ops/gemini-argon';
const capture=JSON.parse(await readFile(ops+'/capture.json','utf8'));
const accepted=JSON.parse(await readFile(ops+'/beam-accepted.json','utf8'));
const imported=JSON.parse(execFileSync('/usr/local/bin/bina-build',['verify-import',accepted.buildId,'--import-root','/mnt/hdd/code-ai-builds/gemini-argon-imports'],{encoding:'utf8',stdio:'pipe',timeout:120000}));
assert.equal(await realpath('/root/projects/code-ai/dist'),capture.baseline+'/dist');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(capture.baseline+'/dist/app.mjs')),capture.baselineAppSha256);
const artifact=imported.artifact+'/dist';
const manifest=JSON.parse(await readFile(artifact+'/release-files.json','utf8'));
for(const [file,digest] of Object.entries(manifest.files))assert.equal(hash(await readFile(artifact+'/'+file)),digest);
const qualification=JSON.parse(await readFile(artifact+'/qualification/gemini-argon.json','utf8'));
assert.equal(qualification.model,'gemini-4-argon');
assert.ok(qualification.tests.checks.every(c=>c.passed));
const candidate='/mnt/hdd/code-ai-builds/gemini-argon-live-'+accepted.buildId;
await mkdir(candidate,{mode:0o755});
await cp(artifact,candidate,{recursive:true});
await chmod(candidate,0o755);
await symlink(await realpath(capture.baseline+'/node_modules'),candidate+'/node_modules','dir');
const previous=JSON.parse(await readFile(capture.baseline+'/deployment-request.json','utf8'));
// Determine the current upload entrypoint privately; unit command is never printed.
const unit=execFileSync('/usr/bin/systemctl',['cat','code-ai-upload-api.service'],{encoding:'utf8',stdio:'pipe'});
const modules=[...unit.matchAll(/^ExecStart=.*?(\/[A-Za-z0-9_./-]+\/dist\/server\.js)/gm)].map(m=>m[1]);
assert.ok(modules.length>0);
const uploadBaselineModule=modules.at(-1);
const request={...previous,id:'main',buildId:accepted.buildId,candidate,baseline:capture.baseline,
  expectedBaselineSha256:hash(await readFile(capture.baseline+'/dist/server.js')),
  expectedServerSha256:manifest.files['dist/server.js'],expectedAppSha256:manifest.files['dist/app.mjs'],
  uploadBaselineModule,uploadBaselineSha256:hash(await readFile(uploadBaselineModule)),
  attemptId:'gemini-argon',releaseOrder:String(Date.now()),buildOrigin:'beam',localBuildExplicitlyAuthorized:false,
  requestFile:candidate+'/deployment-request.json'};
await writeFile(request.requestFile,JSON.stringify(request,null,2)+'\n',{mode:0o600,flag:'wx'});
execFileSync(request.nodeExecutable,[candidate+'/install.mjs','preflight',request.requestFile],{cwd:candidate,encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'},timeout:120000});
await writeFile(ops+'/staged.json',JSON.stringify({request,artifact:imported.artifact,artifactTreeSha256:imported.artifactTreeSha256},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({candidate,buildId:request.buildId,qualified:true,activationPerformed:false}));
