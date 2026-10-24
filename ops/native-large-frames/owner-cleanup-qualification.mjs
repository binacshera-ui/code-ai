/** Isolated actual native/runner/broker lifecycle. No real home or provider input. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {once} from 'node:events';
import {selectOwnerPlanFile} from './owner-plan-contract.mjs';
const base='/root/projects/code-ai',ops=base+'/ops/native-large-frames',hash=b=>createHash('sha256').update(b).digest('hex');
const sourceRunner=base+'/ops/native-owner/profile-runner.mjs',sourceArtifacts=base+'/ops/native-owner/profile-artifacts.mjs';
const execStart=execFileSync('systemctl',['show','code-ai-native-owner-developer.service','-p','ExecStart','--value'],{encoding:'utf8',stdio:'pipe'});
const actual=JSON.parse(await fs.readFile(selectOwnerPlanFile(execStart,'/home/developer/code-ai-native-owner'),'utf8'));
assert.equal(hash(await fs.readFile(actual.nativeBinary)),actual.nativeBinarySha256);
assert.equal(hash(await fs.readFile(actual.brokerModule)),actual.brokerModuleSha256);
const root=await fs.mkdtemp('/mnt/hdd/code-ai-builds/cl-'),children=[],sleep=ms=>new Promise(y=>setTimeout(y,ms));
const checks={},runnerBytes=await fs.readFile(sourceRunner),artifactsBytes=await fs.readFile(sourceArtifacts);
await fs.mkdir(root+'/runner',{mode:0o700});await fs.symlink(base+'/node_modules',root+'/node_modules');
await fs.writeFile(root+'/runner/profile-runner.mjs',runnerBytes,{mode:0o600});await fs.writeFile(root+'/runner/profile-artifacts.mjs',artifactsBytes,{mode:0o600});
async function generation(pid){const s=await fs.readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[19];}
async function start(planFile){const c=spawn(process.execPath,[root+'/runner/profile-runner.mjs',planFile],{detached:true,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});c.stdout.resume();c.stderr.resume();children.push({c,generation:await generation(c.pid),closed:once(c,'close')});return children.at(-1);}
async function end(child,force){
 if(child.c.exitCode===null&&child.c.signalCode===null&&await generation(child.c.pid)===child.generation)process.kill(-child.c.pid,force?'SIGKILL':'SIGTERM');
 if(!force){await Promise.race([child.closed,sleep(1500)]);if(child.c.exitCode===null&&child.c.signalCode===null){assert.equal(await generation(child.c.pid),child.generation);process.kill(-child.c.pid,'SIGKILL');}}
 await child.closed;
}
async function waitReady(plan,child){const end=Date.now()+25000;for(;;){try{const r=JSON.parse(await fs.readFile(plan.ownerDirectory+'/ready.json','utf8'));if(r.brokerModuleSha256===plan.brokerModuleSha256)return r;}catch{}assert.ok(Date.now()<end&&child.c.exitCode===null&&child.c.signalCode===null,'isolated_native_ready');await sleep(50);}}
async function lab(n){const home=root+'/'+n;await fs.mkdir(home,{mode:0o700});await fs.mkdir(home+'/.codex',{mode:0o700});await fs.mkdir(home+'/o',{mode:0o700});
 const plan={...actual,profileId:'isolated-'+n,userHome:home,codexHome:home+'/.codex',ownerDirectory:home+'/o',frontendSocket:home+'/.codex/code-ai-shared-owner/owner.sock',runnerModule:root+'/runner/profile-runner.mjs',mcpDispatchers:[],desktopExecutable:'/usr/bin/true'};
 const file=home+'/o/profile.json';await fs.writeFile(file,JSON.stringify(plan),{mode:0o600});return{plan,file};}
function clean(f,expect=true){let ok=false;try{execFileSync(process.execPath,[ops+'/owner-predecessor-cleanup.mjs','lock',f.file,hash(runnerBytes),hash(artifactsBytes),hash(JSON.stringify(f.plan))],{encoding:'utf8',stdio:'pipe',timeout:15000});ok=true;}catch{}assert.equal(ok,expect);}
try{
 const a=await lab('a'),first=await start(a.file),initial=await waitReady(a.plan,first),lock=await fs.lstat(a.plan.ownerDirectory+'/owner.lock');
 clean(a,false);checks.liveOwnerCleanupRefused=true;
 await end(first,true);await fs.unlink(a.plan.ownerDirectory+'/ready.json');
 clean(a);assert.equal((await fs.lstat(a.plan.ownerDirectory+'/owner.lock')).ino,lock.ino);checks.deadRecordedEndpointsRecoveredByExactPredecessor=true;
 const candidate=JSON.parse(await fs.readFile(ops+'/staged.json','utf8')).targets.find(r=>r.id==='main').candidate;
 const next={...a.plan,brokerModule:candidate+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:hash(await fs.readFile(candidate+'/server/codexSharedOwnerBroker.mjs'))};
 await fs.writeFile(a.file,JSON.stringify(next),{mode:0o600});const second=await start(a.file),ready=await waitReady(next,second);assert.notEqual(ready.nativePid,initial.nativePid);checks.newBrokerStartsAfterForcedIdlePredecessorExit=true;await end(second,false);
 const b=await lab('b'),bc=await start(b.file);await waitReady(b.plan,bc);await end(bc,true);await fs.unlink(b.plan.frontendSocket);await fs.writeFile(b.plan.frontendSocket,'synthetic-foreign-preserve',{mode:0o600});
 clean(b,false);assert.equal(await fs.readFile(b.plan.frontendSocket,'utf8'),'synthetic-foreign-preserve');checks.changedEndpointPreserved=true;
 const c=await lab('c'),cc=await start(c.file);await waitReady(c.plan,cc);await end(cc,false);clean(c);checks.gracefulOrTimedOutIdleStopHasQualifiedRecovery=true;
 const proof={format:'code-ai-owner-stop-lifecycle-qualification',version:1,observedAt:new Date().toISOString(),fixture:root,checks,passed:Object.keys(checks).length,installedEffects:false,realCredentialsRead:false,providerInputsSent:0,nativeBinarySha256:actual.nativeBinarySha256,runnerSha256:hash(runnerBytes),artifactsSha256:hash(artifactsBytes),cleanupSha256:hash(await fs.readFile(ops+'/owner-predecessor-cleanup.mjs')),stopContractSha256:hash(await fs.readFile(ops+'/owner-stop-contract.mjs'))};
 await fs.writeFile(ops+'/owner-stop-qualification.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}catch{console.error(JSON.stringify({qualified:false,fixture:root,installedEffects:false,reason:'isolated_owner_lifecycle_failed'}));process.exitCode=1;}
finally{for(const child of children)try{await end(child,true);}catch{} }
