import assert from 'node:assert/strict';
import test from 'node:test';
import {CAPACITY_CONTINUATION_DELAY_MS,CAPACITY_CONTINUATION_PROMPT,isCapacityContinuationEligible,
 capacityContinuationPlan,capacityContinuationObsolete,nativeActivityAfterCapacityFailure,capacityFailureHoldCanResume} from './codexCapacityContinuation.mjs';
const at='2026-10-23T06:00:00.000Z';
const source=(extra={})=>({id:'failed-1',profileId:'developer',sessionId:'thread-1',queueKey:'thread-1',status:'failed',failureKind:'model_capacity',
 startedAt:'2026-10-23T05:59:00.000Z',completedAt:at,capacityRetryPendingAt:at,...extra});
test('only actual capacity/rate failures auto-continue, never quota/auth/general unavailability or assistant prose',()=>{
 assert.equal(isCapacityContinuationEligible(source()),true);
 assert.equal(isCapacityContinuationEligible(source({failureKind:'rate_limit'})),true);
 for(const extra of [{failureKind:'usage_limit'},{failureKind:'model_unavailable'},{failureKind:'provider_failure',error:'HTTP 401'},
  {status:'completed'},{status:'cancelled'},{sessionId:null},{nativeCancellationRequestedAt:at},{stopDecisionForItemId:'decision'},
  {failureKind:null,error:'The answer mentions Selected model is at capacity. Please try a different model.'}])assert.equal(isCapacityContinuationEligible(source(extra)),false);
 assert.equal(isCapacityContinuationEligible(source({failureKind:null,error:'Selected model is at capacity. Please try a different model.'})),true);
});
test('native will-retry/unknown custody is never replayed',()=>{
 for(const deliveryPhase of ['prepared','queued','running','detached'])assert.equal(isCapacityContinuationEligible(source({nativeSubmission:{deliveryPhase}})),false);
 assert.equal(isCapacityContinuationEligible(source({nativeSubmission:{deliveryPhase:'completed'}})),true);
});
test('delay is exactly one minute from the confirmed failure, with one stable request id',()=>{
 const a=capacityContinuationPlan(source()),b=capacityContinuationPlan(source());
 assert.equal(CAPACITY_CONTINUATION_DELAY_MS,60000);assert.equal(Date.parse(a.scheduledAt)-Date.parse(at),60000);assert.deepEqual(a,b);
 assert.equal(a.prompt,CAPACITY_CONTINUATION_PROMPT);assert.match(a.prompt,/do not repeat completed work/);
 assert.equal(a.capacityRetry.attempt,1);
});
test('automatic continuation stops after the second failed turn',()=>{
 const first=capacityContinuationPlan(source());
 assert.equal(first.capacityRetry.attempt,1);
 const secondFailure=source({id:'retry-1',capacityRetry:first.capacityRetry,capacityRetryPendingAt:'2026-10-23T06:01:30Z'});
 assert.equal(isCapacityContinuationEligible(secondFailure),false);
 assert.equal(capacityContinuationPlan(secondFailure),null);
});
test('explicit stops and absolute deadlines take precedence',()=>{
 const now=Date.parse(at);
 assert.equal(isCapacityContinuationEligible(source({stopPolicy:{stopAt:at,status:'not-needed'}}),now),false);
 assert.equal(isCapacityContinuationEligible(source({stopPolicy:{stopAt:'2026-10-23T07:00:00Z',status:'stopping'}}),now),false);
});
test('new messages, manual continuation and changed occurrences supersede the pending retry',()=>{
 const s=source(),retry={...s,id:'retry',capacityRetry:capacityContinuationPlan(s).capacityRetry,scheduledAt:'2026-10-23T06:01:00Z'};
 assert.equal(capacityContinuationObsolete(retry,s,[]),false);
 for(const other of [{status:'queued',createdAt:at,scheduledAt:at},{status:'completed',createdAt:'2026-10-23T06:00:30Z'}])
  assert.equal(capacityContinuationObsolete(retry,s,[{...s,...other,id:'manual',capacityRetry:null}]),true);
 assert.equal(capacityContinuationObsolete(retry,{...s,status:'cancelled'},[]),true);
 assert.equal(capacityContinuationObsolete(retry,{...s,startedAt:'2026-10-24T06:00:00Z'},[]),true);
 assert.equal(capacityContinuationObsolete(retry,s,[{...s,id:'draft',status:'draft',createdAt:at}]),false);
});
test('native/manual activity cancels an obsolete continuation, not metadata-only file changes',()=>{
 assert.equal(nativeActivityAfterCapacityFailure([{timestamp:at,entryType:'status',status:'failed'}],at),false);
 for(const entry of [{entryType:'message',role:'user'},{entryType:'message',role:'assistant',kind:'final'},{entryType:'tool'},{entryType:'status',status:'running'}])
  assert.equal(nativeActivityAfterCapacityFailure([{timestamp:'2026-10-23T06:00:01Z',...entry}],at),true);
});
test('only the exact model-failure hold can be resumed, never user/expired/foreign holds',()=>{
 const item={profileId:'developer',sessionId:'thread-1',queueKey:'thread-1',capacityRetry:{sourceWorkModeRunId:'run-1'}};
 const run={runId:'run-1',profileId:'developer',sessionKey:'thread-1',status:'incomplete',outcome:'failed'};
 assert.equal(capacityFailureHoldCanResume(run,item),true);
 for(const extra of [{status:'expired'},{outcome:'cancelled'},{runId:'other'},{profileId:'other'},{sessionKey:'other'}])
  assert.equal(capacityFailureHoldCanResume({...run,...extra},item),false);
});
