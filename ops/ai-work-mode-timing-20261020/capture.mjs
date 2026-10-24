import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const project='/root/projects/code-ai',ops=project+'/ops/ai-work-mode-timing-20261020';
const predecessorPointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
const predecessor=JSON.parse(await fs.readFile(path.dirname(predecessorPointer)+'/manifest.json','utf8'));
const baseline=path.dirname(await fs.realpath(project+'/dist'));assert.equal(baseline,predecessor.backendBaseline);
const changed=['server/codexRationalMode.ts','server/codexRationalMode.test.ts','server/codexWorkModeRuntime.ts','server/codexFocusMode.ts',
 'shared/codexWorkModes.ts','scripts/codex-work-mode.mjs',...['FocusModeDialog.tsx','WorkModeCards.tsx','WorkModeStatus.tsx','workModePreferences.ts','workModeUi.test.tsx','workModeTransport.test.ts'].map(f=>'client/src/components/codex/'+f)];
const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/ai-work-mode-timing-source-20261020-');
await fs.cp(predecessor.capturedSource,source,{recursive:true});
for(const file of changed)await fs.copyFile(project+'/'+file,source+'/'+file);
await fs.copyFile(ops+'/build.mjs',source+'/build-ai-timing.mjs');
const pkg=JSON.parse(await fs.readFile(source+'/package.json','utf8'));pkg.scripts={test:'node build-ai-timing.mjs test',build:'node build-ai-timing.mjs build'};
await fs.writeFile(source+'/package.json',JSON.stringify(pkg,null,2)+'\n');
const sha=b=>createHash('sha256').update(b).digest('hex'),ts=createRequire(project+'/package.json')('typescript');
async function tree(root){const files={};async function walk(rel=''){for(const e of(await fs.readdir(root+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(rel,e.name);if(e.isDirectory())await walk(p);else{assert.ok(e.isFile());const bytes=await fs.readFile(root+'/'+p);if(/\.[cm]?[jt]sx?$/.test(p))assert.equal(ts.createSourceFile(p,bytes.toString(),ts.ScriptTarget.Latest,true).parseDiagnostics.length,0,'Syntax '+p);files[p]=sha(bytes);await fs.chmod(root+'/'+p,0o644);}}}await walk();return files;}
const files=await tree(source),old=await tree(predecessor.capturedSource);
assert.ok(Object.keys(old).every(f=>f in files),'No source deletion');
assert.deepEqual(Object.keys(files).filter(f=>files[f]!==old[f]).sort(),[...changed,'package.json','build-ai-timing.mjs'].sort());
const sourceSha256=sha(JSON.stringify(files));
const c={source,sourceSha256,baseline,predecessorPointer,predecessor,changed,files,importRoot:'/mnt/hdd/code-ai-builds/ai-work-mode-timing-import-20261020',createdAt:new Date().toISOString()};
await fs.writeFile(ops+'/capture.json',JSON.stringify(c,null,2)+'\n',{mode:0o600});
await fs.mkdir('/mnt/hdd/code-ai-builds/ai-work-mode-timing-import-20261020',{recursive:true});
console.log(JSON.stringify({source,sourceSha256,files:Object.keys(files).length,changed}));
