/** Isolated real-binary custody qualification: no credentials or model turns. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const ops='/root/projects/code-ai/ops/codex-rpc-repair',s=JSON.parse(await fs.readFile(ops+'/staged.json','utf8')),r=s.request;
const hash=b=>createHash('sha256').update(b).digest('hex'),W=createRequire(r.candidate+'/package.json')('ws');
assert.equal(hash(await fs.readFile(r.terminalNativeBinary)),r.terminalNativeBinarySha256);
const root=await fs.mkdtemp('/mnt/hdd/code-ai-builds/codex-rpc-native-fixture-');await fs.chmod(root,0o700);
const home=root+'/.codex',dir=root+'/owner',front=home+'/code-ai-shared-owner/owner.sock';await fs.mkdir(home,{mode:0o700});await fs.mkdir(dir,{mode:0o700});
const plan={format:'code-ai-native-owner-profile',version:1,profileId:'isolated-rpc-native',userHome:root,codexHome:home,ownerDirectory:dir,nativeBinary:r.terminalNativeBinary,nativeBinarySha256:r.terminalNativeBinarySha256,nodeBinary:r.nodeExecutable,brokerModule:r.candidate+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:s.brokerSha256,dispatcherModule:r.candidate+'/scripts/codex-shared-cli.mjs',adapterModule:r.candidate+'/scripts/codex-shared-stdio.mjs',runnerModule:r.candidate+'/ops/native-owner/profile-runner.mjs',guiLauncherModule:r.candidate+'/ops/native-owner/gui-launcher.mjs',frontendSocket:front,desktopExecutable:'/usr/bin/true',guiBooleanRequirements:{'features.code_mode_host':true,'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled':true,'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled':true}};
const planFile=dir+'/profile.json';await fs.writeFile(planFile,JSON.stringify(plan),{mode:0o600});const children=[];let nativePid;
const start=()=>{const child=spawn(r.nodeExecutable,[plan.runnerModule,planFile],{detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',TMPDIR:root}});children.push(child);child.stdout.resume();child.stderr.resume();return child;};
const ready=async child=>{const end=Date.now()+30000;for(;;){const v=await fs.readFile(dir+'/ready.json','utf8').then(JSON.parse,()=>null);if(v&&child.exitCode===null){const o=JSON.parse(await fs.readFile(dir+'/ownership.json','utf8'));if(o.brokerModuleSha256===s.brokerSha256)return o;}if(child.exitCode!==null||Date.now()>end)throw Error('isolated_native_readiness_failed');await new Promise(y=>setTimeout(y,40));}};
async function rpcReadback(){const w=new W('ws+unix://'+front+':/',{handshakeTimeout:5000,maxPayload:64*1024*1024});const pending=new Map();let n=0;w.on('error',()=>{});w.on('message',b=>{let f;try{f=JSON.parse(b.toString())}catch{return}const p=pending.get(f.id);if(p){clearTimeout(p.timer);pending.delete(f.id);p.yes(f)}});const call=(method,params)=>new Promise((yes,no)=>{const id=++n,timer=setTimeout(()=>no(Error('isolated_native_rpc_timeout')),15000);pending.set(id,{yes,timer});w.send(JSON.stringify({id,method,params}))});try{await once(w,'open');const i=await call('initialize',{clientInfo:{name:'code-ai-custody-qualification',version:'1'},capabilities:{experimentalApi:true}});assert.equal(i.result.codexHome,home);assert.equal(i.result.codeAiSharedOwner.turnSettings,true);w.send(JSON.stringify({method:'initialized',params:{}}));const c=await call('configRequirements/read',null);assert.ok('result'in c);return true;}finally{w.terminate();for(const p of pending.values())clearTimeout(p.timer);}}
try{
 const first=start(),before=await ready(first);nativePid=before.nativePid;const bytes=await fs.readFile(dir+'/ownership.json');const lock=await fs.lstat(dir+'/owner.lock'),engine=await fs.lstat(dir+'/engine.sock');assert.ok(await rpcReadback());
 const closed=once(first,'close');process.kill(before.runnerPid,'SIGKILL');await closed;assert.doesNotThrow(()=>process.kill(nativePid,0));await fs.unlink(dir+'/ready.json');
 await fs.writeFile(dir+'/broker-handoff.json',JSON.stringify({format:'code-ai-broker-handoff',version:1,custodySha256:hash(bytes),brokerModuleSha256:s.brokerSha256,runnerModuleSha256:s.runnerSha256}),{mode:0o600});
 const second=start(),after=await ready(second);assert.equal(after.nativePid,nativePid);assert.deepEqual(after.nativeIdentity,before.nativeIdentity);assert.equal((await fs.lstat(dir+'/owner.lock')).ino,lock.ino);assert.equal((await fs.lstat(dir+'/engine.sock')).ino,engine.ino);assert.ok(await rpcReadback());
 const proof={format:'code-ai-real-native-broker-handoff',version:1,passed:true,fixture:root,checkedAt:new Date().toISOString(),nativeBinarySha256:r.terminalNativeBinarySha256,brokerSha256:s.brokerSha256,runnerSha256:s.runnerSha256,sameNativeGeneration:true,engineAndLockInodesPreserved:true,readbackBeforeAndAfter:true,installedEffects:false,credentialsRead:false,modelTurnsStarted:0};await fs.writeFile(ops+'/native-qualification.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}
 if(nativePid)try{process.kill(nativePid,'SIGTERM')}catch{}
}
