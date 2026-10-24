import { execFileSync,spawn } from 'node:child_process';
import { cp,mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

execFileSync('npm',['run','build'],{cwd:'payload',stdio:'inherit'});
const scratch=await mkdtemp('/tmp/code-ai-chrome-profile-edit-contract-');
await mkdir(scratch+'/.codex/sessions',{recursive:true});
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const password=randomBytes(32).toString('hex');
const env={...process.env,HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production',
  CODEX_APP_ROOT:path.resolve('payload'),CODEX_STORAGE_ROOT:scratch,CODEX_OPEN_ACCESS:'true',
  CODEX_DEVICE_ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(32).toString('hex'),CODEX_REMOTE_AGENT_TOKEN:'',
  CODEX_BIN:'/bin/false',CODEX_CLI_AUTO_UPDATE:'false',CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_NTFY_ENABLED:'false',
  CODEX_PROFILES_JSON:JSON.stringify([{id:'synthetic',label:'Synthetic',provider:'codex',codexHome:scratch+'/.codex',workspaceCwd:scratch,defaultProfile:true}])};
const server=spawn(process.execPath,[path.resolve('payload/dist/server.js')],{env,stdio:['ignore','pipe','pipe']});
server.stdout.resume();server.stderr.resume();
try{
  let ready=false;
  for(let i=0;i<80;i++){
    try{const response=await fetch(`http://127.0.0.1:${port}/api/codex/browser-extension/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(ready,true,'Isolated compiled backend readiness');
  const check=execFileSync(process.execPath,['scripts/personal-chrome-bridge-e2e.mjs'],{cwd:'payload',env:{...env,
    CODE_AI_E2E_BASE_URL:`http://127.0.0.1:${port}`,CODE_AI_E2E_DEVICE_PASSWORD:password,CODE_AI_E2E_PROFILE_SYNC:'1'},stdio:'pipe',timeout:120000});
  const result=JSON.parse(check.toString().trim());
  assert.equal(result.profileSyncContract,true);assert.equal(result.ok,true);
  const evidence={compiledBridgeContract:true,profileSyncContract:true,syntheticAuthenticationOnly:true,productionEffects:false,
    checks:['app-to-extension','extension-to-app','durable-private-store','stale-editor-conflict','invalid-avatar-rejected','offline-save','stale-reconnect-preserves-profile','existing-bindings-and-tool-contract']};
  await mkdir('dist',{recursive:true});await writeFile('dist/profile-contract-checks.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
}finally{
  server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)return resolve();server.once('exit',resolve);setTimeout(resolve,10000).unref();});
  if(server.exitCode===null)server.kill('SIGKILL');
}
await cp('payload/dist','dist',{recursive:true,verbatimSymlinks:true});
await cp('payload/chrome-extension','dist/chrome-extension',{recursive:true,verbatimSymlinks:true});
