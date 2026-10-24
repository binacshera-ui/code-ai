import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {WebSocketServer} from 'ws';
import {probeCanonicalOwner,getCodeAiRuntimeHealth,cachedCanonicalOwnerHealth,invalidateCanonicalOwnerHealth} from './codexRuntimeHealth.mjs';
async function fixture(t,{account={type:'chatgpt'},wrongHome=false,stall=false,rejectRequirements=false,getAccount=null}={}){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-health-'));await fs.mkdir(home+'/code-ai-shared-owner',{mode:0o700});
 const server=http.createServer();const wss=new WebSocketServer({server,perMessageDeflate:false});const methods=[];
 wss.on('connection',w=>w.on('message',b=>{const f=JSON.parse(b.toString());methods.push(f.method);if(!f.id||stall)return;
  let result=f.method==='initialize'?{codexHome:wrongHome?'/nonexistent-health-home':home}:f.method==='account/read'?{account:getAccount?getAccount():account}:{requirements:null};
  w.send(JSON.stringify({id:f.id,...(rejectRequirements&&f.method==='configRequirements/read'?{error:{code:-32603,message:'private-secret-must-not-escape'}}:{result})}));
 }));
 await new Promise(r=>server.listen(home+'/code-ai-shared-owner/owner.sock',r));
 t.after(async()=>{for(const w of wss.clients)w.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true})});
 return{home,methods};
}
test('real RPC health verifies profile, requirements and account without refreshing credentials',async t=>{
 const f=await fixture(t);const r=await probeCanonicalOwner(f.home);assert.equal(r.transportReady,true);assert.equal(r.authenticated,true);
 assert.deepEqual(f.methods.filter(m=>m!=='initialized'),['initialize','configRequirements/read','account/read']);
});
test('an open listener and an auth file are insufficient when RPC stalls',async t=>{
 const f=await fixture(t,{stall:true});const r=await probeCanonicalOwner(f.home,{timeoutMs:50});assert.equal(r.transportReady,false);assert.equal(r.reason,'owner-timeout');
});
test('wrong canonical home fails closed',async t=>{const f=await fixture(t,{wrongHome:true});const r=await probeCanonicalOwner(f.home);assert.equal(r.transportReady,false);assert.equal(r.reason,'owner-home-mismatch')});
test('missing account is separate from transport failure',async t=>{const f=await fixture(t,{account:null});const r=await probeCanonicalOwner(f.home);assert.equal(r.transportReady,true);assert.equal(r.authenticated,false);assert.equal(r.reason,'authentication-required')});
test('native errors never leak private details',async t=>{const f=await fixture(t,{rejectRequirements:true});const r=await probeCanonicalOwner(f.home);assert.equal(r.reason,'native-rejected');assert.equal(JSON.stringify(r).includes('private-secret'),false)});
test('unreachable owner is unhealthy even if directory exists',async()=>{const r=await probeCanonicalOwner('/nonexistent-code-ai-health');assert.equal(r.transportReady,false)});
test('release metadata is reported and unsupported source profiles fail explicitly',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-build-health-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.writeFile(home+'/release.json',JSON.stringify({version:'test-release',expectedCodexVersion:'0.162.1'}));
 const r=await getCodeAiRuntimeHealth([{id:'gemini',label:'Gemini',provider:'gemini'},{id:'support-missing',sourceProfileId:'missing',provider:'codex'}],{appRoot:home,environment:{}});
 assert.equal(r.version,'test-release');assert.equal(r.profiles[1].reason,'source-profile-unavailable');
});

test('logout and login are immediately visible while concurrent probes still coalesce',async t=>{
 let account={type:'chatgpt'};const f=await fixture(t,{getAccount:()=>account});
 const [a,b]=await Promise.all([cachedCanonicalOwnerHealth(f.home),cachedCanonicalOwnerHealth(f.home)]);
 assert.equal(a.authenticated,true);assert.deepEqual(a,b);assert.equal(f.methods.filter(m=>m==='initialize').length,1);
 account=null;assert.equal((await cachedCanonicalOwnerHealth(f.home)).authenticated,false);assert.equal(f.methods.filter(m=>m==='initialize').length,2);
 account={type:'chatgpt'};assert.equal((await cachedCanonicalOwnerHealth(f.home)).authenticated,true);assert.equal(f.methods.filter(m=>m==='initialize').length,3);
});
