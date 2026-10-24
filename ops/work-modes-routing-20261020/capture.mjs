import fs from'node:fs/promises';import path from'node:path';import{createHash}from'node:crypto';import assert from'node:assert/strict';
const ops='/root/projects/code-ai/ops/work-modes-routing-20261020',project='/root/projects/code-ai';
const baseline=path.dirname(await fs.realpath(project+'/dist'));
assert.equal(path.basename(baseline),'work-modes-routing-20261020-31df82cf932f');
const changed=['server/index.ts','server/codexRoutes.ts','server/codexWorkModeRuntime.ts','server/codexRuntimePrograms.mjs',
 'server/codexRuntimePrograms.test.mjs','server/incidentDecisionCenter.ts','server/incidentDecisionCenter.test.ts',
 'server/incidentRemoteGateway.ts','server/incidentRemoteGateway.test.ts','server/incidentRemoteWake.ts','server/incidentRemoteWake.test.ts',
 'server/codexWorkModeRoutes.ts','server/codexWorkModeRoutes.test.ts'];
for(const file of changed)await fs.access(project+'/'+file);
const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-modes-routing-source-20261020-');
for(const file of ['server','shared','scripts','chrome-extension','package.json','package-lock.json'])await fs.cp(baseline+'/'+file,source+'/'+file,{recursive:true});
// The approved BEAM Node profile uses pnpm. Keep the locks from the qualified
// work-mode source; package scripts change, dependency declarations do not.
for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml'])await fs.copyFile('/mnt/hdd/code-ai-builds/focus-notifications-20261020-usXxk3/'+file,source+'/'+file);
for(const file of changed)await fs.copyFile(project+'/'+file,source+'/'+file);
await fs.copyFile(ops+'/build.mjs',source+'/build-work-modes.mjs');
const pkg=JSON.parse(await fs.readFile(source+'/package.json','utf8'));
pkg.scripts={test:'node build-work-modes.mjs test',build:'node build-work-modes.mjs build'};
await fs.writeFile(source+'/package.json',JSON.stringify(pkg,null,2)+'\n');
const files={};async function walk(relative=''){for(const e of(await fs.readdir(source+'/'+relative,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,e.name);if(e.isDirectory())await walk(name);else if(e.isFile())files[name]=createHash('sha256').update(await fs.readFile(source+'/'+name)).digest('hex');else throw Error('Unexpected source link');}}
await walk();for(const file of Object.keys(files))await fs.chmod(source+'/'+file,0o644);
const sourceSha256=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const identity={format:'code-ai-work-modes-routing-source',version:1,source,baseline,changed,files,sourceSha256,createdAt:new Date().toISOString(),scope:['main','beam-10g','pci'],frontendReusedUnchanged:true};
await fs.writeFile(ops+'/capture.json',JSON.stringify(identity,null,2),{mode:0o600});console.log(JSON.stringify({source,baseline,sourceSha256,files:Object.keys(files).length}));
