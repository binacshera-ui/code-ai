import test from 'node:test';import assert from 'node:assert/strict';import {checkpointActiveTurns} from './native-authorized-interrupt.mjs';
test('interrupts only the exact active turn; proves terminal history before any process stop; never prompts',async()=>{
 const calls=[];let interrupted=false;const rpc=async(method,params)=>{calls.push({method,params});if(method==='thread/loaded/list')return{data:['active','idle']};if(method==='thread/read')return{thread:{status:{type:params.threadId==='active'?'active':'idle'}}};if(method==='thread/turns/list')return{data:[{id:'exact-turn',status:interrupted?'interrupted':'inProgress'}]};if(method==='turn/interrupt'){assert.equal(params.turnId,'exact-turn');interrupted=true;return{};}throw Error('unexpected');};
 const result=await checkpointActiveTurns(rpc);assert.equal(result.interruptedTurns,1);assert.equal(result.proofs[0].terminalProved,true);assert.ok(!calls.some(c=>/start|add|steer|delete/.test(c.method)));assert.equal(result.inputsResent,false);
});
test('unproved active turn or nonterminal interrupted history blocks process replacement',async()=>{
 for(const missing of [true,false]){let clock=0;const rpc=async method=>method==='thread/loaded/list'?{data:['active']}:method==='thread/read'?{thread:{status:{type:'active'}}}:method==='thread/turns/list'?{data:missing?[]:[{id:'same',status:'inProgress'}]}:{};
  await assert.rejects(checkpointActiveTurns(rpc,{now:()=>clock+=25000,sleep:async()=>{}}));}
});
