import {readFile,open,stat,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire('/root/projects/code-ai/package.json'),WebSocket=require('ws');
const threadId='01a0cda2-d5d2-7b01-8f5c-204a4f76376a',itemId='ca69e495-6d55-427e-918c-db92e862343e';
const state=JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));
const item=state.items.find(i=>i.id===itemId);
if(item?.sessionId!==threadId||!item.nativeSubmission?.turnId)throw Error('Native turn custody unavailable');
const ws=new WebSocket('ws+unix:///home/developer/.codex/code-ai-shared-owner/owner.sock:/',{maxPayload:8*1024*1024,handshakeTimeout:5000});
let n=0;const requests=new Map();
ws.on('error',()=>{});ws.on('message',b=>{const f=JSON.parse(b.toString()),p=requests.get(f.id);if(!p)return;requests.delete(f.id);clearTimeout(p.timer);if(f.error)p.reject(Error('Evidence RPC refused'));else p.resolve(f.result);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>reject(Error('Evidence timed out')),10000);requests.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
try{
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(Error('Evidence unavailable')));});
 await rpc('initialize',{clientInfo:{name:'code-ai-memo-recovery-readback',version:'1'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized',params:{}}));
 const current=await rpc('thread/read',{threadId,includeTurns:false});
 const queue=await rpc('thread/queue/list',{threadId,limit:100});
 if(process.argv[2]){
  const {readSharedHistoryTurns}=await import(pathToFileURL(process.argv[2]).href);
  const turns=await readSharedHistoryTurns(rpc,threadId,item.nativeSubmission.clientUserMessageId,item.nativeSubmission.turnId);
  if(turns.length!==1||turns[0].id!==item.nativeSubmission.turnId)throw Error('Actual paginated reconciliation not proven');
  console.log(JSON.stringify({actualPaginatedHelperProven:true,threadId,turnId:turns[0].id,items:turns[0].items.length}));
 }
 let cursor=null,ownCopies=0,toolItems=0,assistantItems=0,turnStatus=null,pages=0;
 do{
  const r=await rpc('thread/items/list',{threadId,turnId:item.nativeSubmission.turnId,cursor,limit:100,sortDirection:'asc'});pages++;
  for(const e of r.data||[]){const i=e.item;if(e.turnId!==item.nativeSubmission.turnId||!i)throw Error('Native item envelope mismatch');if(i.type==='userMessage'&&i.clientId===item.nativeSubmission.clientUserMessageId)ownCopies++;
   if(i.type==='agentMessage')assistantItems++;if(['commandExecution','mcpToolCall','dynamicToolCall'].includes(i.type))toolItems++;}
  cursor=r.nextCursor;if(pages>100)throw Error('Evidence page bound');
 }while(cursor);
 const filename='/home/developer/.codex/sessions/2026/09/23/rollout-2026-09-23T11-39-55-'+threadId+'.jsonl';
 const s=await stat(filename),f=await open(filename,'r'),b=Buffer.alloc(Math.min(s.size,3000000));await f.read(b,0,b.length,s.size-b.length);await f.close();
 const sinceRecovery={};let lastTimestamp=null;
 for(const line of b.toString().split('\n').slice(1)){try{const r=JSON.parse(line);if(r.timestamp>='2026-10-11T06:21:50'){
 const key=r.type==='response_item'?(r.payload?.type+':'+(r.payload?.role||'')):r.type;sinceRecovery[key]=(sinceRecovery[key]||0)+1;lastTimestamp=r.timestamp;}}catch{}}
 const proof={format:'code-ai-memo-native-recovery-evidence',observedAt:new Date().toISOString(),threadId,itemId,
  queuedId:item.nativeSubmission.queuedSubmissionId,turnId:item.nativeSubmission.turnId,queueStatus:item.status,
  nativeStatus:current.thread.status.type,historyMode:current.thread.historyMode,paginatedRead:true,pages,ownUserMessageCopies:ownCopies,
  stillQueued:queue.data.some(i=>i.id===item.nativeSubmission.queuedSubmissionId),assistantItems,toolItems,
  transcriptBytes:s.size,mtime:s.mtime.toISOString(),sinceRecovery,lastTimestamp,inputResent:false,nativeOwnerRestarted:false};
 if(ownCopies!==1||proof.stillQueued){console.log(JSON.stringify({...proof,exactOnceNotProven:true}));throw Error('Native exact-once recovery not proven');}
 await writeFile('/root/projects/code-ai/ops/queued-recovery/memo-evidence.json',JSON.stringify(proof,null,2),{mode:0o600});
 console.log(JSON.stringify(proof));
}finally{ws.terminate();}
