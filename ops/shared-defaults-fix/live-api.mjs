import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export async function liveApi(){
 const records=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8',env:{...process.env,PM2_HOME:'/root/.pm2'}}));
 const app=records.find(x=>x.name==='code-ai-app');assert.ok(app?.pid>1);
 const root='/root/projects/code-ai';
 const {parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(root+'/dist/../runtime-auth.mjs').href).catch(async()=>{
  const {realpath}=await import('node:fs/promises');const p=await realpath(root+'/dist');return import(pathToFileURL(p+'/../runtime-auth.mjs').href);
 });
 const env={...app.pm2_env.env,...parseRuntimeEnvironment(await readFile('/proc/'+app.pid+'/environ'))};
 await preserveRuntimeAuthentication(env);
 const origin='http://127.0.0.1:4000';let cookie='';
 const request=async(route,method='GET',body)=>{
  const r=await fetch(origin+route,{method,headers:{'content-type':'application/json',cookie},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  assert.ok(r.ok,`${method} ${route}: HTTP ${r.status}`);
  if(route.endsWith('/device-unlock')){cookie=r.headers.getSetCookie().find(x=>x.startsWith('code_ai_device_unlock=')).split(';')[0];}
  if(r.status===204)return null;
  assert.match(r.headers.get('content-type'),/application\/json/);return r.json();
 };
 await request('/api/codex/device-unlock','POST',{password:env.CODEX_DEVICE_ADMIN_PASSWORD});
 return {request,pid:app.pid,env};
}
