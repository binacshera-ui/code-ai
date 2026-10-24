import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp,mkdtemp,readdir,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [proofFile]=process.argv.slice(2);assert.ok(path.isAbsolute(proofFile));
const proof=JSON.parse(await readFile(proofFile,'utf8'));
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/native-owner-controller-source-');await chmod(stage,0o700);
const root='/root/projects/code-ai';
const payload=stage+'/payload';await mkdir(payload,{mode:0o755});
for(const f of ['profile-runner.mjs','profile-runner.test.mjs','profile-artifacts.mjs','profile-artifacts.test.mjs']){
  await mkdir(payload+'/ops/native-owner',{recursive:true});await cp(root+'/ops/native-owner/'+f,payload+'/ops/native-owner/'+f);
}
for(const f of ['prepare-owner.mjs','migrate-ubuntu-gui.mjs','activate-host.mjs','supervisor.mjs','archive-failed-alias.mjs']){
  await mkdir(payload+'/ops/native-unlock-release',{recursive:true});await cp(root+'/ops/native-unlock-release/'+f,payload+'/ops/native-unlock-release/'+f);
}
await mkdir(payload+'/scripts',{recursive:true});
for(const f of ['codex-shared-cli.mjs','codex-shared-cli.test.mjs','codex-shared-stdio.mjs'])await cp(root+'/scripts/'+f,payload+'/scripts/'+f);
await cp('/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/package.json',stage+'/package.json');
for(const [a,b]of [['controller-package.json','payload/package.json'],['controller-package-lock.json','payload/package-lock.json'],['controller-test.mjs','test.mjs'],['controller-build.mjs','build.mjs']])await cp(root+'/ops/native-unlock-release/'+a,stage+'/'+b);
await writeFile(payload+'/native-runner-proof.json',JSON.stringify(proof,null,2)+'\n');
const hash=b=>createHash('sha256').update(b).digest('hex'),files={};
async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const f=prefix+e.name;if(e.isDirectory())await walk(dir+'/'+e.name,f+'/');else files[f]=hash(await readFile(dir+'/'+e.name));}}
await walk(stage);const identity={format:'code-ai-owner-controller-source',version:1,files,coreBuildId:'b6196953-8f40-4acb-a040-1b31a912bea6',installedEffects:false};
await writeFile(stage+'/source-identity.json',JSON.stringify(identity,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({stage,clientKey:hash(Buffer.from(JSON.stringify(identity))),installedEffects:false}));
