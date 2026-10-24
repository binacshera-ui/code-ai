/** Same-UID read-only census for the exact managed native generation.
 * No prompt, image, command, settings or credential is emitted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [candidate,home]=process.argv.slice(2),dir=path.join(path.dirname(home),'code-ai-native-owner');
const {assertPrivateNativeEndpoint,validateBrokerJournal}=await import(pathToFileURL(candidate+'/server/codexSharedOwnerBroker.mjs'));
const {readSharedHistoryTurns}=await import(pathToFileURL(candidate+'/server/codexSharedHistory.mjs'));
await assertPrivateNativeEndpoint(dir+'/engine.sock',home);
const custody=JSON.parse(await fs.readFile(dir+'/ownership.json','utf8'));
assert.equal(custody.codexHome,home);
const stat=await fs.readFile('/proc/'+custody.nativePid+'/stat','utf8');
assert.equal(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19],custody.nativeIdentity.startTime);
const W=createRequire(candidate+'/package.json')('ws'),w=new W('ws+unix://'+dir+'/engine.sock:/',{maxPayload:64*1024*1024,handshakeTimeout:5000});
let n=0;const pending=new Map();w.on('error',()=>{});
w.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return w.terminate();}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.t);f.error?p.x(Error('census_refused')):p.y(f.result);});
const rpc=(method,params)=>new Promise((y,x)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);x(Error('census_timeout'));},10000);pending.set(id,{y,x,t});w.send(JSON.stringify({id,method,params}));});
try{
 await new Promise((y,x)=>{w.once('open',y);w.once('error',x);});
 const init=await rpc('initialize',{clientInfo:{name:'code-ai-large-frame-idle-census',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.codexHome,home);
 w.send(JSON.stringify({method:'initialized',params:{}}));
 const loaded=await rpc('thread/loaded/list',{});assert.ok(Array.isArray(loaded.data));assert.ok(!loaded.nextCursor);
 const threads=[];
 for(const id of loaded.data){
  const t=await rpc('thread/read',{threadId:id,includeTurns:false}),q=await rpc('thread/queue/list',{threadId:id,limit:100}),g=await rpc('thread/goal/get',{threadId:id}),b=await rpc('thread/backgroundTerminals/list',{threadId:id});
  assert.ok(Array.isArray(q.data)&&!q.nextCursor&&Array.isArray(b.data)&&!b.nextCursor&&Object.hasOwn(g,'goal'));
  threads.push({status:t.thread.status.type,queued:q.data.length,activeGoal:!!g.goal&&!['complete','completed','paused','blocked'].includes(g.goal.status),backgroundTerminals:b.data.length});
 }
 // The broker creates no journal until its first reservation. Missing is the
 // normal empty state; malformed/unreadable existing evidence remains fatal.
 let records=[];try{records=validateBrokerJournal(JSON.parse(await fs.readFile(dir+'/broker-journal.json','utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
 const journal=[];
 const nativeIdle=threads.every(t=>t.status==='idle'&&t.queued===0&&!t.activeGoal&&t.backgroundTerminals===0);
 for(const rec of records){
  let terminalProved=rec.phase==='released'&&rec.turnComplete;
  // While native work already blocks replacement, do not reread large image
  // histories every poll. Exact terminal proof is required only at the idle gate.
  if(!terminalProved&&nativeIdle){
   const turns=await readSharedHistoryTurns(rpc,rec.threadId,rec.clientId,rec.turnId||undefined);
   terminalProved=turns.some(t=>['completed','interrupted','failed'].includes(t.status)&&t.items.some(i=>i.type==='userMessage'&&i.clientId===rec.clientId));
  }
  journal.push({phase:rec.phase,turnComplete:rec.turnComplete,terminalProved});
 }
 const fresh=JSON.parse(await fs.readFile(dir+'/ownership.json','utf8'));assert.equal(fresh.nativePid,custody.nativePid);assert.equal(fresh.nativeIdentity.startTime,custody.nativeIdentity.startTime);
 console.log(JSON.stringify({home,nativePid:custody.nativePid,nativeGeneration:custody.nativeIdentity.startTime,runnerPid:custody.runnerPid,runnerGeneration:custody.runnerIdentity.startTime,brokerSha256:custody.brokerModuleSha256,threads,journal}));
}finally{w.terminate();for(const p of pending.values()){clearTimeout(p.t);p.x(Error('census_closed'));}}
