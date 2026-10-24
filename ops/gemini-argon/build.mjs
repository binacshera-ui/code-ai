import {cp,mkdir,readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(path.resolve('payload/package.json'));
const {build}=require('esbuild');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const retained=JSON.parse(await readFile('retained/release-files.json','utf8'));
for(const [file,digest] of Object.entries(retained.files))assert.equal(hash(await readFile('retained/'+(file.startsWith('dist/')?'runtime/'+file.slice(5):file))),digest);
await cp('retained','dist',{recursive:true});
await rename('dist/runtime','dist/dist');
await build({absWorkingDir:path.resolve('payload'),entryPoints:['server/index.ts'],outfile:path.resolve('dist/dist/app.mjs'),bundle:true,platform:'node',format:'esm',external:['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws'],logLevel:'warning'});
await cp('payload/skills/gemini-ux-partner/SKILL.md','dist/skills/gemini-ux-partner/SKILL.md');
await mkdir('dist/qualification',{recursive:true});
for(const [file,name] of [['scripts/design-mode-gemini-smoke.ts','argon-design-smoke.mjs'],['scripts/ux-mode-gemini-smoke.ts','argon-ux-smoke.mjs'],['ops/gemini-argon/cli-smoke.ts','argon-cli-smoke.mjs']]){
  await build({absWorkingDir:path.resolve('payload'),entryPoints:[file],outfile:path.resolve('dist/qualification/'+name),bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});
}
const source=JSON.parse(await readFile('source-contract.json','utf8'));
for(const [file,digest] of Object.entries(source.sourceHashes))assert.equal(hash(await readFile('payload/'+file)),digest);
const tests=JSON.parse(await readFile('gemini-argon-tests.json','utf8'));
await writeFile('dist/qualification/gemini-argon.json',JSON.stringify({format:'code-ai-gemini-argon-qualified',version:1,model:'gemini-4-argon',sourceHashes:source.sourceHashes,tests,retainedBaseline:source.baseline,liveAcceptanceRequired:true},null,2)+'\n');
// Nothing outside the model feature, its skill text and qualification may drift.
for(const [file,digest] of Object.entries(retained.files)){
  if(['dist/app.mjs','skills/gemini-ux-partner/SKILL.md'].includes(file))continue;
  assert.equal(hash(await readFile('dist/'+file)),digest,'unrelated accepted file changed: '+file);
}
const files={};
async function inventory(folder,prefix=''){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const file=prefix+entry.name;if(file==='release-files.json')continue;
    if(entry.isDirectory())await inventory(folder+'/'+entry.name,file+'/');
    else files[file]=hash(await readFile(folder+'/'+entry.name));
  }
}
await inventory('dist');
// The predecessor manifest is deliberately read-only. Replace our copy
// atomically instead of opening that frozen inode for writing.
await writeFile('dist/release-files.next.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2)+'\n');
await rename('dist/release-files.next.json','dist/release-files.json');
console.log(JSON.stringify({qualified:true,model:'gemini-4-argon',runtimeChanged:['dist/app.mjs','skills/gemini-ux-partner/SKILL.md'],retainedFiles:Object.keys(retained.files).length-2}));
