// Metadata-only migration gates. Credentials never leave this process.
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';
const input=[];
for await (const chunk of process.stdin) input.push(chunk);
const request=JSON.parse(Buffer.concat(input).toString('utf8'));
try {
  const env=parseEnv(await readFile('/var/lib/code-ai-pci/runtime.env','utf8'));
  assert.equal(env.CODEX_REMOTE_AGENT_TOKEN,request.token);
  const state=JSON.parse(await readFile('/var/lib/code-ai-pci/queue/state.json','utf8'));
  const counts={};
  for(const item of state.items||[]) counts[item.status]=(counts[item.status]||0)+1;
  assert.ok((state.items||[]).every(item=>['completed','failed','cancelled','draft'].includes(item.status)), 'Outstanding work blocks migration');
  const manifest=[];
  let files=0,bytes=0;
  async function walk(current,relative) {
    const st=await lstat(current);
    if(st.isDirectory()) {
      for(const name of (await readdir(current)).sort()) await walk(path.join(current,name),path.posix.join(relative,name));
    } else if(st.isSymbolicLink()) {
      manifest.push([relative,'link',await readlink(current)]);
    } else if(st.isFile()) {
      // SSH login files and runtime logs can change without a conversation write.
      if(!['.bash_history','.cache/motd.legal-displayed'].some(x=>relative.endsWith(x)) && !relative.startsWith('var/lib/code-ai-pci/logs/')) {
        manifest.push([relative,'file',createHash('sha256').update(await readFile(current)).digest('hex')]);
        files++;bytes+=st.size;
      }
    } else throw new Error('Unsupported migration file type');
  }
  if(request.inventory) {
    for(const root of ['home/admin','srv/projects','var/lib/code-ai-pci']) await walk(await realpath('/'+root),root);
  }
  let health;
  if(request.health) {
    const base='http://127.0.0.1:4010/api/codex';
    const headers={'x-code-ai-remote-token':env.CODEX_REMOTE_AGENT_TOKEN};
    const res=await fetch(base+'/remote-agent/health',{headers,signal:AbortSignal.timeout(5000)});
    assert.equal(res.status,200);
    const data=await res.json();
    assert.equal(data.hostname,request.hostname);
    assert.equal(data.codexVersion,'codex-cli 0.160.1');
    assert.equal((await fetch(base+'/remote-agent/health')).status,401);
    assert.equal((await fetch(base+'/uploads',{method:'POST'})).status,401);
    assert.equal((await fetch(base+'/uploads',{method:'POST',headers})).status,200);
    health={hostname:data.hostname,codexVersion:data.codexVersion,profiles:data.profiles.map(p=>({id:p.id,authenticated:p.authenticated})),authorizedHealth:200,unauthorizedHealth:401,authorizedUploads:200,unauthorizedUploads:401};
  }
  console.log(JSON.stringify({ok:true,counts,health,inventory:request.inventory?{files,bytes,digest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}:undefined}));
} catch(error) {
  console.error(JSON.stringify({ok:false,errorType:error.code||error.name}));
  process.exit(1);
}
