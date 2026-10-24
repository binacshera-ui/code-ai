import fs from 'node:fs/promises';import path from 'node:path';import {parseEnv}from'node:util';import assert from'node:assert/strict';
const mode='cpu-tool'; const output=process.argv[3];
const root=process.argv[2],h=JSON.parse(await fs.readFile(root+'/fleet-host.json','utf8'));
const headers={'content-type':'application/json'};if(h.environmentFile)headers['x-code-ai-remote-token']=parseEnv(await fs.readFile(h.environmentFile,'utf8')).CODEX_REMOTE_AGENT_TOKEN;if(h.pairingFile)headers['x-code-ai-remote-token']=JSON.parse(await fs.readFile(h.pairingFile,'utf8')).token;
const origin='http://127.0.0.1:'+(h.id==='main'?'4000':'4010');
async function api(route,body){const r=await fetch(origin+'/api/codex'+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)});assert.ok(body?[200,201,202].includes(r.status):r.status===200,'HTTP '+route+': '+r.status);return r.json()}
if(h.id==='main'){
 const {execFileSync}=await import('node:child_process');const {preserveRuntimeAuthentication,parseRuntimeEnvironment}=await import(root+'/runtime-auth.mjs');
 const rec=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,HOME:'/root',PM2_HOME:'/root/.pm2'}})).find(x=>x.name==='code-ai-app');
 const env={...rec.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+rec.pid+'/environ'))};
 const request=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));env.CODE_AI_AUTH_BASELINE_MODULE=request.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=request.authenticationBaselineSha256;
 await preserveRuntimeAuthentication(env);
 const unlock=await fetch(origin+'/api/codex/device-unlock',{method:'POST',headers,body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD}),signal:AbortSignal.timeout(15000)});
 assert.equal(unlock.status,200,'Normal device unlock rejected');headers.cookie=unlock.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
}
const report={host:h.id,startedAt:new Date().toISOString(),checks:[],runs:[]};const save=()=>fs.writeFile(output+'/acceptance-cpu-tool.json',JSON.stringify(report,null,2),{mode:0o600});
try{
 const health=await api('/remote-agent/health');report.health=health;assert.equal(health.version,JSON.parse(await fs.readFile(root+'/release.json','utf8')).version);assert.equal(health.ok,true);assert.ok(health.profiles.filter(p=>p.provider==='codex'&&!p.sourceProfileId).every(p=>p.codexVersion==='0.163.0'),'Actual health native version 0.163 required');assert.equal(health.ready,true);report.checks.push('actual native owners initialized, workspace requirements read, authenticated, version 0.163.0');await save();
 if(h.id!=='main'){const unauth=await fetch(origin+'/api/codex/remote-agent/health',{signal:AbortSignal.timeout(10000)});assert.equal(unauth.status,401);report.checks.push('unauthenticated remote request rejected');}
 for(const profile of health.profiles.filter(p=>p.provider==='codex'&&!p.sourceProfileId)){
  const key='codex-0163-upgrade-20261016-'+mode+'-'+profile.id;const nonce=mode==='cpu-tool'?'CODE_AI_CODEX_0163_OK_20261016':'CODE_AI_FLEET_OK_20261014';let item;
  const existing=JSON.parse(await fs.readFile(output+'/acceptance-submissions.json','utf8').catch(()=>'{"items":{}}'));
  if(existing.items[profile.id]){item=(await api('/queue/items/'+existing.items[profile.id]+'?includeSession=false')).item}
  else{
   const r=await api('/queue/items',{profileId:profile.id,queueKey:key,clientRequestId:key,prompt:mode==='cpu-tool'?'CPU-only maintenance acceptance test. Run exactly one terminal command: python3 -c \'assert sum([1,2,3]) == 6; print("'+nonce+'")\'. Do not read or modify files, use GPUs, start goals, delegate, or perform any other action. After the command succeeds, reply with exactly '+nonce+'.':'Maintenance acceptance test for the explicitly authorized Code AI deployment. Do not invoke tools, start goals, delegate, or modify any files. Reply with exactly '+nonce+'.',promptPreview:'בדיקת תקינות פריסה 2026-10-16',cwd:profile.id==='pci-admin'?'/srv/beam254/code-ai-native/home':profile.id==='beam-root'?'/root':profile.id==='beam-admin'?'/home/beamadmin':'/home/'+(profile.id==='ubuntu-refael'?'refael':profile.id)});item=r.item;existing.items[profile.id]=item.id;await fs.writeFile(output+'/acceptance-submissions.json',JSON.stringify(existing),{mode:0o600});
  }
  report.runs.push({profileId:profile.id,itemId:item.id,status:item.status});await save();
  const deadline=Date.now()+180000;
  while(!['completed','failed','cancelled'].includes(item.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));item=(await api('/queue/items/'+item.id+'?includeSession=false')).item;}
  const row=report.runs.at(-1);row.status=item.status;row.sessionId=item.sessionId;row.nativeSubmission=item.nativeSubmission?{clientUserMessageId:item.nativeSubmission.clientUserMessageId,turnId:item.nativeSubmission.turnId,queuedSubmissionId:item.nativeSubmission.queuedSubmissionId}:null;
  // Only inspect the new synthetic response; never expose earlier session history.
  if(item.status==='completed'){
   row.expectedReplyPresent=String(item.finalMessage||'').trim().replace(/[.!]$/,'')===nonce;assert.equal(row.expectedReplyPresent,true,'Synthetic expected reply absent');
   if(mode==='cpu-tool'){
    const home=profile.id==='pci-admin'?'/srv/beam254/code-ai-native/home':profile.id==='beam-root'?'/root':profile.id==='beam-admin'?'/home/beamadmin':'/home/'+(profile.id==='ubuntu-refael'?'refael':profile.id);
    const folder=home+'/.codex/sessions/'+new Date().toISOString().slice(0,10).replaceAll('-','/');
    const filename=(await fs.readdir(folder)).find(f=>f.endsWith('-'+item.sessionId+'.jsonl'));
    assert.ok(filename,'Synthetic native rollout absent');const lines=(await fs.readFile(folder+'/'+filename,'utf8')).split('\n');let proven=false;const calls=[];
    function inspect(v,depth=0){if(depth>12||v==null)return;if(typeof v==='string'){try{inspect(JSON.parse(v),depth+1)}catch{};return}if(typeof v!=='object')return;
      const output=v.aggregated_output??v.output??v.stdout;if(v.exit_code===0&&typeof output==='string'&&output.trim()===nonce)proven=true;
      for(const value of Object.values(v))inspect(value,depth+1);
    }
    for(const line of lines){let event;try{event=JSON.parse(line)}catch{continue}if(event.type==='response_item'&&['function_call','custom_tool_call'].includes(event.payload?.type))calls.push(event.payload.name);
      if(event.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(event.payload?.type))inspect(event.payload.output);
      if(event.type==='event_msg'&&event.payload?.type==='exec_command_end')inspect(event.payload);
      if(event.type==='event_msg'&&event.payload?.type==='item_completed'&&event.payload.item?.type==='CommandExecution')inspect(event.payload.item);
    }
    row.toolNames=calls;row.cpuCommandOutputProven=proven;await save();assert.equal(proven,true,'CPU command stdout and exit=0 not proven');
   }

  } else {row.failure=item.error||null;}
  await save();console.log(JSON.stringify({host:h.id,...row}));assert.equal(item.status,'completed','Synthetic queue run not completed');
 }
 report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({host:h.id,passed:true,profiles:report.runs.length}));
}catch(e){report.passed=false;report.error=String(e.message).slice(0,1000);await save();console.error(JSON.stringify({host:h.id,passed:false,error:report.error}));process.exitCode=1}
