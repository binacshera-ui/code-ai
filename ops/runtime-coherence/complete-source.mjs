/** A deterministic source-closure preflight, before a corrected immutable build. */
import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import {createHash}from'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/runtime-coherence',prior=JSON.parse(await fs.readFile(dir+'/capture.json','utf8'));
const stage=await fs.mkdtemp('/mnt/hdd/code-ai-builds/runtime-coherence-complete-'),hash=b=>createHash('sha256').update(b).digest('hex');
await fs.cp(prior.stage,stage,{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.qualification)(?:\/|$)/.test(p)});
const changed=[...prior.changed,'server/codexStoredHistory.mjs','server/codexStoredHistory.test.mjs','scripts/restore-session-archive-links.mjs','server/codexSessionTransport.ts','client/src/components/codex/CodexMobileApp.tsx','client/src/components/codex/sessionTimelineSync.ts','client/src/components/codex/sessionTimelineSync.test.ts'];
for(const f of changed)await fs.cp(root+'/'+f,stage+'/payload/'+f);
let tests=await fs.readFile(stage+'/test.mjs','utf8');tests=tests.replace("'server/codexRuntimePrograms.test.mjs',", "'server/codexStoredHistory.test.mjs', 'server/codexRuntimePrograms.test.mjs',");await fs.writeFile(stage+'/test.mjs',tests);
const missing=[],visited=new Set(),queue=changed.filter(f=>/\.(?:mjs|tsx?|js)$/.test(f));
async function resolve(base,relative){const exact=path.resolve(path.dirname(base),relative),choices=[exact,exact.replace(/\.js$/,'.ts'),exact.replace(/\.js$/,'.tsx'),exact+'.ts',exact+'.tsx',exact+'/index.ts',exact+'/index.tsx'];for(const p of choices)if(await fs.stat(p).then(s=>s.isFile(),()=>false))return p;return null;}
while(queue.length){const name=queue.shift();if(visited.has(name))continue;visited.add(name);const file=stage+'/payload/'+name,text=await fs.readFile(file,'utf8');
 for(const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)){
  if(!/\.(?:ts|tsx|mjs|js)$/.test(m[1])&&path.extname(m[1]))continue;
  const resolved=await resolve(file,m[1]);if(!resolved){missing.push({from:name,dependency:m[1]});continue;}
  const relative=path.relative(stage+'/payload',resolved);assert.ok(!relative.startsWith('..'));queue.push(relative);
 }
}
assert.deepEqual(missing,[],'The entire changed source dependency graph must resolve before another build');
const report={...prior,stage,predecessor:prior.stage,changed,clientKey:hash(stage),capturedAt:new Date().toISOString(),sourceClosure:{checkedModules:visited.size,missingDependencies:0},sourceFilesSha256:Object.fromEntries(await Promise.all(changed.map(async f=>[f,hash(await fs.readFile(stage+'/payload/'+f))])))};
await fs.writeFile(dir+'/capture-complete.json',JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({captured:true,stage,sourceClosure:report.sourceClosure,clientKey:report.clientKey}));
