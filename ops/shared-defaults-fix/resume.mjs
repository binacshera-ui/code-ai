import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {liveApi} from './live-api.mjs';
const {request}=await liveApi();
const original=(await request('/api/codex/queue/items/f7b0e547-65a3-4178-aa25-61bbe3f723d9')).item;
assert.equal(original.status,'failed');assert.equal(original.nativeSubmission,null);
assert.equal(original.sessionId,'01a05cd0-8a16-7752-9558-1dbe4f9ebd3f');
const catalog=await request('/api/codex/models?profileId=developer');assert.ok(catalog.selectedModel);
const result=await request('/api/codex/ask','POST',{
 profileId:original.profileId,sessionId:original.sessionId,queueKey:original.queueKey,
 clientRequestId:'shared-defaults-recovery-f7b0e547-65a3-4178-aa25-61bbe3f723d9',
 prompt:original.prompt,async:true,model:catalog.selectedModel,reasoningEffort:catalog.selectedReasoningEffort,
});
const receipt={createdAt:new Date().toISOString(),originalFailedItemId:original.id,sessionId:original.sessionId,result};
await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/resume-receipt.json',JSON.stringify(receipt,null,2),{mode:0o600});
console.log(JSON.stringify({sessionId:original.sessionId,itemId:result.item?.id,status:result.item?.status,keys:Object.keys(result)}));
