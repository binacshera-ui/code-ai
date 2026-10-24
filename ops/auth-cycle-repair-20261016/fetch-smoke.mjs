import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {execFileSync}from'node:child_process';
const [root,output]=process.argv.slice(2);const origin='http://127.0.0.1:4000';
const report={startedAt:new Date().toISOString(),transport:'Node built-in fetch / undici connection pool',calls:[]};
const save=()=>fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
const headers={'content-type':'application/json'};
try{
 const {preserveRuntimeAuthentication,parseRuntimeEnvironment}=await import(root+'/runtime-auth.mjs');
 const rec=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,HOME:'/root',PM2_HOME:'/root/.pm2'}})).find(x=>x.name==='code-ai-app');
 const env={...rec.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+rec.pid+'/environ'))};
 const request=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));env.CODE_AI_AUTH_BASELINE_MODULE=request.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=request.authenticationBaselineSha256;await preserveRuntimeAuthentication(env);
 for(let round=0;round<3;round++)for(const route of ['/auth/status','/device-unlock','/account-auth?profile=developer','/models?profile=developer','/rate-limits?profile=developer&refresh=1']){
  const start=Date.now();const row={round,route};report.calls.push(row);await save();
  const r=await fetch(origin+'/api/codex'+route,{headers,cache:'no-store',...(route==='/device-unlock'?{method:'POST',body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD})}:{}),signal:AbortSignal.timeout(15000)});
  const payload=await r.json();row.status=r.status;row.elapsedMs=Date.now()-start;row.cacheControl=r.headers.get('cache-control');assert.equal(r.status,200);assert.ok(row.cacheControl.includes('no-store'));
  if(route==='/device-unlock')headers.cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  if(route.startsWith('/rate-limits'))assert.equal(payload.rateLimits.account.authenticated,true);
  await save();
 }
 report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report));
}catch(e){report.passed=false;report.error=e.message;await save();console.error(JSON.stringify({passed:false,error:report.error,last:report.calls.at(-1)}));process.exitCode=1}
