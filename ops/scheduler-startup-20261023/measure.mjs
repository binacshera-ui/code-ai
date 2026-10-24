import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
const root='/root/projects/code-ai', ops=root+'/ops/scheduler-startup-20261023';
const origin=process.env.CODE_AI_PERF_ORIGIN||'https://app-codex.bina-cshera.co.il';
const label=process.argv[2]||'before';assert.match(label,/^[a-z-]+$/);
const baseline=path.dirname(await fs.realpath(root+'/dist'));
const request=JSON.parse(await fs.readFile(baseline+'/fleet-request.json','utf8'));
const {preserveRuntimeAuthentication}=await import(pathToFileURL(baseline+'/runtime-auth.mjs'));
const env={CODE_AI_AUTH_BASELINE_MODULE:request.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:request.authenticationBaselineSha256};
await preserveRuntimeAuthentication(env);
const response=await fetch(origin+'/api/codex/device-unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD}),signal:AbortSignal.timeout(15000)});
assert.equal(response.status,200);
const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
const api=[];
for(const route of (label==='preview'?[]:['/api/codex/servers','/api/codex/servers?refresh=1','/api/codex/profiles','/api/codex/sessions?profile=developer','/api/codex/queue/items?profile=developer'])) {
 const at=performance.now(), r=await fetch(origin+route,{headers:{cookie},signal:AbortSignal.timeout(60000)}),body=await r.arrayBuffer();
 api.push({route,status:r.status,ms:Math.round(performance.now()-at),bytes:body.byteLength});
}
const child=spawn(root+'/.venv/bin/python',[ops+'/measure.py'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CODE_AI_PERF_ORIGIN:origin,CODE_AI_PERF_COOKIE:cookie,CODE_AI_PERF_REQUIRE_FAST:label==='before'?'0':'1'},stdio:['ignore','pipe','pipe']});
let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
const code=await new Promise(resolve=>child.once('exit',resolve));if(code!==0)throw Error(err.slice(-3000));
const result={at:new Date().toISOString(),origin,api,browser:JSON.parse(out)};
await fs.writeFile(ops+'/'+label+'.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
assert.equal(result.browser.passed,true,'Startup qualification failed; timing evidence preserved');
