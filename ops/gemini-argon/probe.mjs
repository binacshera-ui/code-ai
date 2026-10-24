import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
const reports='/root/projects/code-ai/.code-ai/reports/gemini-argon-20261013';
await mkdir(reports,{recursive:true,mode:0o700});
const homes=[['gemini-developer','/home/developer/.gemini'],['support-gemini-developer','/root/projects/code-ai/.code-ai/support/homes/gemini/gemini-developer/.gemini']];
const checks=[];
for(const [profile,home] of homes){
  const env=parseEnv(await readFile(home+'/.env','utf8'));
  const key=env.GEMINI_API_KEY;
  if(!key)throw new Error('Gemini API credentials unavailable for '+profile);
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent',{
    method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},
    body:JSON.stringify({contents:[{role:'user',parts:[{text:'Return exactly CODE_AI_ARGON_OK. This is a minimal connectivity test.'}]}],generationConfig:{thinkingConfig:{thinkingLevel:'low'},maxOutputTokens:512}}),
    signal:AbortSignal.timeout(90000),
  });
  const payload=await response.json();
  const output=(payload.candidates||[]).flatMap(c=>c.content?.parts||[]).map(p=>p.text||'').join('').trim();
  const row={profile,status:response.status,modelVersion:payload.modelVersion||null,passed:response.ok&&output.includes('CODE_AI_ARGON_OK')&&/^gemini-4-argon/.test(payload.modelVersion||''),errorCode:payload.error?.status||null};
  checks.push(row);console.log(JSON.stringify(row));
}
await writeFile(reports+'/provider-probe.json',JSON.stringify({checkedAt:new Date().toISOString(),checks},null,2)+'\n',{mode:0o600});
if(checks.some(c=>!c.passed))process.exitCode=1;
