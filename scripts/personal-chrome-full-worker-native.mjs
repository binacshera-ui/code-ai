// Real Chrome, complete worker, synthetic loopback control plane, separate profile.
// Never attaches to the user's Chrome or imports their extension storage.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createHash,randomUUID,randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { WebSocketServer } from 'ws';
const [browserPath,candidatePath,scratch]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert.ok(browserPath&&candidatePath&&scratch);
await fs.mkdir(scratch);
const fixture=path.join(scratch,'extension');
await fs.cp(candidatePath,fixture,{recursive:true,verbatimSymlinks:true});
await fs.writeFile(path.join(fixture,'fixture.html'),'<!doctype html><title>Isolated complete worker qualification</title><p>Synthetic fixture only.</p>');
const token=randomBytes(32).toString('hex');
const deviceId=randomUUID();
let currentSocket,connections=0,heartbeats=0;
let phase='launch';
const requests={pairing:0,session:0,workspace:0,other:0};
function progress(next){phase=next;console.log(JSON.stringify({nativeFixturePhase:phase}));}
const pending=new Map();
const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url.startsWith('/api/codex/browser-extension/pairing/claim')){requests.pairing++;res.end(JSON.stringify({deviceId,deviceToken:token,device:{name:'Synthetic Chrome'}}));}
  else if(req.url.startsWith('/api/codex/session-personal-chrome-mode')){
    requests.session++;
    const url=new URL(req.url,'http://fixture');const session=url.searchParams.get('sessionKey');
    res.end(JSON.stringify({personalChromeMode:{enabled:true,deviceId,bindingId:'synthetic-'+session,approvalPolicy:'never'}}));
  } else if(req.url.startsWith('/workspace-')) {requests.workspace++;res.setHeader('content-type','text/html');res.end('<!doctype html><title>Isolated workspace</title><p>Synthetic fixture only</p>');}
  else {requests.other++;res.statusCode=404;res.end('{}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const sockets=new WebSocketServer({server,maxPayload:1024*1024});
sockets.on('connection',ws=>{
  connections++;currentSocket=ws;
  const ping=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'ping',version:1,sentAt:new Date().toISOString()}));},10000);
  ws.on('close',()=>clearInterval(ping));
  ws.on('message',raw=>{
    const value=JSON.parse(raw.toString());
    if(value.type==='auth') {assert.equal(value.token,token);ws.send(JSON.stringify({type:'auth_ok',version:1,deviceId,connectedAt:new Date().toISOString()}));}
    else if(value.type==='event'&&value.name==='heartbeat')heartbeats++;
    else if(value.type==='result'){const waiter=pending.get(value.commandId);if(waiter){clearTimeout(waiter.timer);pending.delete(value.commandId);waiter.resolve(value);}}
  });
});
class Pipe extends EventEmitter {
  constructor(child){super();this.child=child;let buffer='';child.stdio[4].setEncoding('utf8');child.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const data=buffer.slice(0,end);buffer=buffer.slice(end+1);if(data)this.emit('message',{data});}});child.once('exit',()=>this.emit('close'));}
  addEventListener(name,fn){this.on(name,fn);}
  send(data){this.child.stdio[3].write(data+'\0');}
  close(){this.child.stdio[3].destroy();this.child.stdio[4].destroy();}
}
class Cdp {
  constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();socket.on('message',event=>{const data=JSON.parse(event.data);const waiter=this.pending.get(data.id);if(!waiter)return;this.pending.delete(data.id);clearTimeout(waiter.timer);data.error?waiter.reject(new Error('Isolated CDP operation rejected')):waiter.resolve(data.result);});}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Isolated CDP operation timed out: '+method));},30000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));});}
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,label){for(let i=0;i<100;i++){const value=await read();if(predicate(value))return value;await pause(100);}throw new Error('Isolated qualification timeout: '+label);}
// The fixture is loopback-only; do not inherit an enterprise proxy or prompt
// for local-network permission in a headless disposable test profile.
const child=spawn(browserPath,['--headless=new','--disable-gpu','--no-proxy-server','--disable-features=LocalNetworkAccessChecks','--no-first-run','--no-default-browser-check','--remote-debugging-pipe','--enable-unsafe-extension-debugging',`--user-data-dir=${path.join(scratch,'isolated-profile')}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','ignore','pipe','pipe']});
const cdp=new Cdp(new Pipe(child));
try {
  const browser=await cdp.send('Browser.getVersion');progress('load-complete-worker');
  const {id:extensionId}=await cdp.send('Extensions.loadUnpacked',{path:fixture});
  await until(()=>cdp.send('Target.getTargets'),v=>v.targetInfos.some(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extensionId}/background.js`),'complete worker');
  const pages=[];
  for(let i=0;i<3;i++){
    progress('fixture-page-'+i);
    const url=i===0?`chrome-extension://${extensionId}/fixture.html`:`${origin}/workspace-${i}`;
    const {targetId}=await cdp.send('Target.createTarget',{url});
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
    await cdp.send('Runtime.enable',{},sessionId);
    await cdp.send('Page.enable',{},sessionId);
    // Activate only a page in this separate headless fixture, never user Chrome.
    await cdp.send('Target.activateTarget',{targetId});
    const evaluate=async expression=>{const value=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);assert.ok(!value.exceptionDetails,'Isolated fixture evaluation');return value.result.value;};
    let documentState;
    try {
      await until(async()=>documentState=await evaluate(`({expectedURL:location.href===${JSON.stringify(url)},readyState:document.readyState,protocol:location.protocol,errorCode:document.body?.innerText?.match(/\\bERR_[A-Z_]+\\b/)?.[0]||null})`),v=>v.expectedURL&&v.readyState==='complete','fixture document loaded');
    } catch(error) {console.log(JSON.stringify({fixtureDocumentState:documentState||null}));throw error;}
    if(i===0)await until(()=>evaluate('!!globalThis.chrome?.tabs?.getCurrent'),v=>v===true,'fixture extension API');
    const tabId=await until(()=>pages.length?pages[0].evaluate(`chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(url)})?.id)`):evaluate('new Promise(resolve=>chrome.tabs.getCurrent(tab=>resolve(tab?.id)))'),Number.isInteger,'fixture tab');
    pages.push({targetId,tabId,evaluate});
  }
  const send=message=>pages[0].evaluate(`new Promise(resolve=>chrome.runtime.sendMessage(${JSON.stringify(message)},resolve))`);
  progress('loopback-fetch');
  const reachable=await pages[0].evaluate(`fetch(${JSON.stringify(origin+'/api/codex/browser-extension/pairing/claim')},{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)}).then(r=>({ok:r.ok,status:r.status})).catch(()=>({ok:false}))`);
  assert.equal(reachable.ok,true,'Isolated loopback control plane is reachable');
  progress('pair-complete-worker');
  const paired=await send({type:'PAIR_DEVICE',controlOrigin:origin,code:'synthetic',deviceName:'Synthetic'});
  if(!paired.ok) {
    const message=String(paired.error||'');
    console.log(JSON.stringify({fixturePairingFailed:true,knownBrowserError:['Illegal invocation','Failed to fetch'].find(value=>message===value)||null,categories:['fetch','rule','domain','header','url','undefined','storage','port','device','permission'].filter(word=>message.toLowerCase().includes(word)),errorLength:message.length}));
  }
  assert.equal(paired.ok,true);
  progress('background-connected');
  await until(()=>send({type:'PANEL_GET_STATE'}),v=>v.connected===true,'background connection');
  assert.equal(connections,1);
  async function command(toolName,args,session){
    const commandId=randomUUID();
    const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(commandId);reject(new Error('Native worker command timeout: '+toolName));},10000);pending.set(commandId,{resolve,reject,timer});});
    currentSocket.send(JSON.stringify({type:'command',version:1,commandId,toolName,arguments:args,session,deadlineAt:new Date(Date.now()+15000).toISOString()}));
    const response=await result;assert.equal(response.ok,true,'Native worker command must succeed: '+toolName+' ['+(response.error?.code||'no-code')+']');return response.result;
  }
  const session=key=>({serverId:'local',profileId:'synthetic',sessionKey:key,bindingId:'synthetic-'+key});
  progress('separate-conversation-workspaces');
  await command('browser_workspace',{action:'attach',tabId:pages[1].tabId},session('A'));
  await command('browser_workspace',{action:'attach',tabId:pages[2].tabId},session('B'));
  const [a,b]=await Promise.all(['A','B'].map(key=>command('browser_tabs',{scope:'workspace'},session(key))));
  assert.equal(a.tabs[0].id,pages[1].tabId);assert.equal(b.tabs[0].id,pages[2].tabId);
  for(const key of ['A','B','A'])assert.equal((await send({type:'SYNC_ACTIVE_SESSION',context:{authenticated:true,deviceUnlocked:true,provider:'codex',serverId:'local',profileId:'synthetic',sessionKey:key}})).ok,true);
  assert.equal(connections,1,'Conversation switching cannot replace the profile connection');
  assert.equal((await command('browser_tabs',{scope:'workspace'},session('A'))).tabs[0].id,pages[1].tabId);
  // No panel is ever opened. Exercise Chrome's real worker-idle boundary.
  progress('idle-without-panel');
  await pause(65000);
  assert.equal((await command('browser_status',{},session('B'))).online,true);
  assert.equal(connections,1);assert.ok(heartbeats>=3);
  currentSocket.terminate();
  progress('network-reconnect');
  await until(()=>send({type:'PANEL_GET_STATE'}),v=>v.connected&&connections===2,'network reconnect');
  assert.equal((await command('browser_tabs',{scope:'workspace'},session('A'))).tabs[0].id,pages[1].tabId);
  assert.equal((await send({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'פרופיל בדיקה',source:'custom'}})).ok,true);
  assert.equal((await command('browser_status',{},session('B'))).deviceName,'פרופיל בדיקה');
  progress('passed');
  const moduleHashes=Object.fromEntries(await Promise.all(['background.js','bridgeTransport.js','profileIdentity.js','panelOpen.js','selectionAccess.js','manifest.json'].map(async file=>[file,createHash('sha256').update(await fs.readFile(path.join(candidatePath,file))).digest('hex')])));
  const result={ok:true,browser:browser.product,fullWorker:true,isolatedProfile:true,syntheticAuthenticationOnly:true,panelOpened:false,conversations:2,workspacesPreserved:true,idleSeconds:65,heartbeats,reconnected:true,profileIdentity:true,moduleHashes,backgroundSha256:moduleHashes['background.js']};
  await fs.writeFile(path.join(scratch,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} catch(error) {
  console.log(JSON.stringify({nativeFixtureFailed:true,phase,requests,errorName:error.name,categories:['fetch','rule','domain','storage','timeout','evaluation','reachable'].filter(word=>String(error.message).toLowerCase().includes(word))}));
  throw error;
} finally {
  await cdp.send('Browser.close').catch(()=>{});cdp.socket.close();if(child.exitCode===null)child.kill();
  for(const ws of sockets.clients)ws.terminate();await new Promise(resolve=>sockets.close(resolve));await new Promise(resolve=>server.close(resolve));
}
