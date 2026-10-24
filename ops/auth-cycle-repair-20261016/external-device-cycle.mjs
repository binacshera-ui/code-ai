import fs from 'node:fs/promises';import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';
const [root,output]=process.argv.slice(2);const origin='https://app-codex.bina-cshera.co.il';
const report={startedAt:new Date().toISOString(),origin,client:'isolated test client; cookies held only in memory',steps:[]};let cookies=new Map();
const save=()=>fs.writeFile(output,JSON.stringify(report,null,2),{mode:0o600});
function request(route,body){
 const lines=['url = '+JSON.stringify(origin+'/api/codex'+route),'request = '+JSON.stringify(body===undefined?'GET':'POST')];
 if(cookies.size)lines.push('header = '+JSON.stringify('Cookie: '+[...cookies].map(([k,v])=>k+'='+v).join('; ')));
 if(body!==undefined)lines.push('header = "Content-Type: application/json"','data = '+JSON.stringify(JSON.stringify(body)));
 const output=execFileSync('curl',['--config','-','--silent','--show-error','--max-time','20','--dump-header','-'],{input:lines.join('\n')+'\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
 const index=output.indexOf('\r\n\r\n');assert.ok(index>=0);const h=output.slice(0,index),payload=output.slice(index+4);assert.match(h,/^HTTP\/[^ ]+ 200/m);
 for(const line of h.split('\r\n')){
  if(!/^set-cookie:/i.test(line))continue;const value=line.slice(line.indexOf(':')+1).trim();const [entry]=value.split(';');const eq=entry.indexOf('=');const name=entry.slice(0,eq),val=entry.slice(eq+1);if(!val||/max-age=0(?:;|$)/i.test(value))cookies.delete(name);else cookies.set(name,val);
 }
 const cc=h.split('\r\n').find(x=>/^cache-control:/i.test(x));assert.ok(cc?.includes('no-store'));return JSON.parse(payload);
}
try{
 const {preserveRuntimeAuthentication,parseRuntimeEnvironment}=await import(root+'/runtime-auth.mjs');
 const rec=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8'})).find(x=>x.name==='code-ai-app');const env={...rec.pm2_env.env,...parseRuntimeEnvironment(await fs.readFile('/proc/'+rec.pid+'/environ'))};
 const req=JSON.parse(await fs.readFile(root+'/fleet-request.json','utf8'));env.CODE_AI_AUTH_BASELINE_MODULE=req.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=req.authenticationBaselineSha256;await preserveRuntimeAuthentication(env);
 const start=request('/auth/status');assert.equal(start.deviceUnlocked,false);report.steps.push('Fresh isolated client begins locked');
 assert.equal(request('/device-unlock',{password:env.CODEX_DEVICE_ADMIN_PASSWORD}).unlocked,true);assert.equal(request('/auth/status').deviceUnlocked,true);report.steps.push('Normal admin device login verified through public HTTPS');
 assert.equal(request('/logout',{}).loggedOut,true);assert.equal(request('/auth/status').deviceUnlocked,false);report.steps.push('Logout clears access for this client and subsequent status is locked');
 assert.equal(request('/device-unlock',{password:env.CODEX_DEVICE_ADMIN_PASSWORD}).unlocked,true);assert.equal(request('/auth/status').deviceUnlocked,true);report.steps.push('Login again succeeds immediately without clearing browser cache');
 assert.equal(request('/logout',{}).loggedOut,true);report.steps.push('Isolated test client logged out at completion');cookies.clear();report.passed=true;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report));
}catch(e){cookies.clear();report.passed=false;report.error='external_device_cycle_failed';report.errorCode=typeof e.code==='string'&&/^[A-Z_0-9]+$/.test(e.code)?e.code:null;await save();console.error(JSON.stringify({passed:false,error:report.error,code:report.errorCode}));process.exitCode=1}
