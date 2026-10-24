import assert from 'node:assert/strict';
import test from 'node:test';
import {queueExecutionStatus}from'./queueExecutionStatus.js';
test('worker ownership is not native execution; waiting input is shown as queued',()=>{for(const deliveryPhase of ['prepared','queued','detached'])assert.equal(queueExecutionStatus({status:'running',nativeSubmission:{deliveryPhase,turnId:null}}),'queued');});
test('started, cancelling, legacy and terminal work retains its real status',()=>{assert.equal(queueExecutionStatus({status:'running',nativeSubmission:{deliveryPhase:'running',turnId:'own'}}),'running');assert.equal(queueExecutionStatus({status:'running'}),'running');for(const status of ['cancelling','cancelled','completed','failed'])assert.equal(queueExecutionStatus({status,nativeSubmission:{deliveryPhase:'queued',turnId:null}}),status);});
