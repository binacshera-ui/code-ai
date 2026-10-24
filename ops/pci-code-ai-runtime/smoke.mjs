import { mkdtemp, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
export async function smoke({appRoot, codexBin, nodeBinary=process.execPath}) {
  const scratch=await mkdtemp('/tmp/code-ai-pci-smoke-');
  const home=scratch+'/.codex';
  await mkdir(home+'/sessions',{recursive:true});
  const reservation=createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const token=randomBytes(32).toString('hex');
  const child=spawn(nodeBinary,[appRoot+'/dist/server.js'],{env:{PATH:process.env.PATH,HOME:scratch,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),CODEX_APP_ROOT:appRoot,CODEX_STORAGE_ROOT:scratch,CODEX_OPEN_ACCESS:'false',CODEX_DEVICE_ADMIN_PASSWORD:randomBytes(32).toString('hex'),CODEX_REMOTE_AGENT_TOKEN:token,SESSION_SECRET:randomBytes(32).toString('hex'),CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_CLI_AUTO_UPDATE:'false',CODEX_NTFY_ENABLED:'false',CODEX_BIN:codexBin,CODEX_PROFILES_JSON:JSON.stringify([{id:'pci-admin',label:'PCI Admin',provider:'codex',codexHome:home,workspaceCwd:scratch,defaultProfile:true}])},stdio:['ignore','pipe','pipe']});
  child.stdout.resume(); child.stderr.resume();
  try {
    let response;
    for(let attempt=0;attempt<80;attempt++) {
      try {response=await fetch(`http://127.0.0.1:${port}/api/codex/remote-agent/health`,{headers:{'x-code-ai-remote-token':token},signal:AbortSignal.timeout(1000)});break;} catch {}
      if(child.exitCode!==null)throw new Error(`Runtime exit code ${child.exitCode}`);
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(response,'Remote health endpoint must respond');
    assert.equal(response.status,200,'Authorized health status');
    const data=await response.json();
    assert.equal(data.ok,true);
    assert.equal(data.codexVersion,'codex-cli 0.160.1');
    assert.ok(data.profiles.some(p=>p.id==='pci-admin'),'Empty newly created account must remain selectable');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/codex/remote-agent/health`)).status,401,'Unauthorized status');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/codex/profiles`,{headers:{'x-code-ai-remote-token':token}})).status,200,'Profiles status');
    return {ok:true,authorizedStatus:200,unauthorizedStatus:401,profilesStatus:200,configuredAccountPresent:true};
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,10000).unref();});
    if(child.exitCode===null)child.kill('SIGKILL');
  }
}
