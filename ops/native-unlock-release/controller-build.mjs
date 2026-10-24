import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const proof=JSON.parse(await readFile('payload/native-runner-proof.json','utf8'));
assert.equal(proof.installedEffects,false);assert.equal(proof.actualNativeLifecycleQualified,true);
assert.equal(proof.nativeRuns.length,2);
assert.ok(proof.nativeRuns.every(r=>r.failed===0&&r.skipped===0&&r.lifecycle.normalStopAndRestart&&r.lifecycle.fixtureOnlyProcessGroupSigkillAndRestart&&r.lifecycle.modelTurns===0));
for(const [file,sha]of Object.entries(proof.sourceSha256))assert.equal(hash(await readFile('payload/'+file)),sha,'Native proof/source mismatch');
await mkdir('dist',{recursive:true});
await cp('payload/ops','dist/ops',{recursive:true});
await cp('payload/scripts','dist/scripts',{recursive:true});
await cp('payload/package.json','dist/package.json');
await mkdir('dist/qualification',{recursive:true});
await writeFile('dist/qualification/runner.json',JSON.stringify(proof,null,2)+'\n');
const files={};
async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const f=prefix+e.name;if(e.isDirectory())await walk(dir+'/'+e.name,f+'/');else files[f]=hash(await readFile(dir+'/'+e.name));}}
await walk('dist');await writeFile('dist/release-files.json',JSON.stringify({format:'code-ai-native-owner-controller-files',version:1,files},null,2)+'\n');
console.log(JSON.stringify({controllerPackaged:true,actualNativeLifecycleQualified:true,installedEffects:false}));
