import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const ops='/root/projects/code-ai/ops/codex-rpc-repair',s=JSON.parse(await fs.readFile(ops+'/staged.json','utf8'));
const W=createRequire(s.request.candidate+'/package.json')('ws');const rows=[];
for(const profile of ['developer','developer2']){
 const file='/home/'+profile+'/code-ai-native-owner/ownership.json',before=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(before.brokerModuleSha256,s.brokerSha256);
 const w=new W('ws+unix://'+before.frontendSocket+':/',{maxPayload:64*1024*1024,handshakeTimeout:5000});const pending=new Map();let n=0;
 w.on('error',()=>{});w.on('message',b=>{let f;try{f=JSON.parse(b.toString())}catch{return}const p=pending.get(f.id);if(p){pending.delete(f.id);clearTimeout(p.timer);p.yes(f)}});
 const call=(method,params)=>new Promise((yes,no)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);no(Error('readback_timeout'))},150000);pending.set(id,{yes,timer});w.send(JSON.stringify({id,method,params}));});
 try{
  await new Promise((y,x)=>{w.once('open',y);w.once('error',x)});
  const init=await call('initialize',{clientInfo:{name:'code-ai-rpc-repair-readback',version:'1'},capabilities:{experimentalApi:true}});
  assert.equal(init.result.codexHome,before.codexHome);assert.equal(init.result.codeAiSharedOwner.turnSettings,true);w.send(JSON.stringify({method:'initialized',params:{}}));
  const calls=[['configRequirements/read',null],['config/read',{includeLayers:false,cwd:'/root/projects/code-ai'}],['account/read',{refreshToken:false}]];
  if(profile==='developer')calls.push(['thread/resume',{threadId:'bfbf0ac7-6d67-40a4-9537-86335ecc1078',cwd:'/root/projects/genesis-b',excludeTurns:true}]);
  for(const[method,params]of calls){const t=Date.now(),f=await call(method,params);assert.ok('result'in f,method+' failed');const row={profile,method,passed:true,elapsedMs:Date.now()-t};
   if(method==='account/read'){row.accountType=f.result.account?.type;assert.equal(row.accountType,'chatgpt');}
   if(method==='thread/resume'){row.threadId=f.result.thread.id;row.cwd=f.result.thread.cwd;row.mode=f.result.collaborationMode?.mode;row.status=f.result.thread.status?.type;assert.equal(row.threadId,params.threadId);assert.equal(row.cwd,params.cwd);assert.equal(row.mode,'default');}
   rows.push(row);
  }
  const invalid=await call('thread/read',{threadId:'00000000-0000-4000-8000-000000000000',includeTurns:false});
  assert.ok(invalid.error);assert.equal(invalid.error.data.codeAiDiagnostic.operation,'thread/read');assert.equal(invalid.error.data.codeAiDiagnostic.reason,'native-rejected');
  assert.deepEqual(Object.keys(invalid.error.data.codeAiDiagnostic).sort(),['elapsedMs','nativeCode','operation','reason','version']);
  rows.push({profile,method:'thread/read-negative-control',passed:true,errorCode:invalid.error.code,diagnostic:invalid.error.data.codeAiDiagnostic});
  const after=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(after.nativePid,before.nativePid);assert.equal(after.nativeIdentity.startTime,before.nativeIdentity.startTime);
 }finally{w.terminate();for(const p of pending.values())clearTimeout(p.timer)}
}
const proof={format:'code-ai-codex-rpc-live-readback',version:1,buildId:s.request.buildId,checkedAt:new Date().toISOString(),passed:true,inputsSent:false,rows};await fs.writeFile(ops+'/owner-readback.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
