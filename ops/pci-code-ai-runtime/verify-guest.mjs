import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
const headers={'x-code-ai-remote-token':process.env.CODEX_REMOTE_AGENT_TOKEN};
assert.ok(headers['x-code-ai-remote-token']?.length>=32);
const base='http://127.0.0.1:4010/api/codex';
let health;
for(let attempt=0;attempt<60;attempt++) {
  try {health=await fetch(base+'/remote-agent/health',{headers,signal:AbortSignal.timeout(3000)});break;} catch {}
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.equal(health?.status,200);
const data=await health.json();
assert.equal(data.hostname,'code-ai-pci');
assert.equal(data.codexVersion,'codex-cli 0.160.1');
assert.ok(data.profiles.some(profile=>profile.id==='pci-admin'));
assert.equal(data.profiles.find(profile=>profile.id==='pci-admin').authenticated,false);
assert.equal((await fetch(base+'/remote-agent/health')).status,401);
assert.equal((await fetch(base+'/profiles',{headers})).status,200);
assert.equal((await fetch(base+'/uploads',{method:'POST'})).status,401);
assert.equal((await fetch(base+'/uploads',{method:'POST',headers})).status,200);
assert.equal(await stat('/home/admin/.codex/auth.json').then(()=>true,()=>false),false);
const queue=await readFile('/var/lib/code-ai-pci/queue/state.json','utf8').catch(error=>error.code==='ENOENT'?'{}':Promise.reject(error));
// Only aggregate counts leave the process, never the stored queue text.
const state=JSON.parse(queue);
console.log(JSON.stringify({ok:true,hostname:data.hostname,codexVersion:data.codexVersion,profile:'pci-admin',authenticated:false,authorizedHealth:200,unauthorizedHealth:401,authorizedUploads:200,unauthorizedUploads:401,queueCreated:Object.keys(state).length>0}));
