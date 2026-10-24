import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {advanceRecurringNativeSubmission, repairLegacyRecurringNativeSubmission} from './codexQueueRecurrence.mjs';
import {nativeClientMessageId, normalizeNativeSubmission, recoverNativeSubmission} from './codexSharedSubmission.mjs';
const fixture = (extra={}) => ({id:'schedule-1',status:'scheduled',scheduleMode:'recurring',
  lastRunAt:'2026-10-22T06:05:00Z',scheduledAt:'2026-10-23T06:00:00Z',
  nativeSubmission:{clientUserMessageId:'code-ai:schedule-1',queuedSubmissionId:'queue-1',turnId:'turn-1',deliveryPhase:'completed'},...extra});
test('each occurrence gets a new native identity while schedule/cancellation identity stays stable',()=>{
  const item=fixture(), replies=new Map([['code-ai:schedule-1','yesterday']]);
  for(const [id,reply] of [['occurrence-2','today'],['occurrence-3','tomorrow']]) {
    advanceRecurringNativeSubmission(item,id);
    assert.equal(item.id,'schedule-1');assert.equal(item.nativeSubmission,null);
    const clientId=nativeClientMessageId(item.nativeRunId);
    assert.ok(!replies.has(clientId),'must not reconcile yesterday as new work');replies.set(clientId,reply);
    item.nativeSubmission={clientUserMessageId:clientId,queuedSubmissionId:'q-'+id,turnId:'t-'+id,deliveryPhase:'completed'};
    assert.equal(normalizeNativeSubmission(item.nativeSubmission,item.nativeRunId).clientUserMessageId,clientId);
  }
  assert.equal(replies.size,3);assert.equal(item.lastRunNativeSubmission.turnId,'t-occurrence-2');
});
test('uncertain input never rotates, even at a scheduled boundary',()=>{
  for(const phase of ['prepared','queued','running','detached']) {
    const item=fixture();item.nativeSubmission.deliveryPhase=phase;const before=structuredClone(item);
    assert.throws(()=>advanceRecurringNativeSubmission(item,'new'),/unresolved/);assert.deepEqual(item,before);
    assert.equal(repairLegacyRecurringNativeSubmission(item),false);
  }
});
test('legacy false-completion rows advance once and retain the original completion proof',()=>{
  const item=fixture();assert.equal(repairLegacyRecurringNativeSubmission(item),true);
  assert.equal(item.lastRunNativeSubmission.clientUserMessageId,'code-ai:schedule-1');assert.equal(item.nativeSubmission,null);
  const id=item.nativeRunId;assert.equal(repairLegacyRecurringNativeSubmission(item),false);assert.equal(item.nativeRunId,id);
});
test('disabled jobs, one-time jobs and an unproven next occurrence are unchanged',()=>{
  for(const extra of [{status:'cancelled'},{status:'running'},{scheduleMode:'once'},{lastRunAt:null},{scheduledAt:'2026-10-21T06:00:00Z'}]) {
    const item=fixture(extra),before=structuredClone(item);assert.equal(repairLegacyRecurringNativeSubmission(item),false);assert.deepEqual(item,before);
  }
});
test('restart keeps the new occurrence input identity, not the schedule id',()=>{
  const item=fixture();advanceRecurringNativeSubmission(item,'occurrence-2');
  item.nativeSubmission={clientUserMessageId:'code-ai:occurrence-2',queuedSubmissionId:'q-2',turnId:null,deliveryPhase:'queued'};
  const loaded=JSON.parse(JSON.stringify(item));
  assert.equal(recoverNativeSubmission(loaded.nativeSubmission,loaded.nativeRunId).clientUserMessageId,'code-ai:occurrence-2');
  assert.equal(repairLegacyRecurringNativeSubmission(loaded),false);
  assert.throws(()=>normalizeNativeSubmission(loaded.nativeSubmission,loaded.id),/refusing replay/);
});
test('next occurrence clears only transient custody/cancellation state',()=>{
  const item=fixture({nativeCancellationRequestedAt:'past',nativeReconcileAfter:'past',progressGuardWarning:{turnId:'turn-1'},prompt:'unchanged',sessionId:'thread-1'});
  advanceRecurringNativeSubmission(item,'next');
  for(const field of ['nativeCancellationRequestedAt','nativeReconcileAfter','progressGuardWarning'])assert.equal(item[field],null);
  assert.equal(item.prompt,'unchanged');assert.equal(item.sessionId,'thread-1');assert.equal(item.lastRunAt,'2026-10-22T06:05:00Z');
});
test('queue and provider use separate native identity without changing cancellation run id',async()=>{
  const q=await fs.readFile(new URL('./codexQueue.ts',import.meta.url),'utf8'),provider=await fs.readFile(new URL('./codexService.ts',import.meta.url),'utf8');
  assert.ok(q.includes('nativeRunId: item.nativeRunId || item.id'));assert.ok(q.includes('runId: item.id'));
  assert.ok(q.includes('advanceRecurringNativeSubmission(item)'));assert.ok(q.includes('repairLegacyRecurringNativeSubmission(next)'));
  assert.ok(provider.includes('clientUserMessageId: nativeClientMessageId(nativeRunId)'));
  assert.ok(provider.includes('activeCodexRuns.set(activeRunId'));
});
