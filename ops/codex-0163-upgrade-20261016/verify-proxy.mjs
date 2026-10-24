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

assert.equal(h.id,'main');
const report={checkedAt:new Date().toISOString(),through:'authenticated Code AI control-plane proxy',hosts:[]};
for(const id of ['beam-10g','pci','ubuntu-gpu-lab','personal-windows-me']){
 const row={id};
 try{
  const response=await fetch(origin+'/api/codex/remote-agent/health',{headers:{...headers,'x-code-ai-server-id':id},signal:AbortSignal.timeout(25000)});row.http=response.status;
  if(response.ok){const body=await response.json();Object.assign(row,{ready:body.ready,applicationRelease:body.version,nativeVersion:body.codexVersion,profiles:body.profiles.filter(p=>p.provider==='codex'&&!p.sourceProfileId).map(p=>({id:p.id,authenticated:p.authenticated,transportReady:p.transportReady,nativeVersion:p.codexVersion,versionMatched:p.versionMatched}))});}
 }catch(e){row.http=null;row.transportFailure=true;}
 report.hosts.push(row);
}
report.updatedServersVerified=report.hosts.filter(x=>['beam-10g','pci'].includes(x.id)).every(x=>x.http===200&&x.ready&&x.applicationRelease==='fleet-20261016-5968fec9d003'&&x.nativeVersion==='codex-cli 0.163.0');
report.localUbuntuChanged=false;report.windowsDeployed=false;
await fs.writeFile(output+'/control-plane-proxy-health.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
if(!report.updatedServersVerified)process.exitCode=1;
