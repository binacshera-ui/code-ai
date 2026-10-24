import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const directory = new URL('./', import.meta.url);
const pairing = JSON.parse(await fs.readFile('/root/projects/code-ai/.code-ai/pairings/ubuntu-gpu-lab.json', 'utf8'));
const profile = 'ubuntu-refael';
const headers = {'x-code-ai-remote-token':pairing.token, 'content-type':'application/json'};
async function api(route, method='GET', body) {
  const r = await fetch(`http://127.0.0.1:${pairing.centralApiPort}/api/codex` + route,
    {method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('API_CHECK_HTTP_' + r.status + '_' + route.split('?')[0]);
  return r.json();
}
const evidence={checkedAt:new Date().toISOString(),serverId:pairing.id};
const profiles=await api('/profiles?mode=standard');
const existing=profiles.profiles.find(p=>p.id===profile);
if(!existing||existing.codexHome!=='/home/refael/.codex')throw new Error('EXISTING_PROFILE_HOME_NOT_USED');
evidence.existingProfileHome=existing.codexHome;
const sessions=await api('/sessions?profile='+profile+'&limit=30');
evidence.existingSessions=sessions.sessions.length;
if(!sessions.sessions.length)throw new Error('EXISTING_SESSIONS_NOT_FOUND');
const detail=await api('/sessions/'+sessions.sessions[0].id+'?profile='+profile+'&tail=20');
evidence.existingSessionDetailReadable=Boolean(detail.session?.id);
const models=await api('/models?profile='+profile);
evidence.modelCatalogAvailable=Boolean(models.models?.length||models.catalog?.models?.length);
console.log(JSON.stringify({stage:'existing-history',...evidence,modelResponseFields:Object.keys(models)}));

const created=await api('/terminal/sessions','POST',{profileId:profile,cwd:'/home/refael',columns:80,rows:24});
const terminalId=created.terminal.id;
try {
  await api('/terminal/sessions/'+terminalId+'/input','POST',{data:"printf 'CODE_AI_TERMINAL_OK\\n'; hostname; id -un; exit\n"});
  let result;
  for(let i=0;i<15;i++){
    result=await api('/terminal/sessions/'+terminalId+'/output?cursor=0');
    if(result.exited)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!result?.exited||result.exitCode!==0||!result.data.includes('CODE_AI_TERMINAL_OK')||!result.data.includes('gpu-lab'))throw new Error('APPLICATION_TERMINAL_FAILED');
  evidence.applicationTerminalPassed=true;
}finally{await api('/terminal/sessions/'+terminalId,'DELETE');}

const checkId=crypto.randomUUID();
const submitted=await api('/ask','POST',{profileId:profile,cwd:'/home/refael',async:true,
  clientRequestId:'ubuntu-connectivity-check-'+checkId,queueKey:checkId,
  prompt:'This is a brief Code AI connectivity verification. Use your command execution tool to run exactly hostname and id -un. Do not read files, change files, or use the network. Then reply with CODE_AI_UBUNTU_OK followed by the hostname and username. This is the entire task.',
  promptPreview:'בדיקת חיבור Code AI לאובונטו'});
if(!submitted.job?.id)throw new Error('APPLICATION_JOB_NOT_CREATED');
evidence.jobId=submitted.job.id;
await fs.writeFile(new URL('verification-pending.json',directory),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({stage:'job-submitted',jobId:evidence.jobId,applicationTerminalPassed:true}));
let last;
for(let i=0;i<150;i++){
  last=await api('/queue/items/'+evidence.jobId+'?includeSession=false');
  if(['succeeded','completed','failed','cancelled'].includes(last.item.status))break;
  if(i%10===0)console.log(JSON.stringify({stage:'job-running',status:last.item.status,sessionId:last.item.sessionId||null}));
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!['succeeded','completed'].includes(last.item.status)){
  console.log(JSON.stringify({stage:'job-not-completed',status:last.item.status,errorPresent:Boolean(last.item.error),jobId:evidence.jobId}));
  throw new Error('APPLICATION_JOB_NOT_SUCCESSFUL');
}
if(!last.item.finalMessage?.includes('CODE_AI_UBUNTU_OK')||!last.item.finalMessage.includes('gpu-lab')||!last.item.finalMessage.includes('refael'))throw new Error('MODEL_IDENTITY_RESPONSE_FAILED');
evidence.modelTaskPassed=true;
evidence.sessionId=last.item.sessionId;
evidence.status=last.item.status;
const session=await api('/sessions/'+evidence.sessionId+'?profile='+profile+'&tail=50');
evidence.completedSessionReadable=Boolean(session.session?.id);
const entries=session.session?.entries||session.session?.timeline||session.session?.messages||[];
evidence.timelineEntries=entries.length;
evidence.toolEntries=entries.filter(entry=>entry.entryType==='tool').length;
if(!evidence.toolEntries)throw new Error('MODEL_TOOL_EXECUTION_NOT_PRESENT_IN_TIMELINE');
await api('/sessions/'+evidence.sessionId+'/title','POST',{profileId:profile,title:'בדיקת חיבור — Ubuntu gpu-lab'});
evidence.browserVerified=false;
evidence.rebootVerified=false;
await fs.writeFile(new URL('verification.json',directory),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({stage:'passed',...evidence}));
