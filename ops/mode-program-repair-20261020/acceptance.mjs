import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {execFileSync}from'node:child_process';
const[root,out]=process.argv.slice(2),origin='http://127.0.0.1:4000',headers={'content-type':'application/json'};
const report={startedAt:new Date().toISOString(),release:root,health:null,lists:[],details:[],runs:[]};
const save=()=>fs.writeFile(out+'/acceptance.json',JSON.stringify(report,null,2),{mode:0o600});
async function api(route,body){const at=performance.now();const r=await fetch(origin+'/api/codex'+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),cache:'no-store',signal:AbortSignal.timeout(60000)});assert.ok(body?[200,201,202].includes(r.status):r.status===200,'HTTP '+r.status+' '+route);return{body:await r.json(),elapsedMs:Math.round(performance.now()-at)}}
try{
 const{preserveRuntimeAuthentication,parseRuntimeEnvironment}=await import(root+'/runtime-auth.mjs');
 const pm=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8'})).find(x=>x.name==='code-ai-app');
 const env={...pm.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+pm.pid+'/environ'))};
 const req=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));env.CODE_AI_AUTH_BASELINE_MODULE=req.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=req.authenticationBaselineSha256;await preserveRuntimeAuthentication(env);
 const unlock=await fetch(origin+'/api/codex/device-unlock',{method:'POST',headers,body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD}),signal:AbortSignal.timeout(15000)});assert.equal(unlock.status,200);headers.cookie=unlock.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');await unlock.arrayBuffer();
 const {body:health}=await api('/remote-agent/health');assert.equal(health.version,root.split('/').at(-1));assert.equal(health.ready,true);
 report.health={release:health.version,ready:health.ready,owners:health.profiles.filter(p=>['developer','developer2'].includes(p.id)).map(p=>({id:p.id,pid:p.nativePid,version:p.codexVersion,authenticated:p.authenticated,transportReady:p.transportReady,versionMatched:p.versionMatched}))};
 assert.equal(report.health.owners.length,2);assert.ok(report.health.owners.every(p=>p.version==='0.163.0'&&p.authenticated&&p.transportReady));await save();
 for(const profile of ['developer','developer2']){const{body,elapsedMs}=await api('/sessions?profile='+profile+'&limit=500');assert.ok(body.sessions.length);report.lists.push({profile,count:body.sessions.length,elapsedMs});}
 for(const id of ['01a11ae2-0acc-7d10-974b-8aea37c789f9','01a05cd0-8a16-7752-9558-1dbe4f9ebd3f']){const{body,elapsedMs}=await api('/sessions/'+id+'?profile=developer&tail=47');assert.equal(body.session.id,id);assert.ok(body.session.timeline.length);report.details.push({sessionId:id,entries:body.session.timeline.length,elapsedMs});}await save();
 const submits=JSON.parse(await fs.readFile(out+'/submissions.json','utf8').catch(()=>'{"items":{}}'));
 const nonce='CODE_AI_MODE_RUNTIME_OK_20261020';
 for(const [label,profile,resume]of [['new-developer','developer',false],['new-developer2','developer2',false],['resume-developer','developer',true]]){
  const key='mode-runtime-20261020-'+label;let item;
  if(submits.items[label])item=(await api('/queue/items/'+submits.items[label]+'?includeSession=false')).body.item;
  else{
   const body={profileId:profile,queueKey:key,clientRequestId:key,cwd:'/home/'+profile,prompt:'CPU-only Code AI maintenance acceptance. Run exactly one terminal command: python3 -c \'assert 7*9 == 63; print("'+nonce+'")\'. Do not read or modify files, use GPUs, start goals, delegate, or do anything else. After the command succeeds, reply exactly '+nonce+'.',promptPreview:'בדיקת תקינות תקשורת Codex אחרי תיקון האריזה'};
   if(resume){const prior=report.runs.find(r=>r.label==='new-developer');assert.ok(prior.sessionId);body.sessionId=prior.sessionId;body.queueKey=prior.sessionId;}
   item=(await api('/queue/items',body)).body.item;submits.items[label]=item.id;await fs.writeFile(out+'/submissions.json',JSON.stringify(submits),{mode:0o600});
  }
  const row={label,profile,itemId:item.id,status:item.status};report.runs.push(row);await save();console.log(JSON.stringify({phase:'submitted',...row}));
  const deadline=Date.now()+180000;
  while(!['completed','failed','cancelled'].includes(item.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));item=(await api('/queue/items/'+item.id+'?includeSession=false')).body.item;}
  row.status=item.status;row.sessionId=item.sessionId;row.error=item.error||null;row.nativeDelivery=item.nativeSubmission?.deliveryPhase;row.turnId=item.nativeSubmission?.turnId;row.expectedReply=String(item.finalMessage||'').trim().replace(/[.!]$/,'')===nonce;await save();assert.equal(item.status,'completed','Actual queue execution failed: '+item.error);assert.equal(row.expectedReply,true);
  const folder='/home/'+profile+'/.codex/sessions/'+new Date().toISOString().slice(0,10).replaceAll('-','/');const filename=(await fs.readdir(folder)).find(f=>f.endsWith('-'+item.sessionId+'.jsonl'));assert.ok(filename);
  const events=(await fs.readFile(folder+'/'+filename,'utf8')).split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}});let proven=false;
  function inspect(v,depth=0){if(depth>15||v==null)return;if(typeof v==='string'){try{inspect(JSON.parse(v),depth+1)}catch{};return;}if(typeof v!=='object')return;const output=v.aggregated_output??v.output??v.stdout;if(v.exit_code===0&&typeof output==='string'&&output.trim()===nonce)proven=true;for(const val of Object.values(v))inspect(val,depth+1);}
  for(const e of events)if(e?.type==='event_msg'||e?.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(e.payload?.type))inspect(e.payload);
  row.cpuCommandExitZeroAndStdoutProven=proven;assert.ok(proven,'Actual terminal output unproven');await save();console.log(JSON.stringify({phase:'completed',...row}));
 }
 report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({passed:true,runs:report.runs.length,lists:report.lists,owners:report.health.owners}));
}catch(e){report.passed=false;report.error=e.message;await save();console.error(JSON.stringify({passed:false,error:e.message}));process.exitCode=1;}
