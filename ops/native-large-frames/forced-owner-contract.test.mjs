import test from 'node:test';import assert from 'node:assert/strict';
import {maintenanceRetirementSafe,authorizedReplacement} from './forced-owner-contract.mjs';
const safe={phase:'waiting-for-idle',coreState:'S',owners:[{unitActive:'active',runnerState:'S',nativeState:'S'}],ownerJobs:[]};
test('retire only our waiting maintenance worker, never an in-flight fence/owner stop',()=>{
 assert.equal(maintenanceRetirementSafe(safe),true);
 for(const bad of [{phase:'applying'},{coreState:'T'},{ownerJobs:['stop']},{owners:[{unitActive:'deactivating',runnerState:'S',nativeState:'S'}]},{owners:[{unitActive:'active',runnerState:'T',nativeState:'S'}]}])assert.equal(maintenanceRetirementSafe({...safe,...bad}),false);
});
function lab({authorized=true,self=[true,true]}={}) {const calls=[];return{calls,authorized,census:async()=>{calls.push('census');return{activeTurns:2};},freeze:async()=>{calls.push('freeze');return['exact-generation'];},thaw:async()=>calls.push('thaw'),replace:async()=>calls.push('replace'),selfIdle:async()=>self.shift()};}
test('force requires explicit authorization; ordinary broad maintenance does not bypass idle',async()=>{const x=lab({authorized:false});await assert.rejects(authorizedReplacement(x));assert.deepEqual(x.calls,[]);});
test('explicit disruptive request permits active work but still fences, rereads custody and thaws',async()=>{const x=lab();assert.equal((await authorizedReplacement(x)).applied,true);assert.deepEqual(x.calls,['census','freeze','census','replace','thaw']);});
test('current maintenance turn and its admission race postpone only this replacement',async()=>{const a=lab({self:[false]});assert.equal((await authorizedReplacement(a)).reason,'maintenance-turn-active');assert.deepEqual(a.calls,['census']);const b=lab({self:[true,false]});assert.equal((await authorizedReplacement(b)).reason,'maintenance-turn-admission-race');assert.ok(!b.calls.includes('replace'));assert.equal(b.calls.at(-1),'thaw');});
