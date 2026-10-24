import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const ops='/root/projects/code-ai/ops/owner-repair-20261016';
const privateDir='/root/.code-ai/maintenance/owner-repair-20261016/main';
const binary='/opt/code-ai-tools/codex-0.162.1-628e35487d88/package/vendor/x86_64-unknown-linux-musl/bin/codex';
const pm2=createRequire(ops+'/repair-main.mjs')('/root/.nvm/versions/node/v24.12.0/lib/node_modules/pm2');
const invoke=(method,...args)=>new Promise((resolve,reject)=>pm2[method](...args,(e,r)=>e?reject(e):resolve(r)));
const report={host:'main',startedAt:new Date().toISOString(),phase:'preparing'};let originalEnv,stopped=false;
async function save(){await fs.writeFile(ops+'/repair-main-receipt.json',JSON.stringify(report,null,2)+'\n',{mode:0o600})}
try{
 await fs.mkdir(privateDir,{recursive:true,mode:0o700});await invoke('connect');
 const app=(await invoke('list')).find(x=>x.name==='code-ai-app');assert.equal(app.pm2_env.status,'online');
 originalEnv=Object.fromEntries((await fs.readFile('/proc/'+app.pid+'/environ','utf8')).split('\0').filter(Boolean).map(s=>{const n=s.indexOf('=');return[s.slice(0,n),s.slice(n+1)]}));
 const queue='/root/projects/code-ai/.code-ai/queue/state.json';
 const before=JSON.parse(await fs.readFile(queue,'utf8'));report.queueBefore=Object.fromEntries([...new Set(before.items.map(x=>x.status))].map(s=>[s,before.items.filter(x=>x.status===s).length]));
 await fs.copyFile(queue,privateDir+'/queue-before.json');await fs.chmod(privateDir+'/queue-before.json',0o600);
 try{await fs.copyFile('/root/.pm2/dump.pm2',privateDir+'/pm2-dump-before.json');await fs.chmod(privateDir+'/pm2-dump-before.json',0o600)}catch(e){if(e.code!=='ENOENT')throw e}
 report.phase='stopping-core';await save();await invoke('stop','code-ai-app');stopped=true;
 await fs.copyFile(queue,privateDir+'/queue-after-core-stop.json');await fs.chmod(privateDir+'/queue-after-core-stop.json',0o600);
 report.phase='pinning-owners';await save();
 const owners=execFileSync('/usr/bin/python3',[ops+'/pin-owners.py','main',JSON.stringify({'developer':'/home/developer','developer2':'/home/developer2'})],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});report.ownerReceipt=JSON.parse(owners);
 report.phase='starting-core';await save();
 await invoke('restart',{name:'code-ai-app',updateEnv:true,env:{...originalEnv,CODEX_BIN:binary,CODEX_TERMINAL_BIN:binary}});stopped=false;
 const after=(await invoke('list')).find(x=>x.name==='code-ai-app');assert.equal(after.pm2_env.status,'online');
 const actual=Object.fromEntries((await fs.readFile('/proc/'+after.pid+'/environ','utf8')).split('\0').filter(Boolean).map(s=>{const n=s.indexOf('=');return[s.slice(0,n),s.slice(n+1)]}));
 for(const name of ['CODEX_BIN','CODEX_TERMINAL_BIN'])assert.equal(actual[name],binary);
 const authKeys=Object.keys(originalEnv).filter(k=>/PASSWORD|SECRET|TOKEN|API_KEY|AUTH_BASELINE/.test(k));for(const name of authKeys)assert.equal(actual[name],originalEnv[name]);
 report.authenticationValuesPreserved=true;report.authenticationFieldsCompared=authKeys.length;report.nativeBinary=binary;report.mainPid=after.pid;
 await invoke('dump');report.pm2Saved=true;
 const q=JSON.parse(await fs.readFile(queue,'utf8'));const ids=new Set(q.items.map(x=>x.id));assert.ok(before.items.every(x=>ids.has(x.id)));report.queueItemIdsPreserved=true;report.queueAndSessionBindingsBackup=privateDir;report.phase='recovered-awaiting-acceptance';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify(report));
}catch(e){report.failed=true;report.phaseFailed=report.phase;report.errorType=e.name;await save();if(stopped&&originalEnv){try{await invoke('restart',{name:'code-ai-app',updateEnv:true,env:originalEnv});report.coreRestartedAfterFailure=true;await save()}catch{}}console.error(JSON.stringify({failed:true,phase:report.phase,errorType:e.name}));process.exitCode=1}
finally{pm2.disconnect()}
