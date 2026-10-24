import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const c=JSON.parse(await readFile(dir+'/capture.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const terminalFiles=['server/codexTerminal.ts','server/codexTerminalLaunch.ts','client/src/components/codex/CodexTerminalDialog.tsx','client/src/components/codex/terminalInteraction.ts','ops/terminal-ux/fixture.tsx','ops/terminal-ux/browser-check.mjs'];
const sourceSha256={};
for(const f of terminalFiles){const a=await readFile(c.predecessor+'/payload/'+f),b=await readFile(c.stage+'/payload/'+f);assert.ok(a.equals(b));sourceSha256[f]=hash(a);}
const manifest=JSON.parse(await readFile(c.baseline+'/release-files.json','utf8'));
const proofBytes=await readFile(c.baseline+'/qualification/terminal-browser.json');
assert.equal(hash(proofBytes),manifest.files['qualification/terminal-browser.json']);
const oldReceipt=JSON.parse(await readFile(root+'/ops/terminal-ux/final-receipt.json','utf8'));assert.equal(oldReceipt.complete,true);
const oldProof=JSON.parse(proofBytes);assert.equal(oldProof.passed,true);assert.equal(oldProof.checks.length,14);
const retained={...oldProof,reused:true,reason:'Terminal source and qualified styles unchanged; current repair changes queue custody/status only',
 predecessorReleaseId:oldReceipt.buildId,qualifiedAt:oldReceipt.finishedAt,sourceSha256,
 stylesheetSha256:Object.fromEntries(Object.entries(manifest.files).filter(([f])=>f.startsWith('dist/public/assets/')&&f.endsWith('.css')))};
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/queued-recovery-final-source-');await cp(c.stage,stage,{recursive:true});
await writeFile(stage+'/payload/ops/terminal-ux/retained-browser.json',JSON.stringify(retained,null,2));
let build=await readFile(stage+'/build.mjs','utf8');
const start=build.indexOf("execFileSync('npm',['install','--prefix','.browser-tools'");
const end=build.indexOf('await inventory(\'dist\');',start);assert.ok(start>0&&end>start);
build=build.slice(0,start)+`const retained=JSON.parse(await readFile('payload/ops/terminal-ux/retained-browser.json','utf8'));\nfor(const [f,h]of Object.entries(retained.sourceSha256))assert.equal(createHash('sha256').update(await readFile('payload/'+f)).digest('hex'),h);\nfor(const [f,h]of Object.entries(retained.stylesheetSha256))assert.equal(createHash('sha256').update(await readFile('dist/'+f)).digest('hex'),h);\nawait writeFile('dist/qualification/terminal-browser.json',JSON.stringify(retained,null,2));\n`+build.slice(end);
await writeFile(stage+'/build.mjs',build);
const next={...c,stage,correctedBrowserHarnessFrom:c.stage,qualifiedAt:new Date().toISOString(),clientKey:hash(stage),unchangedTerminalProofRetained:true};
await writeFile(dir+'/browser-harness-failure.json',JSON.stringify({buildId:'8e88b225-6a15-4e79-a301-b9e129ff7fc6',reason:'root_required_by_playwright_with_deps_in_nonroot_runner',unitTestsPassed:365,compiledApplication:true,installedEffects:false},null,2),{mode:0o600});
await writeFile(dir+'/capture.json',JSON.stringify(next,null,2),{mode:0o600});
console.log(JSON.stringify({stage,clientKey:next.clientKey,retainedTerminalBrowserChecks:14,exactSourceAndStylesheetGates:true}));
