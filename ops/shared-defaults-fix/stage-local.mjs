import assert from 'node:assert/strict';
import {readFile,writeFile,cp,symlink,realpath} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
const root='/root/projects/code-ai',source='/mnt/hdd/code-ai-builds/shared-defaults-source-XWotts/dist';
const baseline='/mnt/hdd/code-ai-builds/native-unlock-live-b6196953-8f40-4acb-a040-1b31a912bea6';
assert.equal(await realpath(root+'/dist'),baseline+'/dist');
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const manifest=JSON.parse(await readFile(source+'/release-files.json','utf8'));
for(const [p,sha]of Object.entries(manifest.files))assert.equal(await digest(source+'/'+p),sha);
const buildId=randomUUID(),candidate='/mnt/hdd/code-ai-builds/shared-defaults-local-'+buildId;
await cp(source,candidate,{recursive:true});await symlink(await realpath(baseline+'/node_modules'),candidate+'/node_modules','dir');
const old=JSON.parse(await readFile(baseline+'/deployment-request.json','utf8'));
const request={...old,buildId,baseline,candidate,expectedBaselineSha256:await digest(baseline+'/dist/server.js'),
 expectedServerSha256:manifest.files['dist/server.js'],expectedAppSha256:manifest.files['dist/app.mjs'],
 uploadBaselineModule:baseline+'/dist/server.js',uploadBaselineSha256:await digest(baseline+'/dist/server.js'),
 ownerAuthorizedInterruption:true,localBuildExplicitlyAuthorized:true,buildOrigin:'local',attemptId:'shared-defaults'};
await writeFile(candidate+'/deployment-request.json',JSON.stringify(request,null,2),{mode:0o600});
await writeFile(root+'/ops/shared-defaults-fix/staged-local.json',JSON.stringify(request,null,2),{mode:0o600});
console.log(JSON.stringify({candidate,buildId,buildOrigin:'local',verifiedFiles:Object.keys(manifest.files).length}));
