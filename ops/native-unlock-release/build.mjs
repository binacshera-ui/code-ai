import {execFileSync} from 'node:child_process';
import {cp,mkdir,rename,writeFile,readFile,readdir,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {smoke as interactiveSmoke} from './api-smoke.mjs';
import {smoke as drainSmoke} from './drain-audit-smoke.mjs';
import assert from 'node:assert/strict';
execFileSync('npm',['run','build'],{cwd:'payload',stdio:'inherit'});
await rename('payload/dist/server.js','payload/dist/app.mjs');
await cp('server-entry.mjs','payload/dist/server.js');
await cp('runtime-auth.mjs','payload/runtime-auth.mjs');
await cp('payload/scripts/codex-shared-stdio.mjs','payload/dist/codex-shared-stdio.mjs');
const options={appRoot:new URL('./payload/',import.meta.url).pathname,fakeCodex:new URL('./fake-codex.mjs',import.meta.url).pathname};
// Isolated smoke does not enable shared ownership or contact installed homes.
const interactive=await interactiveSmoke(options),drain=await drainSmoke(options);
await mkdir('dist',{recursive:true});
await cp('payload/dist','dist/dist',{recursive:true});
for(const f of ['runtime-auth.mjs','install.mjs','transaction-contract.mjs']) await cp(f,'dist/'+f);
await cp('payload/package.json','dist/package.json');
for(const directory of ['personal-chrome','design-mode','ux-mode','phone-mode','browser-mode','codex-shared-modes']) await cp('payload/server/'+directory,'dist/server/'+directory,{recursive:true});
for(const f of ['codexSharedSocket.mjs','codexSharedOwnerBroker.mjs']) await cp('payload/server/'+f,'dist/server/'+f);
await cp('payload/skills','dist/skills',{recursive:true});
await cp('payload/chrome-extension','dist/chrome-extension',{recursive:true});
await cp('payload/ops/native-owner','dist/ops/native-owner',{recursive:true});
await mkdir('dist/ops/native-unlock-release',{recursive:true});
await cp('payload/ops/native-unlock-release/prepare-owner.mjs','dist/ops/native-unlock-release/prepare-owner.mjs');
await mkdir('dist/scripts',{recursive:true});
for(const f of ['codex-shared-stdio.mjs','codex-shared-cli.mjs']) await cp('payload/scripts/'+f,'dist/scripts/'+f);
await chmod('dist/scripts/codex-shared-cli.mjs',0o755);
await mkdir('dist/qualification',{recursive:true});
const protocol=JSON.parse(await readFile('payload/ops/native-owner/native-protocol-contract-20261010.json','utf8'));
const modes=JSON.parse(await readFile('payload/ops/native-owner/native-mode-contract-20261010.json','utf8'));
const gui=JSON.parse(await readFile('payload/ops/native-owner/gui-contract-ubuntu-20261010.json','utf8'));
assert.equal(protocol.installedEffects,false);assert.equal(protocol.qualified,true);assert.equal(gui.passed,true);
for(const [file,sha] of Object.entries(protocol.sourceSha256)) assert.equal(createHash('sha256').update(await readFile('payload/'+file)).digest('hex'),sha);
assert.ok(protocol.nativeRuns.length>=6&&protocol.nativeRuns.every(x=>x.failed===0));
assert.ok(modes.dispatcherFixtures.length===2&&modes.dispatcherFixtures.every(x=>x.exitCode===0&&x.actualDispatcherFrontendProven));
const proof={format:'code-ai-native-owner-qualified',version:1,compiledApplication:true,
  nativeProtocolQualified:true,guiLaunchQualified:true,modeTransportQualified:true,
  installedEffects:false,liveAcceptanceRequired:true,nativeVersions:['0.162.1','0.162.0-alpha.2'],
  protocol,modes,gui,unit:JSON.parse(await readFile('unit-audit.json','utf8')),interactive,drain,credentialRotation:false};
await writeFile('dist/qualification/native-owner.json',JSON.stringify(proof,null,2)+'\n');
const files={}; async function inventory(dir,prefix='') {for(const e of await readdir(dir,{withFileTypes:true})) {const f=prefix+e.name;if(e.isDirectory()) await inventory(dir+'/'+e.name,f+'/');else files[f]=createHash('sha256').update(await readFile(dir+'/'+e.name)).digest('hex');}}
await inventory('dist'); await writeFile('dist/release-files.json',JSON.stringify({format:'code-ai-release-files',version:1,files},null,2)+'\n');
console.log(JSON.stringify({fullReleasePackaged:true,sharedOwnerQualified:true,liveAcceptanceRequired:true}));
