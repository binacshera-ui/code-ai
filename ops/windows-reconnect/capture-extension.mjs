import {execFileSync} from 'node:child_process';
import {cp,copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const predecessor='23711fe1-41fa-49b7-aac7-9c63ef7c3a6b';
const imports='/mnt/hdd/code-ai-builds/chrome-profile-imports';
execFileSync('bina-build',['verify-import',predecessor,'--import-root',imports],{stdio:'pipe'});
const base=path.join(imports,predecessor,'artifact/dist/chrome-extension');
const changed=new Set(['manifest.json','panel.js','panel.html','panel.css','README.md']);
const files=await import('node:fs/promises').then(fs=>fs.readdir(base));
for(const name of files){
 if(changed.has(name))continue;
 const old=await readFile(path.join(base,name));const current=await readFile(path.join('chrome-extension',name));
 assert.equal(createHash('sha256').update(old).digest('hex'),createHash('sha256').update(current).digest('hex'),`Unrelated extension change: ${name}`);
}
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/windows-reconnect-source-');
await cp(base,stage+'/chrome-extension',{recursive:true,verbatimSymlinks:true});
for(const name of [...changed,'panelPairing.js'])await copyFile('chrome-extension/'+name,stage+'/chrome-extension/'+name);
await mkdir(stage+'/scripts');await mkdir(stage+'/server');await mkdir(stage+'/ops/windows-reconnect',{recursive:true});
for(const file of ['personal-chrome-device-contract.test.mjs','personal-chrome-panel-profile.test.mjs','personal-chrome-panel-pairing.test.mjs','personal-chrome-transport.test.mjs','personal-chrome-background-startup.test.mjs','personal-chrome-extension.test.mjs'])await copyFile('scripts/'+file,stage+'/scripts/'+file);
for(const file of ['personalChromeBridge.ts','personalChromeProtocol.ts'])await copyFile('server/'+file,stage+'/server/'+file);
for(const file of ['register-public.mjs','register-public.test.mjs','prepare-server.mjs'])await copyFile('ops/windows-reconnect/'+file,stage+'/ops/windows-reconnect/'+file);
await copyFile('ops/windows-reconnect/extension-package.json',stage+'/package.json');
await copyFile('ops/windows-reconnect/extension-test.mjs',stage+'/test.mjs');
await copyFile('ops/windows-reconnect/extension-build.mjs',stage+'/build.mjs');
await writeFile(stage+'/package-lock.json',JSON.stringify({name:'code-ai-windows-reconnect-extension',version:'1.5.1',lockfileVersion:3,requires:true,packages:{'':{name:'code-ai-windows-reconnect-extension',version:'1.5.1'}}},null,2)+'\n');
await writeFile(stage+'/CAPTURE.json',JSON.stringify({project:'code-ai',component:'windows-reconnect-extension',predecessor,changed:[...changed,'panelPairing.js'],backendChanged:false,retention:'prepared-candidate'},null,2)+'\n');
console.log(JSON.stringify({stage,predecessor,credentialsCaptured:false}));
