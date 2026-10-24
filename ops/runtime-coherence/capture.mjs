import assert from'node:assert/strict';import fs from'node:fs/promises';import {createHash}from'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/runtime-coherence',predecessor='/mnt/hdd/code-ai-builds/native-large-frames-source-tOHQsM',baseline='/mnt/hdd/code-ai-builds/native-large-frames-live-477ce0f0-4633-4871-a370-42778e15a465';
await fs.mkdir(dir,{recursive:true,mode:0o700});assert.equal(await fs.realpath(root+'/dist'),baseline+'/dist');
const stage=await fs.mkdtemp('/mnt/hdd/code-ai-builds/runtime-coherence-source-'),hash=b=>createHash('sha256').update(b).digest('hex');
await fs.cp(predecessor,stage,{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.git|\.qualification|\.browser-tools)(?:\/|$)/.test(p)});
const changed=['server/codexRuntimePrograms.mjs','server/codexRuntimePrograms.test.mjs','server/codexSharedModes.ts','server/codexSharedModes.test.ts','server/codexSharedAccountAuth.mjs','server/codexSharedAccountAuth.test.mjs','server/codexAccountAuth.ts','server/codexAccountAuth.test.ts','server/codexService.ts','server/codexSessionMessages.ts','server/codexSessionMessages.test.ts','server/codexTerminalLaunch.ts','server/codexTerminalLaunch.test.ts','scripts/copy-personal-chrome-runtime.mjs'];
for(const f of changed)await fs.cp(root+'/'+f,stage+'/payload/'+f);
let tests=await fs.readFile(stage+'/test.mjs','utf8');tests=tests.replace("const checks = [","const checks = [\n 'server/codexSharedModes.test.ts', 'server/codexAccountAuth.test.ts',");tests=tests.replace("'server/codexNativeLargeFrames.test.mjs',", "'server/codexRuntimePrograms.test.mjs', 'server/codexSharedAccountAuth.test.mjs', 'server/codexNativeLargeFrames.test.mjs',");await fs.writeFile(stage+'/test.mjs',tests);
let build=await fs.readFile(stage+'/build.mjs','utf8');
build=build.replace("'codexNativeTransport.mjs','codexSharedHistory.mjs']","'codexNativeTransport.mjs','codexSharedHistory.mjs','codexSharedAccountAuth.mjs','codexRuntimePrograms.mjs']");
const retained=JSON.parse(await fs.readFile(stage+'/payload/ops/terminal-ux/retained-browser.json','utf8'));
for(const f of Object.keys(retained.sourceSha256)){await fs.mkdir(stage+'/retained-browser-source/'+f.slice(0,f.lastIndexOf('/')),{recursive:true});await fs.cp(predecessor+'/payload/'+f,stage+'/retained-browser-source/'+f);}
build=build.replace("for(const [f,h]of Object.entries(retained.sourceSha256))assert.equal(createHash('sha256').update(await readFile('payload/'+f))", "for(const [f,h]of Object.entries(retained.sourceSha256))assert.equal(createHash('sha256').update(await readFile('retained-browser-source/'+f))");
await fs.writeFile(stage+'/build.mjs',build);
const report={format:'code-ai-runtime-coherence-source',version:1,stage,predecessor,baseline,baselineBuildId:'477ce0f0-4633-4871-a370-42778e15a465',changed,sourceFilesSha256:Object.fromEntries(await Promise.all(changed.map(async f=>[f,hash(await fs.readFile(stage+'/payload/'+f))]))),clientKey:hash(stage),capturedAt:new Date().toISOString()};
await fs.writeFile(dir+'/capture.json',JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({captured:true,stage,changedFiles:changed.length,clientKey:report.clientKey}));
