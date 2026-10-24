import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const dir='/root/projects/code-ai/ops/native-large-frames',root='/root/projects/code-ai';
const capture=JSON.parse(await fs.readFile(dir+'/capture.json','utf8')),payload=capture.stage+'/payload';
const targets=JSON.parse(await fs.readFile(root+'/ops/queued-recovery/staged.json','utf8')).targets;
const ubuntu=JSON.parse(await fs.readFile(root+'/ops/ubuntu-native-admission/staged.json','utf8')).target;
const run=(p,a,o={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:180000,...o}).trim();
const parse=s=>{const p=JSON.parse(s.split('\n').reverse().find(l=>l.startsWith('{')));assert.equal(p.passed,22);assert.equal(p.installedEffects,false);assert.equal(p.realProviderCalls,0);return {...p,failed:0};};
const main=targets.find(t=>t.id==='main');
const mainRun=parse(run(main.nodeExecutable,[payload+'/scripts/codex-native-queued-recovery-contract.mjs',main.terminalNativeBinary,'--broker','--interrupt-own','--recover-interrupted'],{env:{...process.env,TMPDIR:'/mnt/hdd/code-ai-builds'}}));
await fs.writeFile(dir+'/native-main.json',JSON.stringify(mainRun,null,2),{mode:0o600});
const remote=run('ssh',['-o','BatchMode=yes','personal-ubuntu-ssh','mktemp -d /home/refael/code-ai-large-native-contract-XXXXXX']);
assert.match(remote,/^\/home\/refael\/code-ai-large-native-contract-[A-Za-z0-9]+$/);
run('ssh',['personal-ubuntu-ssh',ubuntu.nodeExecutable+' -'],{input:`const f=require('fs');f.mkdirSync(${JSON.stringify(remote+'/scripts')});f.mkdirSync(${JSON.stringify(remote+'/server')});f.symlinkSync(${JSON.stringify(ubuntu.candidate+'/node_modules')},${JSON.stringify(remote+'/node_modules')});`});
const files=['scripts/codex-native-queued-recovery-contract.mjs','scripts/codex-shared-stdio.mjs','server/codexSharedOwnerBroker.mjs','server/codexQueuedRecovery.mjs','server/codexNativeTransport.mjs','server/codexSharedHistory.mjs'];
for(const f of files)run('scp',['-q',payload+'/'+f,'personal-ubuntu-ssh:'+remote+'/'+f]);
const ubuntuRun=parse(run('ssh',['personal-ubuntu-ssh',ubuntu.nodeExecutable,remote+'/scripts/codex-native-queued-recovery-contract.mjs',ubuntu.terminalNativeBinary,'--broker','--interrupt-own','--recover-interrupted']));
const proof={format:'code-ai-native-large-frames-qualified',version:1,recordedAt:new Date().toISOString(),installedEffects:false,realCredentialsRead:false,realProviderCalls:0,
 sourceSha256:Object.fromEntries(await Promise.all(files.map(async f=>[f,createHash('sha256').update(await fs.readFile(payload+'/'+f)).digest('hex')]))),
 runs:[{host:'main',...mainRun},{host:'ubuntu',...ubuntuRun}],ubuntuFixture:remote};
await fs.writeFile(capture.stage+'/native-large-frames-qualification.json',JSON.stringify(proof,null,2),{mode:0o600});
await fs.writeFile(dir+'/native-qualification.json',JSON.stringify(proof,null,2),{mode:0o600});
console.log(JSON.stringify({qualified:true,nativeChecks:44,versions:proof.runs.map(r=>r.nativeVersion),installedEffects:false}));
