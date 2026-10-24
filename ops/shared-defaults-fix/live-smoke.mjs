import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {liveApi} from './live-api.mjs';
export async function liveSmoke(){
 const {request}=await liveApi();
 const catalog=await request('/api/codex/models?profileId=developer');
 assert.ok(catalog.models.some(x=>x.slug==='gpt-6.1-sol'));
 const queueKey='shared-defaults-deployment-smoke-c4eb9c41';
 async function run(sessionId,marker){
  const r=await request('/api/codex/queue/items','POST',{profileId:'developer',queueKey,sessionId,
   clientRequestId:queueKey+'-'+marker,cwd:'/tmp',prompt:'Deployment verification only. Do not use tools or modify files. Reply exactly '+marker+'.'});
  const id=r.item?.id;assert.ok(id);
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
   const {item}=await request('/api/codex/queue/items/'+id);
   if(['failed','cancelled'].includes(item.status))throw new Error('Live default-model smoke failed: '+item.error);
   if(item.status==='completed'){
    assert.ok(item.finalMessage.includes(marker));assert.ok(item.nativeSubmission?.turnId);
    return {itemId:id,sessionId:item.sessionId,status:item.status,turnId:item.nativeSubmission.turnId,finalMessage:item.finalMessage};
   }
   await new Promise(r=>setTimeout(r,1500));
  }
  throw Error('Live smoke timed out; do not replay input');
 }
 const first=await run(undefined,'DEFAULT_MODEL_OK');
 const continuation=await run(first.sessionId,'DEFAULT_CONTINUATION_OK');
 assert.equal(first.sessionId,continuation.sessionId);
 const result={verifiedAt:new Date().toISOString(),defaultModel:catalog.selectedModel,newSessionWithoutExplicitModel:first,continuationWithoutExplicitModel:continuation};
 await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/live-smoke-receipt.json',JSON.stringify(result,null,2));
 await request('/api/codex/sessions/'+first.sessionId+'?profile=developer','DELETE');
 result.syntheticConversationRemoved=true;await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/live-smoke-receipt.json',JSON.stringify(result,null,2));
 return result;
}
