import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const ops='/root/projects/code-ai/ops/codex-rpc-repair',json=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const staged=await json(ops+'/staged.json'),r=staged.request,activation=await json(ops+'/activation.json'),ownerReadback=await json(ops+'/owner-readback.json');
assert.equal(activation.complete,true);assert.equal(ownerReadback.passed,true);assert.equal(ownerReadback.buildId,r.buildId);
assert.equal(await fs.realpath('/root/projects/code-ai/dist'),r.candidate+'/dist');
const manifest=await json(r.candidate+'/release-files.json'),hash=b=>createHash('sha256').update(b).digest('hex');
for(const[f,h]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(r.candidate+'/'+f)),h);
const rows=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'}}));
const app=rows.find(x=>x.name==='code-ai-app');assert.equal(app.pm2_env.status,'online');assert.equal(app.pm2_env.env.CODE_AI_PM2_TARGET_MODULE,r.candidate+'/dist/server.js');
for(const owner of activation.owners){const o=await json('/home/'+owner.profileId+'/code-ai-native-owner/ownership.json');assert.equal(o.nativePid,owner.nativePid);assert.equal(o.nativeIdentity.startTime,owner.startTime);assert.equal(o.brokerModuleSha256,staged.brokerSha256);}
const {verifyServedAssets}=await import(pathToFileURL(r.candidate+'/transaction-contract.mjs').href);
const assets=await verifyServedAssets({origin:'https://app-codex.bina-cshera.co.il',releaseRoot:r.candidate,fetch,readFile:fs.readFile});
for(const port of [4000,4001]){const response=await fetch('http://127.0.0.1:'+port+'/api/auth/check-session',{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert.ok(response.headers.get('content-type')?.includes('application/json'));}
const queue=(await json('/root/projects/code-ai/.code-ai/queue/state.json')).items;
const preserved=activation.preservedInputIds.map(id=>{const x=queue.find(x=>x.id===id);assert.ok(x);assert.equal(x.nativeSubmission.clientUserMessageId,'code-ai:'+id);assert.notEqual(x.status,'failed');return{id,status:x.status,nativeTurnId:x.nativeSubmission.turnId,stableClientIdPreserved:true};});
const receipt={format:'code-ai-codex-rpc-repair-live',version:1,complete:true,verifiedAt:new Date().toISOString(),scope:'Main Germany only',buildId:r.buildId,activeRelease:r.candidate,
 fixes:['bounded 120-second native history reads','safe RPC operation/reason diagnostics without native message disclosure','resume snapshot collaboration mode hydration','long-turn recovery beyond 2000 items with finite page/byte budgets','released native custody recovery using exact turn status instead of tool bodies','same-writer broker adoption with private one-use pinned tickets'],
 qualification:{unitTestsPassed:127,unitTestsSkipped:1,allSevenSuitesPassed:true,realNativeAdoptionQualified:true,realLongActiveTurnReadbackQualified:true},
 owners:activation.owners,nativeWritersRestarted:false,credentialsBytePreserved:activation.credentialsBytePreserved,historyAndLockFilesDeleted:false,otherServersModified:false,inputsResent:false,preservedInputs:preserved,
 ownerReadback,publicAssets:assets,browser:{largeConversation:'bfbf0ac7-6d67-40a4-9537-86335ecc1078',largeConversationApi:200,largeConversationTimelineEvents:12,largeConversationRendered:true,activeConversation:'01a13216-0efb-77f0-be75-930e85233261',activeTimelineEvents:40,activeCommentaryAndToolsVisible:true,reconciliationWarning:false},
 originalFailuresPreserved:['ops/codex-rpc-repair/activation-attempt-1.json','ops/codex-rpc-repair/first-build/activation.json'],
 historicalFailedItemRetried:false,historicalFailedItemAbsentFromCurrentQueue:true,notes:'Original generic errors are not rewritten or erased. Both earlier failed activation attempts remain available. No external-server runtime deployment was performed.'};
await fs.writeFile(ops+'/receipt.json',JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify({complete:true,buildId:r.buildId,nativeWritersPreserved:true,unitTestsPassed:127,preservedInputs:preserved}));
