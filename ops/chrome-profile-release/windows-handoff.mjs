import { cp, mkdtemp, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const qualified=process.argv[2];
assert.ok(qualified?.startsWith('/mnt/hdd/code-ai-builds/chrome-150-qualified-'));
const hashes=JSON.parse(await readFile(path.join(qualified,'package-hashes.json'),'utf8'));
execFileSync('bina-build',['verify-import',hashes.buildId,'--import-root','/mnt/hdd/code-ai-builds/chrome-profile-imports'],{stdio:'pipe'});
for(const [name,hash] of Object.entries(hashes.files)) {
  assert.equal(path.basename(name),name);
  assert.equal(createHash('sha256').update(await readFile(path.join(qualified,'CODE-AI-Chrome-Extension',name))).digest('hex'),hash);
}
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/chrome-windows-handoff-');
await cp(path.join(qualified,'CODE-AI-Chrome-Extension'),path.join(stage,'CODE-AI-Chrome-Extension'),{recursive:true,verbatimSymlinks:true});
await copyFile(path.join(qualified,'package-hashes.json'),path.join(stage,'package-hashes.json'));
for(const name of ['personal-chrome-full-worker-native.mjs','install-personal-chrome-qualified.ps1','export-chrome-profile-identity.ps1'])await copyFile(path.join('/root/projects/code-ai/scripts',name),path.join(stage,name));
const archive=stage+'.zip';
execFileSync('zip',['-q','-r',archive,'.'],{cwd:stage,stdio:'pipe'});
console.log(JSON.stringify({stage,archive,buildId:hashes.buildId,sha256:createHash('sha256').update(await readFile(archive)).digest('hex')}));
