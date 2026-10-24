import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fleetClient} from './fleet-live.mjs';
const [id,tag='']=process.argv.slice(2);assert.ok(['beam-10g','pci'].includes(id));assert.match(tag,/^[a-z0-9-]{0,50}$/);
const api=await fleetClient(),file='ops/focus-notifications-20261020/'+id+(tag?'-'+tag:'')+'-acceptance.json';
const report=JSON.parse(await fs.readFile(file,'utf8').catch(()=>JSON.stringify({id,startedAt:new Date().toISOString(),profiles:[],runs:[]})));
const save=()=>fs.writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
 const health=await api(id,'/remote-agent/health');
 const {profiles}=await api(id,'/profiles');
 assert.equal(health.version,'mode-runtime-20261020-f448c9677666');assert.equal(health.ready,true);
 report.version=health.version;report.owners=(health.profiles||[]).filter(p=>p.provider==='codex'&&p.mode==='standard').map(p=>({id:p.id,version:p.codexVersion,nativePid:p.nativePid,authenticated:p.authenticated,transportReady:p.transportReady,versionMatched:p.versionMatched}));
 assert.ok(report.owners.length);assert.ok(report.owners.every(p=>p.authenticated&&p.transportReady&&p.versionMatched));await save();
 for(const owner of report.owners){
  const profile=owner.id;
  const listing=await api(id,'/sessions?profile='+profile+'&limit=20');assert.ok(Array.isArray(listing.sessions));
  const row={profile,sessions:listing.sessions.length};
  if(listing.sessions.length){
   const detail=await api(id,'/sessions/'+listing.sessions[0].id+'?profile='+profile+'&tail=8');
   assert.equal(detail.session.id,listing.sessions[0].id);row.historyReadable=Array.isArray(detail.session.timeline);
  }
  report.profiles=report.profiles.filter(r=>r.profile!==profile);report.profiles.push(row);await save();
  let run=report.runs.find(r=>r.profile===profile);
  let key='fleet-runtime-20261020-'+id+'-'+profile+(tag?'-'+tag:'');const nonce='CODE_AI_FLEET_RUNTIME_OK';
  let item;
  if(run?.status==='failed'&&run.error==='Could not start Codex app-server (EACCES)'&&!run.sessionId){
   report.failedProbeAttempts??=[];report.failedProbeAttempts.push({...run,cause:'Probe used foreign home rather than configured profile workspace; input was not submitted'});
   report.runs=report.runs.filter(r=>r!==run);run=null;key+='-workspace';await save();
  }
  if(run?.itemId)item=(await api(id,'/queue/items/'+run.itemId+'?includeSession=false')).item;
  else{
   const cwd=profiles.find(p=>p.id===profile)?.workspaceCwd;assert.ok(cwd);
   item=(await api(id,'/queue/items',{profileId:profile,queueKey:key,clientRequestId:key,cwd,
    prompt:'CPU-only Code AI release acceptance. Run exactly one terminal command: python3 -c \'assert 7*9 == 63; print("'+nonce+'")\'. Do not read or modify files, use GPUs, delegate, start goals, or perform other work. After success reply exactly '+nonce+'.',
    promptPreview:'בדיקת תקינות אחרי עדכון CODE-AI'})).item;
   run={profile,itemId:item.id,status:item.status};report.runs.push(run);await save();
  }
  console.log(JSON.stringify({phase:'submitted',id,...run}));
  const deadline=Date.now()+180000;
  while(!['completed','failed','cancelled'].includes(item.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));item=(await api(id,'/queue/items/'+item.id+'?includeSession=false')).item;}
  Object.assign(run,{status:item.status,sessionId:item.sessionId,delivery:item.nativeSubmission?.deliveryPhase,turnId:item.nativeSubmission?.turnId,expectedReply:String(item.finalMessage||'').trim().replace(/[.!]$/,'')===nonce,error:item.error||null});await save();
  assert.equal(item.status,'completed');assert.equal(run.expectedReply,true);
  const detail=await api(id,'/sessions/'+item.sessionId+'?profile='+profile+'&tail=30');assert.ok(detail.session.timeline.length);
  run.historyReadable=true;
  const query='?profileId='+encodeURIComponent(profile)+'&sessionKey='+encodeURIComponent(item.sessionId);
  const {focusMode}=await api(id,'/session-focus-mode'+query);
  assert.equal(typeof focusMode.rationalEnabled,'boolean');assert.equal(typeof focusMode.decisionEnabled,'boolean');
  const {runs}=await api(id,'/work-mode-runs'+query);assert.ok(Array.isArray(runs));
  run.rationalAndDecisionSettingsAvailable=true;await save();console.log(JSON.stringify({phase:'completed',id,...run}));
 }
 report.passed=true;delete report.error;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({id,passed:true,version:report.version,profiles:report.profiles,runs:report.runs}));
}catch(e){report.passed=false;report.error=e.message;await save();console.error(JSON.stringify({id,passed:false,error:e.message}));process.exitCode=1;}
