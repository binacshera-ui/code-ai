import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const capture=JSON.parse(await readFile(dir+'/capture.json','utf8'));
const payload=capture.stage+'/payload';
const targets=JSON.parse(await readFile(root+'/ops/terminal-ux/staged.json','utf8')).targets;
const run=(bin,args,opts={})=>execFileSync(bin,args,{encoding:'utf8',stdio:'pipe',timeout:180000,...opts});
const parse=raw=>{const line=raw.trim().split('\n').reverse().find(l=>l.startsWith('{'));assert.ok(line);const r=JSON.parse(line);assert.equal(r.passed,22);assert.equal(r.realProviderCalls,0);assert.equal(r.installedEffects,false);return r;};
const files=['scripts/codex-native-queued-recovery-contract.mjs','scripts/codex-shared-stdio.mjs','server/codexSharedOwnerBroker.mjs','server/codexQueuedRecovery.mjs'];
const main=targets.find(t=>t.id==='main'),ubuntu=targets.find(t=>t.id==='ubuntu-gpu-lab');
// Reuse qualified dependencies for isolated native fixtures, no installed effects.
assert.deepEqual(await readFile(root+'/scripts/codex-native-submit-contract.mjs'),await readFile(payload+'/scripts/codex-native-queued-recovery-contract.mjs'));
const mainProofFile=dir+'/native-main-'+createHash('sha256').update(await readFile(payload+'/server/codexQueuedRecovery.mjs')).digest('hex')+'.json';
const mainResult=existsSync(mainProofFile)?JSON.parse(await readFile(mainProofFile,'utf8')):parse(run(main.nodeExecutable,[root+'/scripts/codex-native-submit-contract.mjs',main.terminalNativeBinary,'--broker','--interrupt-own','--recover-interrupted'],{env:{...process.env,TMPDIR:'/mnt/hdd/code-ai-builds'}}));
await writeFile(mainProofFile,JSON.stringify(mainResult,null,2),{mode:0o600});
const ubuntuRoot=run('ssh',['-o','BatchMode=yes','personal-ubuntu-ssh','mktemp -d /home/refael/code-ai-queued-recovery-contract-XXXXXX']).trim();
assert.match(ubuntuRoot,/^\/home\/refael\/code-ai-queued-recovery-contract-[a-zA-Z0-9]+$/);
const setup=`const fs=require('fs');fs.mkdirSync(${JSON.stringify(ubuntuRoot+'/scripts')});fs.mkdirSync(${JSON.stringify(ubuntuRoot+'/server')});fs.symlinkSync(${JSON.stringify(ubuntu.candidate+'/node_modules')},${JSON.stringify(ubuntuRoot+'/node_modules')});`;
run('ssh',['-o','BatchMode=yes','personal-ubuntu-ssh',ubuntu.nodeExecutable+' -'],{input:setup});
for(const f of files)run('scp',['-q','-o','BatchMode=yes',payload+'/'+f,'personal-ubuntu-ssh:'+ubuntuRoot+'/'+f]);
const ubuntuResult=parse(run('ssh',['-o','BatchMode=yes','personal-ubuntu-ssh',ubuntu.nodeExecutable,ubuntuRoot+'/scripts/codex-native-queued-recovery-contract.mjs',ubuntu.terminalNativeBinary,'--broker','--interrupt-own','--recover-interrupted']));
const proof={format:'code-ai-queued-recovery-native-qualification',version:1,recordedAt:new Date().toISOString(),installedEffects:false,realCredentialsRead:false,realProviderCalls:0,
 sourceSha256:Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await readFile(payload+'/'+f)).digest('hex')]))),
 nativeRuns:[{host:'main',...mainResult,failed:0},{host:'ubuntu',...ubuntuResult,failed:0}],ubuntuFixture:ubuntuRoot};
if(process.argv.includes('--readback-only'))await writeFile(dir+'/post-capture-native.json',JSON.stringify(proof,null,2),{mode:0o600});
else{
 await writeFile(payload+'/ops/queued-recovery/native-contract.json',JSON.stringify(proof,null,2),{mode:0o600});
 await writeFile(dir+'/native-contract.json',JSON.stringify(proof,null,2),{mode:0o600});
}
console.log(JSON.stringify({qualified:true,runs:proof.nativeRuns.map(r=>({host:r.host,version:r.nativeVersion,passed:r.passed}))}));
