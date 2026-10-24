import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
// Independent short-lived connections keep the CLI acceptance transport
// separate from undici's connection pool. No request writes are auto-replayed.
async function fetch(url,init={}){
 return await new Promise((resolve,reject)=>{
  const body=init.body;const req=http.request(url,{method:init.method||'GET',agent:false,headers:{...init.headers,...(body?{'content-length':Buffer.byteLength(body)}:{})},signal:init.signal},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
   res.on('end',()=>{const bytes=Buffer.concat(chunks);const headers=new Headers();
    for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);
    resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,headers,json:async()=>JSON.parse(bytes.toString()),arrayBuffer:async()=>bytes});
   });
  });req.on('error',reject);req.end(body);
 });
}
const [root,output]=process.argv.slice(2);
const fixtureLabel=process.argv[4]||'v1';
await fs.mkdir(output,{recursive:true});
const report={startedAt:new Date().toISOString(),checks:[],transientReadFailures:[]};
const save=()=>fs.writeFile(output+'/retry-acceptance.json',JSON.stringify(report,null,2),{mode:0o600});
const headers={'content-type':'application/json'};
const origin='http://127.0.0.1:4000';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,body){
 for(let i=0;i<4;i++){
  try{
   const r=await fetch(origin+'/api/codex'+route,{headers,...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
   assert.ok(r.ok,'HTTP '+r.status+' '+route);return await r.json();
  }catch(e){
   if(body!==undefined||i===3)throw e;
   report.transientReadFailures.push({route,error:e.name,at:new Date().toISOString()});await save();await pause(500);
  }
 }
}
const read=id=>api('/queue/items/'+id+'?includeSession=false').then(x=>x.item);
async function waitFor(id,predicate,timeout=180000){
 const deadline=Date.now()+timeout;let item;
 do{item=await read(id);if(predicate(item))return item;await pause(300)}while(Date.now()<deadline);
 throw new Error('Queue deadline '+id+' '+item?.status+' '+item?.nativeSubmission?.deliveryPhase);
}
const summary=x=>({id:x.id,status:x.status,sessionId:x.sessionId,retryOfItemId:x.retryOfItemId,nativeSubmission:x.nativeSubmission,error:x.error||null});
try{
 const {preserveRuntimeAuthentication,parseRuntimeEnvironment}=await import(root+'/runtime-auth.mjs');
 const rec=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,HOME:'/root',PM2_HOME:'/root/.pm2'}})).find(x=>x.name==='code-ai-app');
 const env={...rec.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+rec.pid+'/environ'))};
 const request=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));
 env.CODE_AI_AUTH_BASELINE_MODULE=request.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=request.authenticationBaselineSha256;await preserveRuntimeAuthentication(env);
 const unlock=await fetch(origin+'/api/codex/device-unlock',{method:'POST',headers,body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD}),signal:AbortSignal.timeout(20000)});
 assert.equal(unlock.status,200);headers.cookie=unlock.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const release=JSON.parse(await fs.readFile(root+'/release.json','utf8'));
 const health=await api('/remote-agent/health');assert.equal(health.version,release.version);assert.equal(health.ready,true);
 report.release=health.version;report.owners=health.profiles.filter(p=>p.provider==='codex'&&!p.sourceProfileId).map(p=>({id:p.id,pid:p.nativePid,version:p.codexVersion,authenticated:p.authenticated,transportReady:p.transportReady}));
 assert.ok(report.owners.every(p=>p.version==='0.163.0'&&p.authenticated&&p.transportReady));
 report.checks.push('Live canonical owners authenticated and running Codex 0.163.0');await save();
 report.cacheHeaders=[];
 for(const route of ['/auth/status','/account-auth?profile=developer','/models?profile=developer','/rate-limits?profile=developer&refresh=1','/remote-agent/health']){
  const started=Date.now();
  const r=await fetch(origin+'/api/codex'+route,{headers,signal:AbortSignal.timeout(25000)});
  const cc=r.headers.get('cache-control');assert.equal(r.status,200,route);assert.ok(cc?.includes('no-store'),route+' must not cache authentication state');const payload=await r.json();const elapsedMs=Date.now()-started;report.cacheHeaders.push({route,status:r.status,cacheControl:cc,elapsedMs});if(route.startsWith('/rate-limits')){assert.ok(elapsedMs<15000,'Account-only refresh must not wait for history');report.actualAccountQuota={authenticated:payload.rateLimits?.account?.authenticated,quotaGroups:payload.rateLimits?.quotaGroups?.length,error:payload.rateLimits?.accountUsageError||null};assert.equal(report.actualAccountQuota.authenticated,true);assert.ok(report.actualAccountQuota.quotaGroups>0,'Actual current-account quota is absent');}await save();
 }
 const stable=JSON.parse(await fs.readFile(output+'/submissions.json','utf8').catch(()=> '{}'));
 const persist=()=>fs.writeFile(output+'/submissions.json',JSON.stringify(stable,null,2),{mode:0o600});
 const nonce='CODE_AI_AUTH_RETRY_OK_20261016_'+fixtureLabel.toUpperCase();
 let parent;
 if(stable.parentId)parent=await read(stable.parentId);
 else{
  const key='auth-cycle-cancel-retry-20261016-'+fixtureLabel;
  const r=await api('/queue/items',{profileId:'developer',queueKey:key,clientRequestId:key,cwd:'/home/developer',prompt:'CPU-only maintenance acceptance test. Run exactly one terminal command: python3 -c \'import time; time.sleep(12); print("'+nonce+'")\'. Do not read or modify files, use GPUs, start goals, delegate, or perform any other action. After the command succeeds, reply with exactly '+nonce+'.',promptPreview:'בדיקת ביטול וניסיון חוזר אחרי התחברות'});
  parent=r.item;stable.parentId=parent.id;await persist();
 }
 if(!['cancelled','completed','failed'].includes(parent.status)){
  parent=await waitFor(parent.id,x=>x.status==='running'&&!!x.nativeSubmission?.turnId||['completed','failed','cancelled'].includes(x.status));
  if(parent.status==='running')await api('/queue/items/'+parent.id+'/cancel',{});
  parent=await waitFor(parent.id,x=>['completed','failed','cancelled'].includes(x.status));
 }
 report.parent=summary(parent);await save();
 assert.equal(parent.status,'cancelled','Synthetic parent must be cancelled');assert.equal(parent.nativeSubmission?.deliveryPhase,'cancelled','Native cancellation must be confirmed');
 const [a,b]=await Promise.all([api('/queue/items/'+parent.id+'/retry',{}),api('/queue/items/'+parent.id+'/retry',{})]);
 assert.equal(a.item.id,b.item.id,'Concurrent retries created duplicate inputs');assert.notEqual(a.item.id,parent.id);assert.equal(a.item.retryOfItemId,parent.id);
 stable.childId=a.item.id;await persist();report.child=summary(a.item);report.checks.push('Two concurrent retry clicks returned one fresh child identity');await save();
 const final=await waitFor(a.item.id,x=>['completed','failed','cancelled'].includes(x.status),240000);
 report.child=summary(final);assert.equal(final.status,'completed',final.error||'Retry did not complete');
 assert.equal(String(final.finalMessage).trim().replace(/[.!]$/,''),nonce);
 assert.notEqual(final.nativeSubmission.clientUserMessageId,parent.nativeSubmission.clientUserMessageId);
 assert.deepEqual(summary(await read(parent.id)),summary(parent),'Original terminal attempt changed');
 const persisted=JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));
 assert.equal(persisted.items.filter(x=>x.retryOfItemId===parent.id).length,1);
 const folder='/home/developer/.codex/sessions/'+new Date().toISOString().slice(0,10).replaceAll('-','/');
 const filename=(await fs.readdir(folder)).find(f=>f.endsWith('-'+final.sessionId+'.jsonl'));assert.ok(filename);
 let proven=false;
 function inspect(v,depth=0){
  if(depth>12||v==null)return;
  if(typeof v==='string'){try{inspect(JSON.parse(v),depth+1)}catch{};return}
  if(typeof v!=='object')return;
  const out=v.aggregated_output??v.output??v.stdout;if(v.exit_code===0&&typeof out==='string'&&out.trim()===nonce)proven=true;
  for(const x of Object.values(v))inspect(x,depth+1);
 }
 for(const line of (await fs.readFile(folder+'/'+filename,'utf8')).split('\n')){
  let e;try{e=JSON.parse(line)}catch{continue}
  if(e.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(e.payload?.type))inspect(e.payload.output);
  if(e.type==='event_msg'&&e.payload?.type==='exec_command_end')inspect(e.payload);
  if(e.type==='event_msg'&&e.payload?.type==='item_completed'&&e.payload.item?.type==='CommandExecution')inspect(e.payload.item);
 }
 assert.equal(proven,true,'CPU stdout and exit=0 not proven');
 report.checks.push('Fresh native retry completed real CPU command with nonce and exit 0','Failed/cancelled parent and history preserved; one persisted child');
 report.cpuCommandOutputProven=proven;report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report));
}catch(e){report.passed=false;report.error=String(e.message).slice(0,1200);await save();console.error(JSON.stringify({passed:false,error:report.error}));process.exitCode=1}
