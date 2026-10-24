/** Broker-only immutable delta on the verified cumulative application release. */
import assert from 'node:assert/strict';
import {readFile,writeFile,cp,chmod,readdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const binding=JSON.parse(await readFile('baseline-binding.json','utf8'));
const manifestBytes=await readFile('baseline/release-files.json');assert.equal(hash(manifestBytes),binding.manifestSha256);
const manifest=JSON.parse(manifestBytes);for(const[f,h]of Object.entries(manifest.files))assert.equal(hash(await readFile('baseline/'+f.replace(/^dist\//,'compiled-runtime/'))),h);
const updated=await readFile('server/codexSharedOwnerBroker.mjs','utf8');assert.equal(hash(updated),binding.newBrokerSha256);
assert.equal(hash(updated.replace(binding.addition,'').replace(binding.guard,binding.oldGuard)),binding.originalBrokerSha256);
const native=JSON.parse(await readFile('native-qualification.json','utf8'));
assert.ok(native.runs.length===2&&native.runs.every(r=>r.passed===22&&r.failed===0&&r.realProviderCalls===0));
for(const[f,h]of Object.entries(native.sourceSha256))assert.equal(hash(await readFile(f)),h);
await cp('baseline','dist',{recursive:true});
await chmod('dist',0o755);await rename('dist/compiled-runtime','dist/dist');
for(const d of ['dist','dist/server','dist/qualification'])await chmod(d,0o755);
await chmod('dist/server/codexSharedOwnerBroker.mjs',0o644);await cp('server/codexSharedOwnerBroker.mjs','dist/server/codexSharedOwnerBroker.mjs');
await writeFile('dist/qualification/ubuntu-native-admission.json',JSON.stringify({format:'code-ai-ubuntu-native-admission-qualified',version:1,baselineBuildId:binding.buildId,baselineArtifactTreeSha256:binding.artifactTreeSha256,originalBrokerSha256:binding.originalBrokerSha256,brokerSha256:binding.newBrokerSha256,onlyDeclaredBrokerDelta:true,native,installedEffects:false,realCredentialsRead:false,realProviderCalls:0},null,2));
const ownerFile='dist/qualification/native-owner.json',owner=JSON.parse(await readFile(ownerFile,'utf8'));
owner.permissionProfileDelta={qualified:true,qualificationFile:'qualification/ubuntu-native-admission.json',historicalProtocolSourceRetained:true,changedBrokerNativeChecks:44};
await chmod(ownerFile,0o644);await writeFile(ownerFile,JSON.stringify(owner,null,2));
const files={};async function inventory(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){if(!prefix&&e.name==='release-files.json')continue;const f=prefix+e.name;if(e.isDirectory())await inventory(dir+'/'+e.name,f+'/');else files[f]=hash(await readFile(dir+'/'+e.name));}}
await inventory('dist');
for(const[f,h]of Object.entries(manifest.files))if(!['server/codexSharedOwnerBroker.mjs','qualification/native-owner.json'].includes(f))assert.equal(files[f],h,'Unrelated release file changed: '+f);
await chmod('dist/release-files.json',0o644);await writeFile('dist/release-files.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2));
console.log(JSON.stringify({qualified:true,changedModule:'server/codexSharedOwnerBroker.mjs',baselineBuildId:binding.buildId,unrelatedRuntimeBytesPreserved:true,nativeChecks:44}));
