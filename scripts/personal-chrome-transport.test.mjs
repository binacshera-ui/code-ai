import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext, SourceTextModule } from 'node:vm';
import { createBridgeTransport } from '../chrome-extension/bridgeTransport.js';
import { normalizeProfileIdentity } from '../chrome-extension/profileIdentity.js';

function harness() {
  let time = 1_000;
  let nextId = 0;
  const jobs = new Map();
  const sockets = [];
  const messages = [];
  const statuses = [];
  const timers = {
    setTimeout(fn, delay) { const id = ++nextId; jobs.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn, delay) { const id = ++nextId; jobs.set(id, { fn, at: time + delay, interval: delay }); return id; },
    clearInterval(id) { jobs.delete(id); },
  };
  class FakeSocket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 0; listeners = {}; sent = [];
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
    open() { this.readyState = 1; this.emit('open'); }
    message(value) { this.emit('message', { data: JSON.stringify(value) }); }
    send(value) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(value)); }
    close(code) { this.readyState = 3; this.emit('close', { code, wasClean: code === 1000 }); }
    authenticate() { this.open(); this.message({ type: 'auth_ok' }); }
  }
  const transport = createBridgeTransport({
    getUrl: () => 'wss://fixture.invalid/socket',
    getAuth: () => ({ type: 'auth', token: 'synthetic-test-only' }),
    onMessage: value => messages.push(value), onStatus: online => statuses.push(online),
    WebSocketClass: FakeSocket, now: () => time, timers,
  });
  function advance(delta) {
    const end = time + delta;
    for (;;) {
      const candidate = [...jobs].filter(([, job]) => job.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      if (!candidate) break;
      const [id, job] = candidate; time = job.at;
      if (job.interval) job.at += job.interval; else jobs.delete(id);
      job.fn();
    }
    time = end;
  }
  return { transport, sockets, messages, statuses, advance, jobs };
}

test('one background socket serves simultaneous conversations without a panel', () => {
  const h = harness(); h.transport.start(); h.sockets[0].authenticate();
  for (let index=0;index<50;index++) h.transport.start();
  const commands = ['A','B','A'].map(sessionKey => ({ type:'command', session:{sessionKey} }));
  for (const command of commands) h.sockets[0].message(command);
  assert.equal(h.sockets.length,1);
  assert.deepEqual(h.messages.filter(m=>m.type==='command'), commands);
  h.advance(20_000);
  assert.equal(h.sockets[0].sent.at(-1).name,'heartbeat');
  assert.equal(h.transport.snapshot().connected,true);
});
test('connecting and authentication black holes recover within bounded deadlines', () => {
  const h=harness(); h.transport.start(); h.advance(15_000);
  assert.equal(h.transport.snapshot().events.at(-1).kind,'connect_timeout');
  h.advance(1000); assert.equal(h.sockets.length,2); h.sockets[1].open();
  h.advance(10_000); assert.equal(h.transport.snapshot().events.at(-1).kind,'auth_timeout');
  h.advance(2000); assert.equal(h.sockets.length,3); h.sockets[2].authenticate();
  assert.equal(h.transport.snapshot().reconnectAttempt,0);
});
test('a half-open channel is retired even if readyState remains OPEN', () => {
  const h=harness(); h.transport.start(); h.sockets[0].authenticate();
  h.advance(80_000);
  assert.equal(h.transport.snapshot().connected,false);
  assert.equal(h.transport.snapshot().events.at(-1).kind,'heartbeat_timeout');
  h.advance(1000); h.sockets[1].authenticate();
  assert.equal(h.transport.snapshot().connected,true);
});
test('stale callbacks cannot close a successor; sent commands are never replayed', () => {
  const h=harness(); h.transport.start(); const old=h.sockets[0]; old.authenticate();
  h.transport.send({type:'result',commandId:'synthetic-1',ok:true});
  old.close(1006); h.advance(1000); const next=h.sockets[1]; next.authenticate();
  old.emit('close',{code:1006}); old.emit('error'); old.message({type:'command',commandId:'stale'});
  assert.equal(h.transport.snapshot().connected,true);
  assert.equal(next.sent.some(m=>m.commandId==='synthetic-1'),false);
  assert.equal(h.messages.some(m=>m.commandId==='stale'),false);
});
test('explicit stop and server revocation do not reconnect or leave timers running', () => {
  const h=harness(); h.transport.start(); h.sockets[0].authenticate(); h.transport.stop('unpaired');
  h.advance(100_000); h.transport.wake(); assert.equal(h.sockets.length,1); assert.equal(h.jobs.size,0);
  h.transport.start(); h.sockets[1].authenticate(); h.sockets[1].close(4004);
  h.advance(100_000); h.transport.wake(); assert.equal(h.sockets.length,2);
});
test('diagnostics contain metadata only, never authentication or close-reason contents', () => {
  const h=harness(); h.transport.start(); h.sockets[0].authenticate();
  h.sockets[0].emit('close',{code:1006,reason:'synthetic-private-value'});
  const output=JSON.stringify(h.transport.snapshot());
  assert.equal(output.includes('synthetic-test-only'),false);
  assert.equal(output.includes('synthetic-private-value'),false);
});
test('profile identities allow bounded raster data only and never remote tracking/SVG', () => {
  assert.deepEqual(normalizeProfileIdentity({name:'  פרופיל שלי\u0000  ',source:'chrome-local',avatarDataUrl:'data:image/png;base64,aGVsbG8='}),
    {name:'פרופיל שלי',source:'chrome-local',avatarDataUrl:'data:image/png;base64,aGVsbG8='});
  for(const value of ['https://tracker.invalid/picture','data:image/svg+xml;base64,aGVsbG8=','data:image/png;base64,'+'A'.repeat(80_000)])
    assert.equal(normalizeProfileIdentity({avatarDataUrl:value}).avatarDataUrl,null);
  assert.equal(normalizeProfileIdentity({name:'a'.repeat(200)}).name.length,120);
});

test('default timers preserve the browser global receiver required by native Chrome', async () => {
  let realm;
  let sequence=0;
  const calls=[];
  const method=name=>function () {
    assert.equal(this,realm,'Native browser timers require the global receiver');
    calls.push(name);
    return ++sequence;
  };
  class Socket {
    static OPEN=1;static CLOSING=2;
    readyState=0;listeners={};
    constructor(){Socket.instance=this;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    send(){}
    close(){this.readyState=3;this.listeners.close?.({code:1000});}
  }
  const context=createContext({WebSocket:Socket,setTimeout:method('setTimeout'),clearTimeout:method('clearTimeout'),setInterval:method('setInterval'),clearInterval:method('clearInterval')});
  realm=runInContext('globalThis',context);
  const module=new SourceTextModule(await readFile(new URL('../chrome-extension/bridgeTransport.js',import.meta.url),'utf8'),{context});
  await module.link(()=>{throw new Error('Transport has no module dependencies');});await module.evaluate();
  const transport=module.namespace.createBridgeTransport({getUrl:()=> 'wss://synthetic.invalid/socket',getAuth:()=>({type:'auth'}),onMessage:()=>{},onStatus:()=>{}});
  assert.doesNotThrow(()=>transport.start());
  Socket.instance.readyState=1;Socket.instance.listeners.open();
  Socket.instance.listeners.message({data:JSON.stringify({type:'auth_ok'})});
  assert.doesNotThrow(()=>transport.stop());
  for(const name of ['setTimeout','clearTimeout','setInterval','clearInterval'])assert.ok(calls.includes(name));
});
