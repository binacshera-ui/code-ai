/** Run on Ubuntu via SSH stdin. Read native metadata only; no enqueue/update. */
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {CodexSharedOwnerBroker,BrokerRefusal} from '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/queued-recovery-1dcc7473-48f5-4696-a97f-4ed6c1fe1185/server/codexSharedOwnerBroker.mjs';
const root='/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/queued-recovery-1dcc7473-48f5-4696-a97f-4ed6c1fe1185';
const require=createRequire(root+'/package.json'),WebSocket=require('ws');
const queue=JSON.parse(await fs.readFile('/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json','utf8'));
const candidates=queue.items.filter(i=>i.status==='failed'&&i.error==='Shared native submission was refused before accepting input');
let journal={records:[]},journalPresent=false;
try{journal=JSON.parse(await fs.readFile('/home/refael/code-ai-native-owner/broker-journal.json','utf8'));journalPresent=true;}catch(e){if(e.code!=='ENOENT')throw e;}
const ws=new WebSocket('ws+unix:///home/refael/.codex/code-ai-shared-owner/owner.sock:/',{maxPayload:8*1024*1024,handshakeTimeout:5000});
let next=0;const pending=new Map();
ws.on('error',()=>{});ws.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.timer);if(f.error)p.reject(Object.assign(Error('Native read refused'),{code:f.error.code}));else p.resolve(f.result);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('Native read timeout')),10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
try{
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 await rpc('initialize',{clientInfo:{name:'code-ai-admission-metadata-audit',version:'1'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized',params:{}}));
 const loaded=await rpc('thread/loaded/list',{});
 const result=[];
 for(const i of candidates){
  const meta=await rpc('thread/read',{threadId:i.sessionId,includeTurns:false});
  // No overrides: inspect native settings without submitting or altering input.
  const state=await rpc('thread/resume',{threadId:i.sessionId,excludeTurns:true});
  const queued=await rpc('thread/queue/list',{threadId:i.sessionId,limit:100});
  const reservation=journal.records?.find(r=>r.threadId===i.sessionId);
  const permission=state.activePermissionProfile;
  const gate=new CodexSharedOwnerBroker({save:async()=>{throw Error('READ_ONLY_GATE_PASSED');}});
  gate.ownerModes.set(i.sessionId,state.collaborationMode?.mode);
  let reproducedReason;
  try{await gate.pinAndEnqueue({clientName:'code-ai',call:async(method)=>{
   if(method==='thread/queue/list')return queued;if(method==='thread/resume')return state;
   throw Error('Unexpected mutation request');
  }},{threadId:i.sessionId,clientUserMessageId:'code-ai:'+i.id,codeAiTurnSettings:{model:state.model,
   effort:state.reasoningEffort,cwd:state.cwd,approvalPolicy:state.approvalPolicy,sandboxPolicy:state.sandbox}});}catch(e){reproducedReason=e instanceof BrokerRefusal?e.reason:e.message==='READ_ONLY_GATE_PASSED'?'passed-pre-mutation-checks':'diagnostic-gate-unavailable';}
  result.push({itemId:i.id,threadId:i.sessionId,createdAt:i.createdAt,failedAt:i.updatedAt,wasLoaded:loaded.data?.includes(i.sessionId),
   requested:{model:i.model,effort:i.reasoningEffort,cwd:i.cwd,permissionModeId:i.permissionModeId},
   native:{status:meta.thread.status.type,model:state.model,effort:state.reasoningEffort,cwd:state.cwd,
    approvalPolicy:state.approvalPolicy,sandboxType:state.sandbox?.type,
    activePermissionProfile:permission&&{id:permission.id,extends:permission.extends},
    runtimeRootCount:state.runtimeWorkspaceRoots?.length,environmentCount:state.thread?.environments?.length,
    collaborationMode:state.collaborationMode?.mode,queuedItems:queued.data?.length},
   reservation:reservation&&{phase:reservation.phase,clientId:reservation.clientId,queuedId:reservation.queuedId,
    turnId:reservation.turnId,turnComplete:reservation.turnComplete,collaborationMode:reservation.collaborationMode},
   reproducedReason,nativeFieldNames:Object.keys(state),promptPrinted:false,inputSubmitted:false});
 }
 console.log(JSON.stringify({observedAt:new Date().toISOString(),journalPresent,failedAdmissions:result,unresolvedJournalCount:journal.records?.filter(r=>r.phase!=='released'||!r.turnComplete).length}));
}finally{ws.terminate();}
