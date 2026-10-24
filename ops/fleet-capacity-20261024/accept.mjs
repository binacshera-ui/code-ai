import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fleetClient} from '../focus-notifications-20261020/fleet-live.mjs';
const id=process.argv[2];assert.ok(['pci','beam-10g','personal-windows-me'].includes(id));
const ops='/root/projects/code-ai/ops/fleet-capacity-20261024',api=await fleetClient();
const file=ops+'/'+id+'-acceptance.json';
const report=JSON.parse(await fs.readFile(file,'utf8').catch(()=>JSON.stringify({id,startedAt:new Date().toISOString(),runs:[]})));
const save=()=>fs.writeFile(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
 const health=await api(id,'/remote-agent/health');
 assert.equal(health.version,'capacity-api-20261023-H18JOE');assert.equal(health.ready,true);
 const {profiles}=await api(id,'/profiles');
 report.health={version:health.version,ready:health.ready,profiles:health.profiles};await save();
 const owners=health.profiles.filter(profile=>profile.provider==='codex'&&profile.mode==='standard');
 for(const owner of owners){
  const nonce='CODE_AI_FLEET_OK_20261024',key='fleet-capacity-20261024-'+id+'-'+owner.id;
  const cwd=profiles.find(profile=>profile.id===owner.id)?.workspaceCwd;assert.ok(cwd);
  let run=report.runs.find(row=>row.profile===owner.id),item;
  if(run)item=(await api(id,'/queue/items/'+run.itemId+'?includeSession=false')).item;
  else{
   await api(id,'/session-final-notification',{profileId:owner.id,sessionKey:key,enabled:false});
   item=(await api(id,'/queue/items',{profileId:owner.id,queueKey:key,clientRequestId:key,cwd,
    prompt:'Code AI release acceptance only. Make exactly one terminal tool call to run hostname and '+(id==='personal-windows-me'?'whoami':'id')+'. This is a read-only identity test: do not modify files, read other files, call a network, delegate, create goals, or change authentication/configuration. After command success report the observed host and user briefly and end with '+nonce+'.',
    promptPreview:'בדיקת זהות ותקינות אחרי עדכון CODE-AI'})).item;
   run={profile:owner.id,itemId:item.id,status:item.status};report.runs.push(run);await save();
  }
  const deadline=Date.now()+180000;
  while(!['completed','failed','cancelled'].includes(item.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1500));item=(await api(id,'/queue/items/'+item.id+'?includeSession=false')).item;}
  Object.assign(run,{status:item.status,sessionId:item.sessionId,turnId:item.nativeSubmission?.turnId,error:item.error||null,finalMessage:item.finalMessage||null});await save();
  assert.equal(item.status,'completed');assert.ok(item.finalMessage?.includes(nonce));
  const detail=await api(id,'/sessions/'+item.sessionId+'?profile='+owner.id+'&tail=40');
  run.historyReadable=Array.isArray(detail.session.timeline);run.toolEntries=detail.session.timeline.filter(entry=>entry.entryType==='tool').length;
  assert.ok(run.toolEntries>0,'No identity-command evidence in history');
  const query='?profileId='+encodeURIComponent(owner.id)+'&sessionKey='+encodeURIComponent(item.sessionId);
  for(const route of ['/session-focus-mode','/work-mode-runs','/session-final-notification'])assert.ok(await api(id,route+query));
  run.contractsPassed=true;
  await api(id,'/sessions/'+item.sessionId+'/hide',{profileId:owner.id,hidden:true});run.testSessionHidden=true;await save();
  console.log(JSON.stringify({id,...run}));
 }
 report.passed=true;report.finishedAt=new Date().toISOString();await save();
 console.log(JSON.stringify({id,passed:true,profiles:report.runs.length}));
}catch(error){report.passed=false;report.error=error.message;await save();console.error(JSON.stringify({id,passed:false,error:error.message}));process.exitCode=1;}
