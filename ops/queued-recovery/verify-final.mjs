/** Independent post-switch readback; emits metadata, never credentials/content. */
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const run=promisify(execFile),options={encoding:'utf8',timeout:90000,maxBuffer:1024*1024,env:{...process.env,PM2_HOME:'/root/.pm2'}};
const stage=JSON.parse(await readFile(dir+'/staged.json','utf8'));
const receipt=JSON.parse(await readFile(dir+'/final-receipt.json','utf8'));
assert.equal(receipt.complete,true);assert.equal(receipt.buildId,stage.buildId);
const imported=JSON.parse(execFileSync('bina-build',['verify-import',stage.buildId,'--import-root','/mnt/hdd/code-ai-builds/queued-recovery-imports'],options));
assert.equal(imported.artifactTreeSha256,stage.artifactTreeSha256);
const log=await readFile(imported.destination+'/delivery/build.log','utf8');
const counts=[...log.matchAll(/^# tests (\d+)$/gm)].map(x=>Number(x[1]));
const failures=[...log.matchAll(/^# fail (\d+)$/gm)].map(x=>Number(x[1]));
assert.equal(counts.reduce((a,b)=>a+b,0),365);assert.ok(failures.length&&failures.every(n=>n===0));
const script=await readFile(root+'/ops/native-unlock-release/verify-installed-host.mjs','utf8');
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const readbacks=await Promise.all(stage.targets.map(async r=>{
 const metadataScript=script+`\nconst handoff=JSON.parse(await readFile(${JSON.stringify(r.candidate+'/native-preserving-handoff.json')},'utf8'));console.log(JSON.stringify({handoffVerified:handoff.nativeOwnerGenerationPreserved===true,preservedInputIds:handoff.preserved.map(i=>i.id)}));`;
 const p=hosts[r.id]?'ssh':r.nodeExecutable;
 const a=hosts[r.id]?['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+r.requestFile]:['--input-type=module','-',r.requestFile];
 const child=execFile(p,a,options);child.stdin.end(metadataScript);
 const out=await new Promise((resolve,reject)=>{let stdout='';child.stdout.on('data',s=>stdout+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve(stdout):reject(Error('Independent host readback failed')));});
 const [live,handoff]=out.trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(live.live,true);assert.equal(live.buildId,stage.buildId);assert.equal(live.pid,receipt.hosts.find(h=>h.id===r.id).pid);assert.equal(handoff.handoffVerified,true);
 return {...live,...handoff};
}));
await run(stage.targets.find(r=>r.id==='main').nodeExecutable,[dir+'/memo-evidence.mjs'],options);
const memo=JSON.parse(await readFile(dir+'/memo-evidence.json','utf8'));
assert.equal(memo.turnId,receipt.memo.turnId);assert.equal(memo.ownUserMessageCopies,1);assert.equal(memo.stillQueued,false);
assert.ok(memo.assistantItems>=receipt.memo.assistantItems&&memo.toolItems>=receipt.memo.toolItems);
const browser=JSON.parse(await readFile(imported.artifact+'/dist/qualification/terminal-browser.json','utf8'));
assert.equal(browser.passed,true);assert.equal(browser.reused,true);
const native=JSON.parse(await readFile(dir+'/post-capture-native.json','utf8'));
assert.equal(native.nativeRuns.length,2);
assert.ok(native.nativeRuns.every(r=>r.passed===22&&r.failed===0&&r.synthetic===true&&r.installedEffects===false&&r.realCredentialsRead===false&&r.realProviderCalls===0));
const browserAccess=JSON.parse(await readFile(dir+'/api-progress-readback.json','utf8'));
const proof={format:'code-ai-queued-recovery-final-readback',version:1,buildId:stage.buildId,observedAt:new Date().toISOString(),
 artifactTreeSha256:imported.artifactTreeSha256,buildLogSha256:createHash('sha256').update(log).digest('hex'),
 tests:{unitPassed:365,unitFailed:0,nativeRecoveryChecksPassed:44,nativeVersions:native.nativeRuns.map(r=>r.nativeVersion),isolatedHandoffPassed:3,terminalBrowserChecks:browser.checks.length,terminalBrowserReused:true},
 hosts:readbacks,memo,credentialsPrinted:false,credentialRotation:false,personalChromeVerified:false,browserAccess};
await writeFile(dir+'/final-readback.json',JSON.stringify(proof,null,2),{mode:0o600});
receipt.finalReadback={path:dir+'/final-readback.json',observedAt:proof.observedAt,artifactTreeSha256:proof.artifactTreeSha256};receipt.tests=proof.tests;receipt.memo=memo;receipt.browserAccess=browserAccess;
await writeFile(dir+'/final-receipt.json.tmp',JSON.stringify(receipt,null,2),{mode:0o600});await rename(dir+'/final-receipt.json.tmp',dir+'/final-receipt.json');
console.log(JSON.stringify({complete:true,buildId:stage.buildId,hosts:readbacks.map(r=>({id:r.id,live:r.live,pid:r.pid})),memo:{sameTurn:true,copies:memo.ownUserMessageCopies,queued:memo.stillQueued,assistantItems:memo.assistantItems,toolItems:memo.toolItems},tests:proof.tests}));
