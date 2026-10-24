/** Only metadata counts/IDs are retained; no conversation or image contents. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const dir='/root/projects/code-ai/ops/native-large-frames';
const sessionId='01a11590-d7e3-7191-9a84-b92cd21d47c9',itemId='852579e9-e2dd-4c70-b3fb-62152d802cee',turnId='01a129ef-5fbc-7e23-a7b5-7ccd0c33a80a';
const end=Date.now()+60000;let item;
do{
 const s=JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));item=s.items.find(i=>i.id===itemId);assert.ok(item);
 if(item.nativeSubmission?.turnId===turnId&&item.status!=='queued')break;
 await new Promise(y=>setTimeout(y,2000));
}while(Date.now()<end);
const candidate=await fs.realpath('/root/projects/code-ai/dist');
const code=`import{readManagedNativeHistory}from${JSON.stringify(candidate.slice(0,-5)+'/server/codexQueuedRecovery.mjs')};const r=await readManagedNativeHistory({codexHome:'/home/developer/.codex',method:'thread/items/list',params:{threadId:${JSON.stringify(sessionId)},turnId:${JSON.stringify(turnId)},limit:1,sortDirection:'asc'}});console.log(JSON.stringify({exactInput:r.data[0]?.item?.clientId===${JSON.stringify('code-ai:'+itemId)},imageCount:r.data[0]?.item?.content?.filter(i=>i.type==='image').length}));`;
const native=JSON.parse(execFileSync('runuser',['-u','developer','--','/root/.nvm/versions/node/v24.12.0/bin/node','--input-type=module','-e',code],{encoding:'utf8',stdio:'pipe',timeout:20000}));
const proof={format:'code-ai-native-large-frame-mail-readback',version:1,observedAt:new Date().toISOString(),sessionId,itemId,turnId,
 applicationStatus:item.status,deliveryPhase:item.nativeSubmission?.deliveryPhase,stillQueued:item.status==='queued',exactNativeTurnMatched:item.nativeSubmission?.turnId===turnId&&native.exactInput,
 exactStableInputMatched:native.exactInput,imageCount:native.imageCount,errorPresent:!!item.error,inputResent:false,nativeOwnerRestarted:false,conversationContentsPrinted:false};
await fs.writeFile(dir+'/mail-readback.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
assert.equal(proof.exactNativeTurnMatched,true);assert.equal(proof.stillQueued,false);assert.equal(proof.errorPresent,false);
