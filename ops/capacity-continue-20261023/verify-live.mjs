import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const root='/root/projects/code-ai', ops=root+'/ops/capacity-continue-20261023';
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const staged=await json(ops+'/staged.json'),activation=await json(ops+'/activation.json');
assert.equal(activation.passed,true);
assert.equal(await fs.realpath(root+'/dist'),staged.candidate+'/dist');
const {preserveRuntimeAuthentication}=await import(pathToFileURL(staged.candidate+'/runtime-auth.mjs'));
const env={CODE_AI_AUTH_BASELINE_MODULE:staged.request.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:staged.request.authenticationBaselineSha256};
await preserveRuntimeAuthentication(env);
const checks=[];
for(const origin of ['http://127.0.0.1:4000','http://127.0.0.1:4001','https://app-codex.bina-cshera.co.il','https://app-code-ai.bina-cshera.co.il']){
 const response=await fetch(origin+'/api/auth/check-session',{signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);
 const body=await response.json();assert.equal(typeof body,'object');
 checks.push({origin,route:'/api/auth/check-session',status:response.status,json:true});
}
const origin='https://app-codex.bina-cshera.co.il';
const unlocked=await fetch(origin+'/api/codex/device-unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD}),signal:AbortSignal.timeout(15000)});
assert.equal(unlocked.status,200);
const cookie=unlocked.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
for(const route of ['/api/codex/profiles','/api/codex/queue/items?profile=developer']){
 const response=await fetch(origin+route,{headers:{cookie},signal:AbortSignal.timeout(30000)});
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);
 const body=await response.json();assert.ok(body&&typeof body==='object');
 checks.push({origin,route,status:response.status,json:true});
}
const browser=spawn(root+'/.venv/bin/python',[ops+'/browser-check.py'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CODE_AI_CHECK_ORIGIN:origin,CODE_AI_CHECK_COOKIE:cookie},stdio:['ignore','pipe','pipe']});
let output='',error='';browser.stdout.on('data',value=>output+=value);browser.stderr.on('data',value=>error+=value);
const code=await new Promise(resolve=>browser.once('exit',resolve));
assert.equal(code,0,error.slice(-2500));
const ui=JSON.parse(output);assert.equal(ui.passed,true);
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),staged.uiPointer);
const result={passed:true,at:new Date().toISOString(),checks,browser:ui,activeRelease:staged.candidate,frontendUnchanged:true,realTasksSubmitted:false,personalChrome:'DEVICE_OFFLINE'};
await fs.writeFile(ops+'/live-verification.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
