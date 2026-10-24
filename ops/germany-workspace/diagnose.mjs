/** Germany only, metadata-only, existing shared owner. Never submits input. */
import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import {createRequire}from'node:module';
const root='/root/projects/code-ai',out=root+'/.code-ai/reports/germany-workspace-20261012';await fs.mkdir(out,{recursive:true,mode:0o700});
const W=createRequire(root+'/package.json')('ws'),sessionId='01a05cd0-8a16-7752-9558-1dbe4f9ebd3f',rows=[];
for(const id of ['developer','developer2']){
 const home='/home/'+id+'/.codex',dir=path.dirname(home)+'/code-ai-native-owner',before=JSON.parse(await fs.readFile(dir+'/ownership.json','utf8'));
 assert.equal(before.codexHome,home);
 const ws=new W('ws+unix://'+home+'/code-ai-shared-owner/owner.sock:/',{maxPayload:64*1024*1024,handshakeTimeout:5000});let n=0;const pending=new Map();ws.on('error',()=>{});
 ws.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}const p=pending.get(f.id);if(!p)return;pending.delete(f.id);clearTimeout(p.timer);p.resolve(f);});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const request=++n,timer=setTimeout(()=>{pending.delete(request);reject(Error('diagnostic_timeout'));},15000);pending.set(request,{resolve,timer});ws.send(JSON.stringify({id:request,method,params}));});
 const checks=[];
 try{
  await new Promise((y,x)=>{ws.once('open',y);ws.once('error',x);});const init=await rpc('initialize',{clientInfo:{name:'code-ai-germany-workspace-readback',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.result?.codexHome,home);ws.send(JSON.stringify({method:'initialized',params:{}}));
  // CLI 0.162.1 schema declares no parameters for configRequirements/read.
  // A cwd payload is invalid, not evidence of broken workspace requirements.
  const calls=[['configRequirements/read',null],['configRequirements/read',{}],['config/read',{includeLayers:false,cwd:root}],['account/read',{refreshToken:false}]];
  if(id==='developer')calls.push(['thread/read',{threadId:sessionId,includeTurns:false}],['thread/turns/list',{threadId:sessionId,limit:3,itemsView:'notLoaded',sortDirection:'desc'}]);
  for(const[method,params]of calls){const f=await rpc(method,params),e=f.error?.message||'';const check={method,cwd:params?.cwd||null,success:!!f.result,errorCode:f.error?.code||null,errorClass:e?/workspace requirements/i.test(e)?'workspace-requirements':/invalid type.*never.*u32|invalid type.*danger-full-access/i.test(e)?'invalid-nested-policy':/token.*refresh|logged out/i.test(e)?'auth-refresh':'other':null,errorCharacters:e.length,resultFields:f.result?Object.keys(f.result):[]};
   if(e)check.errorIndicators=Object.fromEntries(['unknown field','invalid params','failed to deserialize','unsupported','canonicalize','No such file','Permission denied','workspace','requirements','cwd','expected','null','empty','map','struct'].map(s=>[s,e.toLowerCase().includes(s.toLowerCase())]));
   if(method==='configRequirements/read')check.requirementsPresent=f.result?.requirements!=null;
   if(method==='config/read')check.policy={approval:f.result?.config?.approvalPolicy||null,sandbox:f.result?.config?.sandboxMode||null,model:f.result?.config?.model||null};
   if(method==='account/read')check.accountType=f.result?.account?.type||null;
   if(method==='thread/read'){check.threadMatched=f.result?.thread?.id===sessionId;check.status=f.result?.thread?.status?.type||null;check.cwd=f.result?.thread?.cwd||null;}
   if(method==='thread/turns/list')check.turns=f.result?.data?.map(t=>({id:t.id,status:t.status,errorPresent:!!t.error,authRefresh:!!t.error&&/token.*refresh|logged out/i.test(JSON.stringify(t.error))}));
   checks.push(check);
  }
  const after=JSON.parse(await fs.readFile(dir+'/ownership.json','utf8'));assert.equal(after.nativePid,before.nativePid);assert.equal(after.nativeIdentity.startTime,before.nativeIdentity.startTime);
  rows.push({id,home,nativePid:before.nativePid,runnerPid:before.runnerPid,brokerSha256:before.brokerModuleSha256,existingOwnerPreserved:true,checks});
 }finally{ws.terminate();for(const p of pending.values())clearTimeout(p.timer);}
}
const result={format:'code-ai-germany-workspace-diagnostic',version:1,observedAt:new Date().toISOString(),scope:'Germany main only',sessionId,newWritersStarted:false,inputsSent:false,profiles:rows};
await fs.writeFile(out+'/owner-readback.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
