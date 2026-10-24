/** Execute the actual host worker helpers against an entirely synthetic /proc,
 * filesystem and systemd. No installed files, units or processes are touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsReal from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {idleTransaction} from './idle-contract.mjs';
import {stopBudgetMs,waitOwnerStopped} from './owner-stop-contract.mjs';

const source=await fsReal.readFile(new URL('./activate-owner-idle.mjs',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('const [file]'),source.indexOf('\ntry{\n const completed='));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const hash=b=>createHash('sha256').update(b).digest('hex');

async function lab({renameFailure=false,readbackFailure=false,race=false,stopTimeout=false}={}){
 const storage=new Map(),signals=[],commands=[],units=new Map();let clock=0,censuses=0,renamed=false;
 const ownerUpdates=['one','two'].map((id,i)=>({id,uid:5001+i,gid:5001+i,username:'user'+i,codexHome:'/lab/user'+i+'/.codex',ownerDirectory:'/lab/user'+i+'/code-ai-native-owner',planFile:'/lab/plan-'+id+'.json',oldBrokerSha256:'old',runnerPid:201+i,runnerSha256:'e'.repeat(64),artifactsSha256:'f'.repeat(64)}));
 const r={id:'main',buildId:'synthetic',candidate:'/lab/candidate',nodeExecutable:'/lab/node',ownerUpdates,newBrokerSha256:hash('synthetic-new-broker')};
 storage.set('/lab/request.json',JSON.stringify(r));storage.set(r.candidate+'/server/codexSharedOwnerBroker.mjs','synthetic-new-broker');
 const stat=pid=>{const fields=Array(20).fill('0');fields[0]='S';fields[1]='1';fields[19]='generation-'+pid;return pid+' (synthetic) '+fields.join(' ');};
 for(const pid of [101,102,201,202,301,302]){storage.set('/proc/'+pid+'/stat',stat(pid));storage.set('/proc/'+pid+'/status','PPid:\t'+(pid===102?101:1)+'\n');}
 for(const p of ownerUpdates){const plan={codexHome:p.codexHome,brokerModule:'/lab/old-broker',brokerModuleSha256:'old'};const bytes=JSON.stringify(plan);storage.set(p.planFile,bytes);p.planSha256=hash(bytes);units.set('code-ai-native-owner-'+p.id+'.service','active');}
 // Worker reads the request once, after all plan bindings have been captured.
 storage.set('/lab/request.json',JSON.stringify(r));
 storage.set('/root/projects/code-ai/.code-ai/queue/state.json',JSON.stringify({items:[{status:'queued'}]}));
 const fs={
  async realpath(f){assert.equal(f,'/root/projects/code-ai/dist');return r.candidate+'/dist';},
  async readFile(f,encoding){if(!storage.has(f)){const e=Error('synthetic_missing');e.code='ENOENT';throw e;}return encoding?String(storage.get(f)):Buffer.from(storage.get(f));},
  async writeFile(f,b,o){if(o?.flag==='wx'&&storage.has(f)){const e=Error('synthetic_exists');e.code='EEXIST';throw e;}storage.set(f,Buffer.isBuffer(b)?b.toString():b);},
  async chown(){},
  async rename(from,to){if(renameFailure&&!renamed&&to===ownerUpdates[1].planFile&&from.includes('.large-')){renamed=true;throw Error('synthetic_partial_write');}storage.set(to,storage.get(from));storage.delete(from);},
  async readdir(f){assert.equal(f,'/proc');return['101','102','201','202','301','302'];},
 };
 const proof=p=>({home:p.codexHome,brokerSha256:'old',nativePid:p.runnerPid+100,nativeGeneration:'generation-'+(p.runnerPid+100),runnerPid:p.runnerPid,runnerGeneration:'generation-'+p.runnerPid,
  threads:[{status:race&&censuses>2?'active':'idle',queued:0,activeGoal:false,backgroundTerminals:0}],journal:[{terminalProved:true}]});
 const execFileSync=(exe,args)=>{
  commands.push({exe,args});
  if(exe==='/usr/sbin/runuser'){
   if(args.some(a=>a.endsWith('/owner-predecessor-cleanup.mjs')))return JSON.stringify({predecessorRecoveryVerified:true,nativeStarted:false});
   censuses++;return JSON.stringify(proof(ownerUpdates.find(p=>p.codexHome===args.at(-1))));
  }
  if(exe.includes('/pm2'))return JSON.stringify([{name:'code-ai-app',pid:101}]);
  assert.equal(exe,'systemctl');const action=args[0];
  if(action==='show')return 'ActiveState='+units.get(args[1])+'\nMainPID='+(units.get(args[1])==='active'?'201':'0')+'\nTimeoutStopUSec=30s';
  if(action==='stop'){for(const u of args.filter(a=>a.endsWith('.service')))units.set(u,stopTimeout?'failed':'inactive');for(const p of ownerUpdates){storage.delete('/proc/'+p.runnerPid+'/stat');storage.delete('/proc/'+(p.runnerPid+100)+'/stat');}return'';}
  if(action==='start'){
   for(const p of ownerUpdates){const plan=JSON.parse(storage.get(p.planFile)),sha=readbackFailure&&plan.brokerModuleSha256!=='old'?'unproved':plan.brokerModuleSha256;
    // Original runners have exited after the stop jobs were admitted. A PID
    // reused by a successor must never receive the old generation's thaw.
    storage.set('/proc/'+p.runnerPid+'/stat',stat(p.runnerPid).replace('generation-'+p.runnerPid,'successor-generation'));
    const nativePid=p.runnerPid+200;storage.set('/proc/'+nativePid+'/stat',stat(nativePid));
    storage.set(p.ownerDirectory+'/ownership.json',JSON.stringify({brokerModuleSha256:sha,nativePid,nativeIdentity:{startTime:'generation-'+nativePid}}));
    storage.set(p.ownerDirectory+'/ready.json',JSON.stringify({brokerModuleSha256:sha}));units.set('code-ai-native-owner-'+p.id+'.service','active');}
   return'';
  }
  throw Error('unexpected_synthetic_command');
 };
 const process={argv:['node','worker','/lab/request.json'],env:{},getuid:()=>0,kill:(pid,signal)=>signals.push({pid,signal})};
 const NativeDate=Date;class FastDate extends NativeDate{static now(){clock+=10000;return clock;}}
 const worker=await new AsyncFunction('assert','fs','path','execFileSync','createHash','idleTransaction','stopBudgetMs','waitOwnerStopped','process','Date',helpers+'\nreturn {census,freeze,thaw,replace};')(assert,fs,path,execFileSync,createHash,idleTransaction,stopBudgetMs,waitOwnerStopped,process,FastDate);
 return{worker,storage,signals,commands,r,units};
}

test('actual owner lifecycle fences only core/descendants/runners, proves successor and preserves queued input',async()=>{
 const x=await lab();const result=await idleTransaction(x.worker);assert.equal(result.applied,true);
 assert.deepEqual(x.signals.filter(s=>s.signal==='SIGSTOP').map(s=>s.pid),[101,102,201,202]);
 assert.ok(!x.signals.some(s=>[301,302].includes(s.pid)));
 assert.equal(JSON.parse(x.storage.get(x.r.candidate+'/owner-update-status.json')).phase,'complete');
 for(const p of x.r.ownerUpdates){assert.equal(JSON.parse(x.storage.get(p.planFile)).brokerModuleSha256,x.r.newBrokerSha256);assert.ok(x.storage.has(x.r.candidate+'/owner-predecessor-'+p.id+'.json'));}
 assert.deepEqual(JSON.parse(x.storage.get('/root/projects/code-ai/.code-ai/queue/state.json')),{items:[{status:'queued'}]});
});
test('idle admission race thaws original generations without any systemd mutation',async()=>{
 const x=await lab({race:true});const result=await idleTransaction(x.worker);assert.equal(result.reason,'admission-race');
 assert.ok(!x.commands.some(c=>c.exe==='systemctl'&&['stop','start'].includes(c.args[0])));
 assert.equal(x.signals.filter(s=>s.signal==='SIGSTOP').length,x.signals.filter(s=>s.signal==='SIGCONT').length);
});
test('partial plan update before successor start restores all original plans and verifies rollback',async()=>{
 const x=await lab({renameFailure:true});await assert.rejects(idleTransaction(x.worker),/owner_prestart_failed/);
 for(const p of x.r.ownerUpdates)assert.equal(JSON.parse(x.storage.get(p.planFile)).brokerModuleSha256,'old');
 const status=JSON.parse(x.storage.get(x.r.candidate+'/owner-update-status.json'));assert.equal(status.rollbackVerified,true);assert.equal(status.inputsResent,false);
 assert.deepEqual(x.signals.filter(s=>s.signal==='SIGCONT').map(s=>s.pid),[101,102]);
});
test('unknown successor readiness halts expansion without killing a possibly active native generation',async()=>{
 const x=await lab({readbackFailure:true});await assert.rejects(idleTransaction(x.worker),/owner_readback_failed/);
 const mutations=x.commands.filter(c=>c.exe==='systemctl'&&['stop','start'].includes(c.args[0]));assert.deepEqual(mutations.map(c=>c.args[0]),['stop','start']);
 assert.equal(JSON.parse(x.storage.get(x.r.candidate+'/owner-update-status.json')).activeSuccessorNotKilled,true);
 assert.ok(!x.signals.some(s=>[301,302,401,402].includes(s.pid)));
});
test('actual worker accepts systemd failed stop ONLY after old runner/native generations died, then qualified cleanup',async()=>{
 const x=await lab({stopTimeout:true});assert.equal((await idleTransaction(x.worker)).applied,true);
 const operations=x.commands.map(c=>c.args[0]==='stop'?'stop':c.args.some(a=>a.endsWith('/owner-predecessor-cleanup.mjs'))?'cleanup':c.args[0]==='start'?'start':null).filter(Boolean);
 assert.deepEqual(operations,['stop','cleanup','cleanup','start']);
});
