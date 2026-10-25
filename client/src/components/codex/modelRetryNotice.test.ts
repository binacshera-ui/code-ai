import assert from 'node:assert/strict';
import test from 'node:test';
import {modelRetryNotice,latestModelRetryNotice,modelRetryMessage} from './modelRetryPresentation';
const now=Date.parse('2026-10-25T12:00:00Z');
const retry={turnId:'turn-one',kind:'rate_limit' as const,detectedAt:new Date(now).toISOString(),retryAt:new Date(now+60000).toISOString()};
const item={id:'retry',status:'scheduled',createdAt:retry.detectedAt,scheduledAt:retry.retryAt,capacityRetry:{attempt:2}};
test('persisted absolute deadline counts down without moving on re-render or reload',()=>{
  const notice=modelRetryNotice(item)!;
  assert.match(modelRetryMessage(notice,now),/60 שניות/);assert.match(modelRetryMessage(notice,now+11000),/49 שניות/);
  assert.match(modelRetryMessage(notice,now+60001),/ממתין להפעלת/);assert.equal(modelRetryNotice({...item,status:'cancelled'}),null);
  assert.equal(modelRetryNotice({...item,status:'completed'}),null);
});
test('native backoff is explicitly awaiting stop proof, never falsely marked running or accepted twice',()=>{
  const native={...item,status:'running',capacityRetry:null,modelRetry:retry,nativeSubmission:{turnId:'turn-one',deliveryPhase:'running'}};
  assert.match(modelRetryMessage(modelRetryNotice(native)!,now),/מאמת עצירה בטוחה/);
  assert.match(modelRetryMessage(modelRetryNotice(native)!,now+61000),/ממתין לאימות/);
  assert.equal(modelRetryNotice({...native,status:'cancelling'}),null);
  assert.equal(modelRetryNotice({...native,nativeSubmission:{turnId:'foreign',deliveryPhase:'running'}}),null);
  assert.equal(latestModelRetryNotice([{...item,status:'failed'},native])?.itemId,'retry');
  assert.equal(modelRetryNotice({...native,modelRetry:{...retry,retryAt:retry.detectedAt}}),null);
});
