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
const report=JSON.parse(await fs.readFile(output+'/control-plane-proxy-health.json','utf8'));report.queueReadProbes=[];
for(const [server,id] of [['beam-10g','b89d4200-05fa-4672-af06-538548af286b'],['beam-10g','c9a5e017-21e9-4154-8e36-240e3a20586f'],['pci','3285c15a-1dc8-43c8-a7b2-cf143e91b58a']]){
 const response=await fetch(origin+'/api/codex/queue/items/'+id+'?includeSession=false',{headers:{...headers,'x-code-ai-server-id':server},signal:AbortSignal.timeout(90000)});assert.equal(response.status,200);const body=await response.json();assert.equal(body.item.id,id);assert.equal(body.item.status,'completed');report.queueReadProbes.push({server,itemId:id,http:200,status:body.item.status,passed:true});
}
report.queueReadProbesPassed=true;await fs.writeFile(output+'/control-plane-proxy-health.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({controlPlaneQueueReadsPassed:true,probes:report.queueReadProbes.length}));
