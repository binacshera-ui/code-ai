import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
test('reconnect waits for cancellation and logout, and duplicate disconnects share one operation',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'code-ai-auth-cycle-'));const home=path.join(root,'.codex');await mkdir(home);const events=path.join(root,'events');const executable=path.join(root,'fake-codex');
 await writeFile(executable,'#!'+process.execPath+String.fromCharCode(10)+[
  "const fs=require('node:fs');const event=name=>fs.appendFileSync(process.env.TEST_AUTH_EVENTS,name+String.fromCharCode(10));const action=process.argv[2];event(action+'-start');",
  "if(action==='logout'){setTimeout(()=>{event('logout-finished');process.exit(0)},150)}else{console.log('Open https://auth.openai.com/codex/device');console.log('Enter this one-time code: TEST-1234');setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{event('login-cancelled');process.exit(0)},100))}"
 ].join(String.fromCharCode(10)),{mode:0o700});
 process.env.CODEX_BIN=executable;process.env.TEST_AUTH_EVENTS=events;
 const api=await import('./codexAccountAuth.js');const profile={id:'synthetic-auth-cycle',codexHome:home};
 t.after(async()=>{await api.disconnectCodexAccount(profile).catch(()=>{});await rm(root,{recursive:true,force:true})});
 await api.startCodexDeviceAuth(profile);const until=Date.now()+5000;while(api.getCodexDeviceAuthStatus(profile).state!=='waiting'){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,10))}
 const first=api.disconnectCodexAccount(profile),duplicate=api.disconnectCodexAccount(profile);const reconnect=api.startCodexDeviceAuth(profile);await Promise.all([first,duplicate]);const fresh=await reconnect;assert.equal(fresh.state,'starting');
 const deadline=Date.now()+5000;let lines:string[]=[];while(Date.now()<deadline){lines=(await readFile(events,'utf8')).trim().split('\n');if(lines.filter(x=>x==='login-start').length===2)break;await new Promise(r=>setTimeout(r,10))}
 assert.deepEqual(lines.slice(0,5),['login-start','login-cancelled','logout-start','logout-finished','login-start']);assert.equal(lines.filter(x=>x==='logout-start').length,1);
});
