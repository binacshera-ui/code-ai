import test from 'node:test';
import assert from 'node:assert/strict';
import { readSharedHistoryTurns } from './codexSharedHistory.js';
test('a 2,600-item live turn reconciles its exact input and keeps late child/final items', async () => {
  let pages=0;
  const rpc=async(method:string,p:any)=>{
    if(method==='thread/read')return{thread:{id:'t',historyMode:'paginated'}};
    if(method==='thread/turns/list')return{data:[{id:'ours',status:'inProgress'}],nextCursor:null};
    const page=Number(p.cursor||0);pages++;
    const data=Array.from({length:20},(_,i)=>({turnId:'ours',item:{type:'agentMessage',text:'synthetic '+(page*20+i)}}));
    if(page===0)(data[0]as any).item={type:'userMessage',clientId:'own'};
    if(page===129)(data[19]as any).item={type:'collabAgentToolCall',receiverThreadIds:['late-child']};
    return{data,nextCursor:page<129?String(page+1):null};
  };
  const a=await readSharedHistoryTurns(rpc,'t','own','ours');
  assert.equal(pages,130);assert.equal(a[0].items.length,2600);
  assert.deepEqual(a[0].items.at(-1).receiverThreadIds,['late-child']);
});
test('paginated large history finds the exact owned input without any full transcript request',async()=>{const calls:any[]=[];const rpc=async(m:string,p:any)=>{calls.push([m,p]);if(m==='thread/read'){assert.equal(p.includeTurns,false);return{thread:{id:'t',historyMode:'paginated'}};}if(m==='thread/turns/list')return{data:[{id:p.cursor?'ours':'foreign',status:'completed'}],nextCursor:p.cursor?null:'page2'};return{data:[{turnId:p.turnId,item:{type:'userMessage',clientId:p.turnId==='ours'?'own':'foreign'}},{turnId:p.turnId,item:{type:'agentMessage',text:'synthetic'}}],nextCursor:null};};const turns=await readSharedHistoryTurns(rpc,'t','own');assert.equal(turns.length,1);assert.equal(turns[0].id,'ours');assert.equal(calls.some(([m,p])=>m==='thread/read'&&p.includeTurns),false);});
test('a known turn avoids retrieving unrelated item content',async()=>{const rpc=async(m:string,p:any)=>{if(m==='thread/read')return{thread:{id:'t',historyMode:'paginated'}};if(m==='thread/turns/list')return{data:[{id:'other'},{id:'ours'}],nextCursor:null};assert.equal(p.turnId,'ours');return{data:[],nextCursor:null};};assert.equal((await readSharedHistoryTurns(rpc,'t',undefined,'ours'))[0].id,'ours');});
test('duplicate page cursors fail closed instead of looping or replaying input',async()=>{const rpc=async(m:string)=>m==='thread/read'?{thread:{id:'t',historyMode:'paginated'}}:{data:[],nextCursor:'same'};await assert.rejects(readSharedHistoryTurns(rpc,'t','own'),/pagination/);});
test('foreign item envelopes cannot prove ownership of another turn',async()=>{const rpc=async(m:string)=>m==='thread/read'?{thread:{id:'t',historyMode:'paginated'}}:m==='thread/turns/list'?{data:[{id:'ours'}],nextCursor:null}:{data:[{turnId:'foreign',item:{type:'userMessage',clientId:'own'}}],nextCursor:null};await assert.rejects(readSharedHistoryTurns(rpc,'t','own'),/custody/);});
