import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const [release,native,output]=process.argv.slice(2);
const WebSocket=createRequire(release+'/package.json')('ws');
const home=await fs.mkdtemp('/tmp/cai163-');
await fs.chmod(home,0o700);
const plan=JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json','utf8'));
Object.assign(plan,{profileId:'compat163',userHome:home,codexHome:home+'/.codex',ownerDirectory:home+'/owner',frontendSocket:home+'/.codex/code-ai-shared-owner/owner.sock',nativeBinary:native,nativeBinarySha256:'399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215',mcpDispatchers:[],desktopExecutable:'/usr/bin/true'});
Object.assign(plan,{brokerModule:release+'/server/codexSharedOwnerBroker.mjs',dispatcherModule:release+'/scripts/codex-shared-cli.mjs',adapterModule:release+'/scripts/codex-shared-stdio.mjs',runnerModule:release+'/ops/native-owner/profile-runner.mjs',guiLauncherModule:release+'/ops/native-owner/gui-launcher.mjs'});
await fs.mkdir(plan.codexHome,{mode:0o700});await fs.mkdir(plan.ownerDirectory,{mode:0o700});
const file=plan.ownerDirectory+'/plan.json';await fs.writeFile(file,JSON.stringify(plan),{mode:0o600});
const child=spawn(plan.nodeBinary,[plan.runnerModule,file],{detached:true,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:plan.codexHome},stdio:['ignore','pipe','pipe']});
const closed=once(child,'close');let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
let ws;const pending=new Map();let next=0;
const report={version:execFileSync(native,['--version'],{encoding:'utf8'}).trim(),isolatedHome:home,productionDataUsed:false,realInferenceCalls:0,checks:[],startedAt:new Date().toISOString()};
try {
 const until=Date.now()+30000;let ready;
 while(Date.now()<until){try{ready=JSON.parse(await fs.readFile(plan.ownerDirectory+'/ready.json','utf8'));break}catch{}if(child.exitCode!==null)throw Error('Runner exited: '+stderr);await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready?.profileVerified,'Real 0.163 owner did not become ready');
 assert.equal(await fs.readlink('/proc/'+ready.nativePid+'/exe'),native);report.checks.push('qualified R7 runner and broker start exact official 0.163 native with existing launch flags');
 ws=new WebSocket('ws+unix://'+plan.frontendSocket+':/',{maxPayload:16*1024*1024});ws.on('error',()=>{});
 ws.on('message',b=>{const f=JSON.parse(String(b));const p=pending.get(f.id);if(p){pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(Error('RPC '+f.error.code)):p.resolve(f.result)}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(Error('RPC deadline '+method)),10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 await once(ws,'open');
 const init=await call('initialize',{clientInfo:{name:'code-ai-0163-qualification',version:'20261016'},capabilities:{experimentalApi:true}});
 ws.send(JSON.stringify({method:'initialized',params:{}}));
 assert.equal(init.codexHome,plan.codexHome);assert.equal(init.codeAiSharedOwner.historyReads,'canonical-v1');report.checks.push('initialize and canonical-v1 bounded history transport');
 await call('configRequirements/read');report.checks.push('workspace requirements RPC');
 const account=await call('account/read',{refreshToken:false});assert.equal(account.account,null);report.checks.push('account RPC without production authentication');
 await call('model/list',{limit:10});report.checks.push('model-list RPC');
 const thread=await call('thread/start',{cwd:home,model:'gpt-6.1-sol',ephemeral:true,approvalPolicy:'never',sandbox:'danger-full-access'});
 assert.ok(thread.thread.id);report.checks.push('thread creation without submitting input or inference');
 report.passed=true;
}catch(e){report.passed=false;report.error=e.message;process.exitCode=1}
finally{
 for(const p of pending.values())clearTimeout(p.timer);ws?.terminate();
 if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{}}
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);
 await closed;clearTimeout(timer);report.fixtureProcessesStopped=true;report.finishedAt=new Date().toISOString();
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
