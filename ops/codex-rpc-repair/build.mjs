import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
const {build}=createRequire(path.resolve('payload/package.json'))('esbuild');
const hash=b=>createHash('sha256').update(b).digest('hex');
const retained=JSON.parse(await readFile('retained/release-files.json','utf8'));
for(const[f,d]of Object.entries(retained.files))assert.equal(hash(await readFile('retained/'+(f.startsWith('dist/')?'runtime/'+f.slice(5):f))),d);
await cp('retained','dist',{recursive:true});await rename('dist/runtime','dist/dist');
await chmod('dist/dist/app.mjs',0o644);
await build({absWorkingDir:path.resolve('payload'),entryPoints:['server/index.ts'],outfile:path.resolve('dist/dist/app.mjs'),bundle:true,platform:'node',format:'esm',external:['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws'],logLevel:'warning'});
const runtime=['server/codexSharedOwnerBroker.mjs','server/codexRpcDiagnostic.mjs','server/codexSharedHistory.mjs','ops/native-owner/profile-runner.mjs'];
for(const f of runtime){await mkdir('dist/'+path.dirname(f),{recursive:true});await cp('payload/'+f,'dist/'+f);}
const source=JSON.parse(await readFile('source-contract.json','utf8'));for(const[f,d]of Object.entries(source.sourceHashes))assert.equal(hash(await readFile('payload/'+f)),d);
for(const[f,d]of Object.entries(retained.files))if(!['dist/app.mjs',...runtime].includes(f))assert.equal(hash(await readFile('dist/'+f)),d,'unrelated live feature changed: '+f);
await mkdir('dist/qualification',{recursive:true});
await writeFile('dist/qualification/codex-rpc-repair.json',JSON.stringify({format:'code-ai-codex-rpc-repair-qualified',version:1,sourceHashes:source.sourceHashes,tests:JSON.parse(await readFile('rpc-repair-tests.json','utf8')),baseline:source.baseline,runtimeChanged:['dist/app.mjs',...runtime],liveAcceptanceRequired:true},null,2));
const files={};async function inventory(folder,prefix=''){for(const e of await readdir(folder,{withFileTypes:true})){const f=prefix+e.name;if(f==='release-files.json')continue;if(e.isDirectory())await inventory(folder+'/'+e.name,f+'/');else files[f]=hash(await readFile(folder+'/'+e.name));}}
await inventory('dist');await writeFile('dist/release-files.next.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2));await rename('dist/release-files.next.json','dist/release-files.json');console.log(JSON.stringify({qualified:true,retainedFeatureFiles:Object.keys(retained.files).length-runtime.length-1}));
