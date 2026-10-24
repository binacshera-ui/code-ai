/** Bounded read-only native metadata. No prompt/image/error response is printed. */
import fs from'node:fs/promises';import{createRequire}from'node:module';
const base=JSON.parse(await fs.readFile('/root/projects/code-ai/ops/queued-recovery/mail-custody-evidence.json','utf8'));
const params=base.rpcFailures.find(f=>f.method==='thread/items/list').params;
const W=createRequire('/root/projects/code-ai/package.json')('ws');
// Private diagnostic allowance only. This does not alter any installed limit.
const w=new W('ws+unix:///home/developer/code-ai-native-owner/engine.sock:/',{maxPayload:64*1024*1024,handshakeTimeout:5000});
const pending=new Map();let n=0;
const call=(method,params)=>new Promise((y,x)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);x(Error('read_timeout'));},10000);pending.set(id,{y,x,t});w.send(JSON.stringify({id,method,params}));});
w.on('error',()=>{});w.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.t);f.error?p.x(Error('read_refused')):p.y({result:f.result,responseBytes:b.length});});
try{
 await new Promise((y,x)=>{w.once('open',y);w.once('error',x);});await call('initialize',{clientInfo:{name:'code-ai-mail-direct-custody-audit',version:'1'},capabilities:{experimentalApi:true}});w.send(JSON.stringify({method:'initialized',params:{}}));
 const turns=await call('thread/turns/list',{threadId:params.threadId,limit:20,itemsView:'notLoaded',sortDirection:'desc'});
 const turn=turns.result.data.find(t=>t.id===params.turnId);if(!turn)throw Error('owned_turn_metadata_missing');
 const single=await call('thread/items/list',{...params,limit:1});
 const item=single.result.data[0]?.item;
 if(item?.type!=='userMessage'||item.clientId!=='code-ai:'+base.itemId)throw Error('stable_input_identity_mismatch');
 const page=await call('thread/items/list',params);
 const contentTypes={},imageCharacters=[];
 for(const c of item.content||[]){contentTypes[c.type]=(contentTypes[c.type]||0)+1;if(c.type==='image'&&typeof c.url==='string')imageCharacters.push(c.url.length);}
 const queue=JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));
 const record=queue.items.find(i=>i.id===base.itemId);
 const proof={format:'code-ai-mail-direct-custody-proof',version:1,observedAt:new Date().toISOString(),threadId:params.threadId,itemId:base.itemId,
  actualNativeTurnId:turn.id,actualNativeTurnStatus:turn.status,stableUserMessageId:item.clientId,ownershipConfirmed:true,
  userItemResponseBytes:single.responseBytes,historyPageResponseBytes:page.responseBytes,installedBrokerFrameLimitBytes:8*1024*1024,
  bothResponsesExceedInstalledBound:single.responseBytes>8*1024*1024&&page.responseBytes>8*1024*1024,
  contentTypes,imageCharacters,pageItems:page.result.data.length,assistantItems:page.result.data.filter(e=>e.item.type==='agentMessage').length,
  toolItems:page.result.data.filter(e=>['commandExecution','mcpToolCall','dynamicToolCall'].includes(e.item.type)).length,
  applicationStatus:record.status,applicationTurnId:record.nativeSubmission?.turnId,
  inputResent:false,workStopped:false,installedLimitsChanged:false,promptOrImageContentsPrinted:false};
 await fs.writeFile('/root/projects/code-ai/ops/queued-recovery/mail-native-direct-evidence.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}catch{console.log(JSON.stringify({proofFailed:true,inputResent:false}));process.exitCode=1;}
finally{w.terminate();for(const p of pending.values())clearTimeout(p.t);}
