/** Single named conversation, metadata only; never enqueue, start, delete or steer. */
import fs from'node:fs/promises';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const threadId='01a11590-d7e3-7191-9a84-b92cd21d47c9',itemId='852579e9-e2dd-4c70-b3fb-62152d802cee';
const clientId='code-ai:'+itemId,dir='/root/projects/code-ai/ops/queued-recovery';
const W=createRequire('/root/projects/code-ai/package.json')('ws');
const w=new W('ws+unix:///home/developer/.codex/code-ai-shared-owner/owner.sock:/',{maxPayload:8*1024*1024,handshakeTimeout:5000});
const pending=new Map();let next=0,stage='connect',rpcFailures=[];
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);rpcFailures.push({method,kind:'timeout'});reject(Error('read_timeout'));},12000);pending.set(id,{resolve,reject,timer,method,params});w.send(JSON.stringify({id,method,params}));});
w.on('error',()=>{});w.on('message',bytes=>{let f;try{f=JSON.parse(bytes.toString());}catch{return;}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.timer);if(f.error){const m=String(f.error.message||'');rpcFailures.push({method:p.method,params:p.method==='thread/items/list'?p.params:undefined,code:f.error.code,messageLength:m.length,missingField:/missing field .([A-Za-z_][A-Za-z_0-9]{0,50})/.exec(m)?.[1],categories:['not found','deserialize','decode','load','history','paginated','not loaded','support','too','large','exceed','resolve','rollout','persist','timeout','limit'].filter(k=>m.toLowerCase().includes(k))});p.reject(Error('read_refused'));}else p.resolve(f.result);});
try{
 await new Promise((y,x)=>{w.once('open',y);w.once('error',x);});stage='initialize';
 await rpc('initialize',{clientInfo:{name:'code-ai-mail-custody-readonly',version:'1'},capabilities:{experimentalApi:true}});w.send(JSON.stringify({method:'initialized',params:{}}));
 stage='metadata';const meta=await rpc('thread/read',{threadId,includeTurns:false}),queue=await rpc('thread/queue/list',{threadId,limit:100});
 const nativePending=queue.data?.filter(q=>q.clientUserMessageId===clientId).map(q=>({id:q.id,clientUserMessageId:q.clientUserMessageId}));
 stage='history';
 const{readSharedHistoryTurns}=await import(pathToFileURL('/mnt/hdd/code-ai-builds/queued-recovery-final-source-ncMORI/payload/server/codexSharedHistory.ts'));
 let history,historyReadFailed=false;
 try{history=await readSharedHistoryTurns(rpc,threadId,clientId);}catch{historyReadFailed=true;}
 stage='journal';const journal=JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/broker-journal.json','utf8'));
 const reservation=journal.records.find(r=>r.clientId===clientId);
 const state=JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8')),item=state.items.find(i=>i.id===itemId);
 const owner=JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/ownership.json','utf8'));
 let transcriptEvidence=null;
 if(process.argv[2]!=='--native-only'&&typeof meta.thread.path==='string'&&meta.thread.path.startsWith('/home/developer/.codex/sessions/')){
  stage='transcript';
  let available=true;try{await fs.access(meta.thread.path);}catch{available=false;}
  if(available){const stat=await fs.stat(meta.thread.path),stream=await fs.open(meta.thread.path,'r');let userMessageCopies=0,firstMatchingTimestamp=null,lastEventTimestamp=null,lastEventType=null;
  let partial='',position=0;
  try{for(;;){const b=Buffer.alloc(128*1024),part=await stream.read(b,0,b.length,position);if(!part.bytesRead)break;position+=part.bytesRead;partial+=b.subarray(0,part.bytesRead).toString();const lines=partial.split('\n');partial=lines.pop();
   for(const line of lines){let row;try{row=JSON.parse(line);}catch{continue;}const p=row.payload;
    if(row.timestamp>='2026-10-11T07:48:34'){lastEventTimestamp=row.timestamp;lastEventType=row.type==='response_item'?p?.type:row.type==='event_msg'?p?.type:row.type;}
    const message=(row.type==='response_item'&&p?.type==='message'&&p.role==='user')||(row.type==='event_msg'&&p?.type==='user_message');
    if(message&&[p.client_id,p.clientId,p.client_user_message_id,p.clientUserMessageId].includes(clientId)){userMessageCopies++;firstMatchingTimestamp??=row.timestamp;}
   }
   if(partial.length>128*1024*1024)throw Error('bounded_record_exceeded');
  }}finally{await stream.close();}
  transcriptEvidence={bytes:stat.size,mtime:stat.mtime.toISOString(),stableClientIdCopies:userMessageCopies,firstMatchingTimestamp,lastEventTimestamp,lastEventType};}
  else transcriptEvidence={available:false};
 }
 const proof={format:'code-ai-mail-native-custody-evidence',version:1,observedAt:new Date().toISOString(),threadId,itemId,
  application:{status:item.status,deliveryPhase:item.nativeSubmission?.deliveryPhase,queuedId:item.nativeSubmission?.queuedSubmissionId,turnId:item.nativeSubmission?.turnId,nativeReconcileAfter:item.nativeReconcileAfter},
  native:{status:meta.thread.status.type,historyMode:meta.thread.historyMode,pendingOwn:nativePending,queueCount:queue.data?.length,
   historyReadFailed,matchedTurns:history?.map(t=>({id:t.id,status:t.status,ownedUserMessages:t.items.filter(i=>i.type==='userMessage'&&i.clientId===clientId).length,
    assistantItems:t.items.filter(i=>i.type==='agentMessage').length,toolItems:t.items.filter(i=>['commandExecution','dynamicToolCall','mcpToolCall'].includes(i.type)).length}))},
  reservation:reservation&&{phase:reservation.phase,queuedId:reservation.queuedId,turnId:reservation.turnId,turnComplete:reservation.turnComplete,createdAt:new Date(reservation.createdAt).toISOString()},
  transcriptEvidence,owner:{nativePid:owner.nativePid,brokerSha256:owner.brokerModuleSha256},rpcFailures,inputResent:false,workCancelled:false,promptsPrinted:false};
 await fs.writeFile(dir+'/mail-custody-evidence.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}catch(e){console.log(JSON.stringify({evidenceReadFailed:true,stage,code:e.code,name:e.name,rpcFailures,inputResent:false}));process.exitCode=1;}
finally{w.terminate();for(const p of pending.values())clearTimeout(p.timer);}
