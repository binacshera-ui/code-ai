// In-memory unit execution of the complete server module with synthetic config,
// router/socket doubles and private scratch storage. Never imports live config.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

test('server preserves profile identity, independent bindings and sanitized disconnect evidence',async()=>{
  const storageRoot=await fs.mkdtemp(path.join(process.env.CODE_AI_TEST_TMP_ROOT||os.tmpdir(),'chrome-identity-unit-'));
  const routes=new Map();
  let failProfileWrite=false;
  const isolatedFs={...fs,writeFile:async(filename,...args)=>{
    if(failProfileWrite && String(filename).includes('/state.json.'))throw Error('Synthetic storage refusal');
    return fs.writeFile(filename,...args);
  }};
  const router={};
  for(const method of ['get','post','delete'])router[method]=(url,...handlers)=>routes.set(`${method} ${url}`,handlers.at(-1));
  const context=vm.createContext({console,Buffer,process:{env:{}},setTimeout,clearTimeout,setInterval,clearInterval,URL,Date});
  class Socket {
    static OPEN=1; readyState=1; handlers={};
    on(name,fn){(this.handlers[name]||=[]).push(fn);}
    once(name,fn){this.on(name,fn);}
    sent=[];
    send(value){this.sent.push(JSON.parse(value));} close(code=1000){this.readyState=3;this.emit('close',code,Buffer.from('synthetic-private-reason'));}
    emit(name,...args){for(const fn of this.handlers[name]||[])fn(...args);}
  }
  const synthetic=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context});
  const builtins={crypto:synthetic({createHash:crypto.createHash,createHmac:crypto.createHmac,randomBytes:crypto.randomBytes,randomUUID:crypto.randomUUID,timingSafeEqual:crypto.timingSafeEqual}),
    fs:synthetic({promises:isolatedFs}),path:synthetic({default:path}),express:synthetic({default:{Router:()=>router}}),ws:synthetic({WebSocket:Socket,WebSocketServer:class{}}),
    './config.js':synthetic({CODEX_APP_CONFIG:{storageRoot,sessionSecret:'synthetic-config-only',trustedPersonalChromeExtensionIds:[]}}),
    './personalPortForwardBroker.js':synthetic({closePersonalPortForward(){throw Error('ports outside unit scope');},listPersonalPortForwards:async()=>[],openPersonalPortForward(){throw Error('ports outside unit scope');}})};
  const protocol=new vm.SourceTextModule(stripTypeScriptTypes(await fs.readFile('server/personalChromeProtocol.ts','utf8')),{context});
  const identity=new vm.SourceTextModule(await fs.readFile('chrome-extension/profileIdentity.js','utf8'),{context});
  const sync=new vm.SourceTextModule(await fs.readFile('chrome-extension/profileSync.js','utf8'),{context});
  await sync.link(specifier=>{assert.equal(specifier,'./profileIdentity.js');return identity;});
  const source=stripTypeScriptTypes(await fs.readFile('server/personalChromeBridge.ts','utf8'));
  const module=new vm.SourceTextModule(source+'\nglobalThis.contract={authenticateSocket,handleSocketEnvelope,handleSocketConnection,normalizeDevice,publicDevice,flush:async()=>{await profileMutationTail.catch(()=>undefined);await persistTail;await auditTail}};',{context});
  await module.link(specifier=>{
    if(specifier==='./personalChromeProtocol.js')return protocol;
    if(specifier==='../chrome-extension/profileIdentity.js')return identity;
    if(specifier==='../chrome-extension/profileSync.js')return sync;
    assert.ok(builtins[specifier],`unexpected live dependency ${specifier}`);return builtins[specifier];
  });
  await module.evaluate();
  module.namespace.createPersonalChromeBridgeRouter((_req,_res,next)=>next());
  async function request(method,url,body={},options={}){
    let payload,status=200;
    const req={body,headers:options.headers||{},query:{},params:options.params||{},codexAuth:{user:{id:options.owner||'synthetic-user'}},ip:'127.0.0.1',socket:{remoteAddress:'127.0.0.1'},protocol:'http',get:()=> 'fixture.invalid'};
    const res={json:value=>{payload=value;},status:value=>{status=value;return res;},setHeader(){}};
    await routes.get(`${method} ${url}`)(req,res);
    assert.equal(status,options.status||200,'synthetic router status');return payload;
  }
  const pairing=await request('post','/pairing/start');
  const paired=await request('post','/pairing/claim',{code:pairing.code,deviceName:'Synthetic Chrome'},{status:201});
  const ws=new Socket();
  const auth={type:'auth',version:1,deviceId:paired.deviceId,token:paired.deviceToken,profileIdentity:{name:'פרופיל מקומי',source:'chrome-local',avatarDataUrl:'data:image/png;base64,aGVsbG8='}};
  const connection=await context.contract.authenticateSocket(ws,Buffer.from(JSON.stringify(auth)));
  assert.ok(connection);
  const a=await request('post','/bindings',{deviceId:paired.deviceId,profileId:'synthetic-profile',sessionKey:'A'},{status:201});
  const b=await request('post','/bindings',{deviceId:paired.deviceId,profileId:'synthetic-profile',sessionKey:'B'},{status:201});
  assert.notEqual(a.binding.id,b.binding.id);
  context.contract.handleSocketEnvelope(connection,Buffer.from(JSON.stringify({type:'event',version:1,name:'profile_identity',payload:{name:'שם חדש',avatarDataUrl:'https://tracker.invalid/avatar'}})));
  await context.contract.flush();
  const devices=await request('get','/devices');
  assert.equal(devices.devices[0].name,'שם חדש');assert.equal(devices.devices[0].profileIdentity.avatarDataUrl,null);
  assert.equal(devices.devices[0].connectionType,'chrome-extension');
  const profileRoute='/devices/:deviceId/profile';
  const params={deviceId:paired.deviceId};
  const phone=await request('post',profileRoute,{baseRevision:devices.devices[0].profileRevision,profileIdentity:{name:'שם מהטלפון'}},{params});
  assert.equal(phone.saved,true);assert.equal(phone.device.name,'שם מהטלפון');
  assert.equal(ws.sent.at(-1).type,'profile_updated');
  assert.equal(ws.sent.at(-1).profileRevision,phone.device.profileRevision);
  const conflict=await request('post',profileRoute,{baseRevision:0,profileIdentity:{name:'stale'}},{params,status:409});
  assert.equal(conflict.code,'PROFILE_CONFLICT');assert.equal(conflict.device.name,'שם מהטלפון');
  await request('post',profileRoute,{baseRevision:phone.device.profileRevision,profileIdentity:{name:'wrong owner'}},{params,owner:'another-synthetic-owner',status:404});
  await request('post',profileRoute,{baseRevision:phone.device.profileRevision,profileIdentity:{name:'wrong device'}},{params,headers:{'x-code-ai-extension-device':'another-device'},status:403});
  failProfileWrite=true;
  const refusal=await request('post',profileRoute,{baseRevision:phone.device.profileRevision,profileIdentity:{name:'must not appear saved'}},{params,status:500});
  assert.equal(refusal.code,'PROFILE_STORAGE_FAILED');
  assert.equal((await request('get','/devices')).devices[0].name,'שם מהטלפון');
  failProfileWrite=false;
  const retry=await request('post',profileRoute,{baseRevision:phone.device.profileRevision,profileIdentity:{name:'שמור אחרי שגיאה'}},{params});
  assert.equal(retry.device.profileRevision,phone.device.profileRevision+1,'a failed write does not consume a revision');
  const edit1=request('post',profileRoute,{baseRevision:retry.device.profileRevision,profileIdentity:{name:'winner'}},{params});
  const edit2=request('post',profileRoute,{baseRevision:retry.device.profileRevision,profileIdentity:{name:'loser'}},{params,status:409});
  const [winner,loser]=await Promise.all([edit1,edit2]);
  assert.equal(winner.device.name,'winner');assert.equal(loser.device.name,'winner');
  const state=JSON.parse(await fs.readFile(path.join(storageRoot,'local/personal-chrome-bridge/state.json'),'utf8'));
  assert.equal(state.bindings.filter(b=>!b.revokedAt).length,2);
  const restored=context.contract.normalizeDevice(state.devices[0]);
  assert.equal(context.contract.publicDevice(restored).profileIdentity.name,'winner','identity survives persistence normalization');
  const replacement=new Socket();context.contract.handleSocketConnection(replacement);
  replacement.emit('message',Buffer.from(JSON.stringify(auth)));
  await new Promise(resolve=>setTimeout(resolve,30));await context.contract.flush();
  assert.equal(replacement.sent.find(message=>message.type==='auth_ok').profileIdentity.name,'winner','stale extension reconnect cannot replace a phone edit');
  replacement.close(1006);await context.contract.flush();
  const offline=await request('post',profileRoute,{baseRevision:winner.device.profileRevision,profileIdentity:{name:'נערך כשהתוסף סגור'}},{params});
  assert.equal(offline.device.online,false);assert.equal(offline.device.name,'נערך כשהתוסף סגור');
  const auditText=await fs.readFile(path.join(storageRoot,'local/personal-chrome-bridge/audit.jsonl'),'utf8');
  const disconnected=auditText.trim().split('\n').map(l=>JSON.parse(l)).find(e=>e.event==='device_disconnected');
  assert.equal(disconnected.closeCode,1006);assert.equal(typeof disconnected.heartbeatAgeMs,'number');
  assert.equal(auditText.includes('synthetic-private-reason'),false);
  assert.equal(auditText.includes(paired.deviceToken),false);
  // Preserve the tiny isolated fixture as evidence, rather than deleting history.
});
