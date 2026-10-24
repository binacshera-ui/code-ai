/** Explicit disruptive rollout checkpoint: terminate exact active native turns,
 * prove their terminal history before process replacement, never send a prompt.
 */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
export async function checkpointActiveTurns(rpc,{sleep=ms=>new Promise(y=>setTimeout(y,ms)),now=Date.now}={}) {
 const proofs=[];
 const loaded=await rpc('thread/loaded/list',{});assert.ok(Array.isArray(loaded.data)&&!loaded.nextCursor&&loaded.data.length<=1024);
 for(const threadId of loaded.data){
  const state=await rpc('thread/read',{threadId,includeTurns:false});if(state.thread?.status?.type!=='active')continue;
  const turns=await rpc('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded',sortDirection:'desc'});assert.ok(Array.isArray(turns.data));
  const turn=turns.data[0];assert.ok(turn&&typeof turn.id==='string'&&turn.status==='inProgress','active_turn_custody_missing');
  await rpc('turn/interrupt',{threadId,turnId:turn.id});
  const deadline=now()+20000;let terminal=false;
  do{const page=await rpc('thread/turns/list',{threadId,limit:5,itemsView:'notLoaded',sortDirection:'desc'});assert.ok(Array.isArray(page.data));terminal=page.data.some(t=>t.id===turn.id&&['completed','failed','interrupted'].includes(t.status));if(terminal)break;await sleep(100);}while(now()<deadline);
  assert.ok(terminal,'native_terminal_checkpoint_missing');proofs.push({threadId,turnId:turn.id,terminalProved:true});
 }
 return{interruptedTurns:proofs.length,proofs,inputsResent:false};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const [candidate,home]=process.argv.slice(2),directory=new URL('../',pathToFileURL(home+'/')).pathname+'code-ai-native-owner';
 const {assertPrivateNativeEndpoint}=await import(pathToFileURL(candidate+'/server/codexSharedOwnerBroker.mjs'));
 await assertPrivateNativeEndpoint(directory+'/engine.sock',home);
 const before=JSON.parse(await fs.readFile(directory+'/ownership.json','utf8')),W=createRequire(candidate+'/package.json')('ws');
 const ws=new W('ws+unix://'+directory+'/engine.sock:/',{maxPayload:64*1024*1024,handshakeTimeout:5000});let n=0;const pending=new Map();ws.on('error',()=>{});
 ws.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return ws.terminate();}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(Error('native_checkpoint_refused')):p.resolve(f.result);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('native_checkpoint_timeout'));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 try{await new Promise((y,x)=>{ws.once('open',y);ws.once('error',x);});const init=await rpc('initialize',{clientInfo:{name:'code-ai-owner-authorized-rollout-checkpoint',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.codexHome,home);ws.send(JSON.stringify({method:'initialized',params:{}}));
  const proof=await checkpointActiveTurns(rpc),after=JSON.parse(await fs.readFile(directory+'/ownership.json','utf8'));assert.equal(after.nativePid,before.nativePid);assert.equal(after.nativeIdentity.startTime,before.nativeIdentity.startTime);console.log(JSON.stringify(proof));
 }catch{process.stderr.write('CODE_AI_NATIVE_CHECKPOINT_REFUSED\n');process.exitCode=1;}
 finally{ws.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('checkpoint_closed'));}}
}
