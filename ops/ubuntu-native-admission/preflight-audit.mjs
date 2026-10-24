/** Read-only deployed-contract audit; only a non-installed unit fixture is written. */
import fs from'node:fs/promises';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';
const dir='/root/projects/code-ai/ops/ubuntu-native-admission',request=JSON.parse(await fs.readFile(dir+'/staging-request.json','utf8'));
const script=`import fs from'node:fs/promises';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
const r=JSON.parse(await fs.readFile(${JSON.stringify(request.requestFile)},'utf8')),h=b=>createHash('sha256').update(b).digest('hex');
const run=(p,a)=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:20000,cwd:r.candidate}).trim(),ctl=a=>run('systemctl',['--user',...a]);
const preflight=JSON.parse(run(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile]));assert.equal(preflight.prepared,true);
const report=run(r.nodeExecutable,['--test','--test-reporter=tap',r.candidate+'/host-admission-ops/idle-contract.test.mjs']);assert.ok(report.includes('# pass 4')&&report.includes('# fail 0'));
const planFile='/home/refael/code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json',planBytes=await fs.readFile(planFile),plan=JSON.parse(planBytes);
assert.equal(h(planBytes),r.planSha256);assert.equal(plan.brokerModuleSha256,r.oldBrokerSha256);assert.equal(h(await fs.readFile(r.candidate+'/server/codexSharedOwnerBroker.mjs')),r.newBrokerSha256);
const{validateProfilePlan}=await import(pathToFileURL(r.candidate+'/ops/native-owner/profile-artifacts.mjs'));
const proposed={...plan,brokerModule:r.candidate+'/server/codexSharedOwnerBroker.mjs',brokerModuleSha256:r.newBrokerSha256};validateProfilePlan(proposed);
assert.equal(JSON.stringify({...proposed,brokerModule:plan.brokerModule,brokerModuleSha256:plan.brokerModuleSha256}),JSON.stringify(plan));
const owner='/home/refael/code-ai-native-owner',o=JSON.parse(await fs.readFile(owner+'/ownership.json','utf8'));
const group=ctl(['show','code-ai-ubuntu-agent.service','-p','ControlGroup','--value']);assert.ok(group.startsWith('/user.slice/'));
const pids=(await fs.readFile('/sys/fs/cgroup'+group+'/cgroup.procs','utf8')).trim().split(/\\s+/).map(Number);assert.ok(pids.length&&pids.length<30);assert.ok(!pids.includes(o.nativePid));
for(const pid of [o.runnerPid,...pids]){const st=await fs.readFile('/proc/'+pid+'/status','utf8');assert.equal(Number(/^Uid:\\s+(\\d+)/m.exec(st)?.[1]),1000);}
const{parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(r.candidate+'/runtime-auth.mjs'));
const corePid=Number(ctl(['show','code-ai-ubuntu-agent.service','-p','MainPID','--value'])),env=parseRuntimeEnvironment(await fs.readFile('/proc/'+corePid+'/environ'));
env.CODE_AI_AUTH_BASELINE_MODULE=r.authenticationBaselineModule;env.CODE_AI_AUTH_BASELINE_SHA256=r.authenticationBaselineSha256;await preserveRuntimeAuthentication(env);
assert.equal(env.CODE_AI_CODEX_SHARED_OWNER_PROFILES,r.sharedProfiles);
for(const f of [r.environmentFile,r.pairingFile].filter(Boolean))await fs.access(f);
for(const f of ['activate-idle.mjs','idle-contract.mjs'])run(r.nodeExecutable,['--check',r.candidate+'/host-admission-ops/'+f]);
const W=createRequire(r.candidate+'/package.json')('ws'),w=new W('ws+unix://'+owner+'/engine.sock:/',{handshakeTimeout:3000,maxPayload:8*1024*1024});let n=0,p=new Map();
const rpc=(method,params)=>new Promise((y,x)=>{const id=++n,t=setTimeout(()=>{p.delete(id);x(Error('read_timeout'));},5000);p.set(id,{y,x,t});w.send(JSON.stringify({id,method,params}));});
w.on('error',()=>{});w.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}let v=p.get(f.id);if(!v)return;p.delete(f.id);clearTimeout(v.t);f.error?v.x(Error('read_refused')):v.y(f.result);});
let loaded;
try{await new Promise((y,x)=>{w.once('open',y);w.once('error',x);});let init=await rpc('initialize',{clientInfo:{name:'read-only-release-contract-audit',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.codexHome,'/home/refael/.codex');w.send(JSON.stringify({method:'initialized',params:{}}));
const l=await rpc('thread/loaded/list',{});assert.ok(Array.isArray(l.data)&&!l.nextCursor);loaded=[];
for(const id of l.data){const t=await rpc('thread/read',{threadId:id,includeTurns:false}),q=await rpc('thread/queue/list',{threadId:id,limit:100}),g=await rpc('thread/goal/get',{threadId:id});assert.ok(Array.isArray(q.data)&&!q.nextCursor&&Object.hasOwn(g,'goal'));loaded.push({status:t.thread.status.type,queued:q.data.length,goalPresent:!!g.goal});}
}finally{w.terminate();for(let v of p.values())clearTimeout(v.t);}
const fixture=await fs.mkdtemp('/home/refael/code-ai-admission-unit-audit-'),unitFile=fixture+'/code-ai-admission-fixture.service';
const unit='[Unit]\\nAfter=code-ai-native-owner-ubuntu-refael.service code-ai-ubuntu-agent.service\\n[Service]\\nType=oneshot\\nExecStart='+r.nodeExecutable+' '+r.candidate+'/host-admission-ops/activate-idle.mjs '+r.requestFile+'\\nTimeoutStartSec=infinity\\nRemainAfterExit=yes\\n';
await fs.writeFile(unitFile,unit,{mode:0o600});run('systemd-analyze',['--user','verify',unitFile]);
console.log(JSON.stringify({format:'code-ai-ubuntu-release-contract-audit',version:1,buildId:r.buildId,observedAt:new Date().toISOString(),artifactPreflightPassed:true,node24TapReporterVerified:true,idleGateTests:4,ownerPlanOnlyBrokerDelta:true,nativeApiCensusSupported:true,loaded,freezeTargetsVerified:pids.length+1,authenticationContractVerifiedPrivately:true,unitDefinitionVerified:true,installedEffects:false,credentialsPrinted:false}));`;
try{const out=execFileSync('ssh',['-o','BatchMode=yes','personal-ubuntu-ssh',request.nodeExecutable+' --input-type=module -'],{input:script,encoding:'utf8',stdio:'pipe',timeout:120000});
 const proof=JSON.parse(out);await fs.writeFile(dir+'/preflight-audit.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}catch(e){console.log(JSON.stringify({auditPassed:false,exit:e.status,assertionIdentifiers:(e.stderr||'').split('\n').filter(s=>/AssertionError|Error \[|Error:|at file:/.test(s)).slice(0,3).map(s=>s.slice(0,180))}));process.exitCode=1;}
