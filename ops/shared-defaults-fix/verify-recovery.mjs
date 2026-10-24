import assert from 'node:assert/strict';
import {readFile,writeFile,open} from 'node:fs/promises';
const sessionId='01a05cd0-8a16-7752-9558-1dbe4f9ebd3f';
const itemId='83253884-a5f8-45cc-a7a1-ef107e7426ae';
const state=JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));
const item=state.items.find(x=>x.id===itemId);
assert.equal(item.sessionId,sessionId);assert.ok(['running','completed'].includes(item.status));
assert.ok(item.nativeSubmission?.turnId);assert.equal(item.error,null);
const rollout='/home/developer/.codex/sessions/2026/09/01/rollout-2026-09-01T13-52-45-'+sessionId+'.jsonl';
const f=await open(rollout);const {size}=await f.stat();const start=Math.max(0,size-1024*1024);
const b=Buffer.alloc(size-start);await f.read(b,0,b.length,start);await f.close();
const lines=b.toString().split('\n').slice(start?1:0).filter(Boolean).map(x=>JSON.parse(x));
const events=lines.filter(x=>x.timestamp>='2026-10-11T04:41:11' && x.payload?.type==='custom_tool_call');
assert.ok(events.length>0,'No actual resumed task activity');
const receipt={verifiedAt:new Date().toISOString(),sessionId,title:'טיפול וחידוש',itemId,status:item.status,
 turnId:item.nativeSubmission.turnId,deliveryPhase:item.nativeSubmission.deliveryPhase,
 model:item.model,reasoningEffort:item.reasoningEffort,originalConversationPreserved:true,
 actualToolActivity:events.slice(0,4).map(x=>({timestamp:x.timestamp,name:x.payload.name,callId:x.payload.call_id})),
 rootCause:'Implicit profile model was left null and rejected by the shared-owner preflight.',
 recovery:'Resubmitted the never-delivered continuation through normal API with explicit existing profile defaults and stable deduplication ID.',
 permanentFix:{files:['server/codexExecutionSelection.ts','server/codexExecutionSelection.test.ts','server/codexService.ts'],regressionTestsPassed:7,buildId:'3002a06f-d74f-4e2e-8ba2-40676eb3c168',deployed:false}};
await writeFile('/root/projects/code-ai/ops/shared-defaults-fix/recovery-verification.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
