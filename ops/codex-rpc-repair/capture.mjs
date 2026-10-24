import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root='/root/projects/code-ai',ops=root+'/ops/codex-rpc-repair';
const baseline=(await realpath(root+'/dist')).replace(/\/dist$/,'');
const parent=JSON.parse(await readFile(root+'/ops/gemini-argon/capture.json','utf8'));
assert.equal(baseline,'/mnt/hdd/code-ai-builds/gemini-argon-live-c069a139-251c-4a57-b4a1-630918a2edbd');
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/codex-rpc-repair-source-');
const hash=b=>createHash('sha256').update(b).digest('hex');
await cp(parent.stage+'/payload',stage+'/payload',{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.git|\.qualification|\.code-ai)(?:\/|$)/.test(p)});
const changed=['server/codexAppServer.ts','server/codexAppServer.test.ts','server/codexSharedOwnerBroker.mjs','server/codexSharedOwnerBroker.test.mjs','server/codexRpcDiagnostic.mjs','server/codexRpcDiagnostic.test.mjs','server/codexSharedHistory.mjs','server/codexSharedHistory.test.ts','ops/native-owner/profile-runner.mjs','ops/native-owner/profile-runner.test.mjs'];
const sourceHashes={};
for(const f of changed){await cp(root+'/'+f,stage+'/payload/'+f);sourceHashes[f]=hash(await readFile(root+'/'+f));}
for(const f of ['package.json','test-build.mjs','build.mjs'])await cp(ops+'/'+f,stage+'/'+(f==='test-build.mjs'?'test.mjs':f));
const manifest=JSON.parse(await readFile(baseline+'/release-files.json','utf8'));
for(const[f,digest]of Object.entries(manifest.files)){
  assert.ok(!f.startsWith('/')&&!f.split('/').includes('..'));assert.equal(hash(await readFile(baseline+'/'+f)),digest);
  const input=f.startsWith('dist/')?'runtime/'+f.slice(5):f;await mkdir(stage+'/retained/'+path.dirname(input),{recursive:true});await cp(baseline+'/'+f,stage+'/retained/'+input);
}
await cp(baseline+'/release-files.json',stage+'/retained/release-files.json');
const contract={format:'code-ai-codex-rpc-repair-source',version:1,stage,baseline,changed,sourceHashes,scope:'main Germany only',capturedAt:new Date().toISOString()};
contract.clientKey=hash(JSON.stringify(contract));await writeFile(stage+'/source-contract.json',JSON.stringify(contract,null,2));await writeFile(ops+'/capture.json',JSON.stringify(contract,null,2),{mode:0o600});console.log(JSON.stringify({stage,baseline,changedFiles:changed.length,clientKey:contract.clientKey}));
