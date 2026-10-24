import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const project='/root/projects/code-ai',ops=project+'/ops/work-mode-save-20261020';
const pointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
const predecessor=JSON.parse(await fs.readFile(path.dirname(pointer)+'/manifest.json','utf8'));
const baseline=path.dirname(await fs.realpath(project+'/dist'));
assert.equal(baseline,predecessor.backendBaseline);
const changed=['useSessionWorkModes.ts','workModeTransport.ts','workModeTransport.test.ts'].map(f=>'client/src/components/codex/'+f);
const source=await fs.mkdtemp('/mnt/hdd/code-ai-builds/work-mode-save-source-20261020-');
await fs.cp(predecessor.capturedSource,source,{recursive:true});
for(const p of changed)await fs.copyFile(project+'/'+p,source+'/'+p);
await fs.copyFile(project+'/ops/work-modes-ui-20261020/build.mjs',source+'/build-mode-ui.mjs');
const ts=createRequire(project+'/package.json')('typescript');
const files={};
async function tree(root,rel=''){
 for(const e of(await fs.readdir(root+'/'+rel,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const p=path.join(rel,e.name);
  if(e.isDirectory())await tree(root,p);else{
   assert.ok(e.isFile());const bytes=await fs.readFile(root+'/'+p);
   if(/\.[cm]?[jt]sx?$/.test(p)){const s=ts.createSourceFile(p,bytes.toString(),ts.ScriptTarget.Latest,true);assert.equal(s.parseDiagnostics.length,0,'Syntax '+p);}
   files[p]=createHash('sha256').update(bytes).digest('hex');await fs.chmod(root+'/'+p,0o644);
  }
 }
}
await tree(source);
const original={};async function baselineTree(rel=''){for(const e of await fs.readdir(predecessor.capturedSource+'/'+rel,{withFileTypes:true})){const p=path.join(rel,e.name);if(e.isDirectory())await baselineTree(p);else original[p]=createHash('sha256').update(await fs.readFile(predecessor.capturedSource+'/'+p)).digest('hex');}}await baselineTree();
const actual=Object.keys(files).filter(p=>files[p]!==original[p]).sort();assert.deepEqual(actual,[...changed,'build-mode-ui.mjs'].sort());
assert.ok(Object.keys(original).every(p=>p in files),'No accepted source deletion');
const sourceSha256=createHash('sha256').update(JSON.stringify(files)).digest('hex');
const capture={source,sourceSha256,baseline,predecessorPointer:pointer,predecessor,changed:actual,files,createdAt:new Date().toISOString(),frontendOnly:true};
await fs.writeFile(ops+'/capture.json',JSON.stringify(capture,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({source,sourceSha256,changed:actual,files:Object.keys(files).length}));
