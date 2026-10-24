import assert from 'node:assert/strict';
import {cp, readFile, writeFile, mkdir, mkdtemp, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/native-large-frames';
const predecessor='/mnt/hdd/code-ai-builds/queued-recovery-final-source-ncMORI';
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/native-large-frames-source-');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(await realpath(root+'/dist'),'/mnt/hdd/code-ai-builds/queued-recovery-live-1dcc7473-48f5-4696-a97f-4ed6c1fe1185/dist');
await cp(predecessor,stage,{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.git|\.qualification|\.browser-tools)(?:\/|$)/.test(p)});
// Historical native fixtures stay bound to their ORIGINAL accepted source.
// New runtime modules receive a separate fresh native/large-frame qualification.
for(const proofFile of ['ops/native-owner/native-protocol-contract-20261010.json','ops/queued-recovery/native-contract.json']){
 const p=JSON.parse(await readFile(stage+'/payload/'+proofFile,'utf8'));
 for(const[f,h]of Object.entries(p.sourceSha256)){
  assert.equal(hash(await readFile(predecessor+'/payload/'+f)),h);
  await mkdir(stage+'/historical-source/'+f.slice(0,f.lastIndexOf('/')),{recursive:true});
  await cp(predecessor+'/payload/'+f,stage+'/historical-source/'+f);
 }
}
const changed=['server/codexNativeTransport.mjs','server/codexNativeLargeFrames.test.mjs','server/codexSharedHistory.ts','server/codexSharedHistory.mjs','server/codexAppServer.ts','server/codexAppServer.test.ts','server/codexSharedOwnerBroker.mjs','server/codexSharedOwnerBroker.test.mjs','server/codexQueuedRecovery.mjs','server/codexQueuedRecovery.test.mjs','scripts/codex-shared-stdio.mjs'];
for(const f of changed)await cp(root+'/'+f,stage+'/payload/'+f);
let tests=await readFile(stage+'/test.mjs','utf8');
tests=tests.replace("'server/codexQueuedRecovery.test.mjs',", "'server/codexNativeLargeFrames.test.mjs', 'server/codexQueuedRecovery.test.mjs',");
await writeFile(stage+'/test.mjs',tests);
let build=await readFile(stage+'/build.mjs','utf8');
build=build.replace("['codexSharedSocket.mjs','codexSharedOwnerBroker.mjs','codexQueuedRecovery.mjs']", "['codexSharedSocket.mjs','codexSharedOwnerBroker.mjs','codexQueuedRecovery.mjs','codexNativeTransport.mjs','codexSharedHistory.mjs']");
build=build.replaceAll("await readFile('payload/'+file)","await readFile('historical-source/'+file)");
build=build.replace("await readFile('payload/'+f)).digest('hex'),h);\nawait writeFile('dist/qualification/queued-recovery.json'", "await readFile('historical-source/'+f)).digest('hex'),h);\nawait writeFile('dist/qualification/queued-recovery.json'");
build=build.replace('const files={};', `
const large=JSON.parse(await readFile('native-large-frames-qualification.json','utf8'));
assert.equal(large.installedEffects,false);assert.equal(large.realProviderCalls,0);
assert.ok(large.runs.length===2&&large.runs.every(r=>r.passed===22&&r.failed===0));
for(const[f,h]of Object.entries(large.sourceSha256))assert.equal(createHash('sha256').update(await readFile('payload/'+f)).digest('hex'),h);
await writeFile('dist/qualification/native-large-frames.json',JSON.stringify(large,null,2));
const files={};`);
await writeFile(stage+'/build.mjs',build);
const source={format:'code-ai-native-large-frames-source',version:1,stage,predecessor,changed,clientKey:hash(stage),capturedAt:new Date().toISOString(),baselineBuildId:'1dcc7473-48f5-4696-a97f-4ed6c1fe1185',ubuntuBaselineBuildId:'35e4d665-f0f7-4ee3-b7e1-038366b5c2aa'};
await writeFile(dir+'/capture.json',JSON.stringify(source,null,2),{mode:0o600});console.log(JSON.stringify(source));
