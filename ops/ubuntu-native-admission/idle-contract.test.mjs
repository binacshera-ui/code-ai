import{test}from'node:test';import assert from'node:assert/strict';
import{isIdle,idleTransaction}from'./idle-contract.mjs';
const idle=()=>({threads:[{status:'idle',queued:0,activeGoal:false}],queue:[{status:'draft'},{status:'scheduled'}],journal:[]});
test('active turn, queued input, active goal and unresolved custody all block replacement',()=>{
 for(const change of [s=>s.threads[0].status='active',s=>s.threads[0].queued=1,s=>s.threads[0].activeGoal=true,
  s=>s.queue.push({status:'running'}),s=>s.queue.push({status:'queued'}),s=>s.queue.push({status:'unknown'}),s=>s.journal.push({phase:'released',turnComplete:false})]){
  let s=idle();change(s);assert.equal(isIdle(s),false);
 }assert.equal(isIdle(idle()),true);assert.equal(isIdle({}),false);
});
test('busy owner receives no signals',async()=>{let s=idle();s.threads[0].status='active';
 const r=await idleTransaction({census:async()=>s,freeze:()=>assert.fail(),thaw:()=>assert.fail(),replace:()=>assert.fail()});assert.equal(r.applied,false);
});
test('input arriving during fence aborts replacement and thaws exact generations',async()=>{let n=0,thawed=false;
 const r=await idleTransaction({census:async()=>{let s=idle();if(n++)s.threads[0].queued=1;return s;},freeze:async()=>[{pid:17,generation:'a'}],
  thaw:async p=>{assert.deepEqual(p,[{pid:17,generation:'a'}]);thawed=true;},replace:()=>assert.fail()});assert.equal(r.applied,false);assert.ok(thawed);
});
test('replacement failure still releases the admission fence',async()=>{let thawed=false;
 await assert.rejects(idleTransaction({census:async()=>idle(),freeze:async()=>[],thaw:async()=>{thawed=true;},replace:async()=>{throw Error('fixture');}}));assert.ok(thawed);
});
