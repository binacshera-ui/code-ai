import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,realpath,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',ops=root+'/ops/gemini-argon';
// Resolve the actual release through dist, not through the workspace parent.
const active=(await realpath(root+'/dist')).replace(/\/dist$/,'');
const source=JSON.parse(await readFile(root+'/ops/native-large-frames/capture.json','utf8')).stage;
assert.equal(active,'/mnt/hdd/code-ai-builds/native-large-frames-live-477ce0f0-4633-4871-a370-42778e15a465');
const stage=process.argv[2]||await mkdtemp('/mnt/hdd/code-ai-builds/gemini-argon-source-');
assert.match(stage,/^\/mnt\/hdd\/code-ai-builds\/gemini-argon-source-[A-Za-z0-9]+$/);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await cp(source+'/payload',stage+'/payload',{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.git|\.qualification|\.code-ai)(?:\/|$)/.test(p)});
const changed=['server/geminiModelPolicy.ts','server/geminiModelPolicy.test.ts','server/geminiDesignModelSelection.test.ts','server/geminiService.ts','server/codexDesignMode.ts','server/codexDesignMode.test.ts','server/codexUxMode.ts','server/codexUxMode.test.ts','server/codexRoutes.ts','skills/gemini-ux-partner/SKILL.md','scripts/design-mode-gemini-smoke.ts','scripts/ux-mode-gemini-smoke.ts'];
const sourceHashes={};
for(const file of changed){await cp(root+'/'+file,stage+'/payload/'+file);sourceHashes[file]=hash(await readFile(root+'/'+file));}
await mkdir(stage+'/payload/ops/gemini-argon',{recursive:true});
await cp(ops+'/cli-smoke.ts',stage+'/payload/ops/gemini-argon/cli-smoke.ts');
await cp(source+'/package.json',stage+'/package.json');
await cp(ops+'/test-build.mjs',stage+'/test.mjs');
await cp(ops+'/build.mjs',stage+'/build.mjs');
const manifest=JSON.parse(await readFile(active+'/release-files.json','utf8'));
for(const [file,digest] of Object.entries(manifest.files)){
  assert.ok(!file.startsWith('/')&&!file.split('/').includes('..'));
  assert.equal(hash(await readFile(active+'/'+file)),digest);
  const inputFile=file.startsWith('dist/')?'runtime/'+file.slice(5):file;
  await mkdir(stage+'/retained/'+path.dirname(inputFile),{recursive:true});
  await cp(active+'/'+file,stage+'/retained/'+inputFile);
}
await cp(active+'/release-files.json',stage+'/retained/release-files.json');
// Compiled application is the only runtime executable being replaced.
await chmod(stage+'/retained/runtime/app.mjs',0o644);
// Reproduce the canonical node-package source exclusions before submission.
const archiveRoot=await mkdtemp('/mnt/hdd/code-ai-builds/gemini-argon-archive-audit-');
const archive=archiveRoot+'/source.tar';
execFileSync('/usr/bin/tar',['--exclude=.git','--exclude=node_modules','--exclude=dist','--exclude=target','--exclude=.deploy-state','--exclude=.artifacts','-cf',archive,'-C',stage,'.'],{stdio:'pipe'});
for(const [file,digest] of Object.entries(manifest.files)){
  const inputFile=file.startsWith('dist/')?'runtime/'+file.slice(5):file;
  const bytes=execFileSync('/usr/bin/tar',['-xOf',archive,'./retained/'+inputFile],{maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
  assert.equal(hash(bytes),digest,'canonical source capture omitted or changed '+file);
}
await writeFile(ops+'/archive-preflight.json',JSON.stringify({stage,archive,passed:true,retainedFilesVerified:Object.keys(manifest.files).length},null,2)+'\n',{mode:0o600});
const receipt={format:'code-ai-gemini-argon-source',version:1,stage,baseline:active,baselineAppSha256:manifest.files['dist/app.mjs'],sourceHashes,changed,clientKey:hash(JSON.stringify({active,sourceHashes,stage})),capturedAt:new Date().toISOString()};
await writeFile(stage+'/source-contract.json',JSON.stringify(receipt,null,2)+'\n');
await writeFile(ops+'/capture.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({stage,baseline:active,changedFiles:changed.length,clientKey:receipt.clientKey}));
