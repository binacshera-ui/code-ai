// Source-only contract tests. Load the entire service worker and its real
// modules, with synthetic storage and explicit Chrome API doubles. These are
// not a substitute for a native toolbar test in the affected Chrome profile.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../chrome-extension');
const anchorKey = 'codeAiPersonalChromePanelAnchorV1';

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map(listener => listener(...args)); },
    get listenerCount() { return listeners.length; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fullWorker({ sessionValues = {}, anchorRead, initialLocalValues = {}, queryGate,
  fetchImpl, WebSocketClass } = {}) {
  const localValues = { ...initialLocalValues };
  const options = new Map();
  const calls = [];
  const errors = [];
  const outgoingMessages = [];
  let gesture = false;
  const tabs = [12, 15].map(id => ({ id, windowId: 7, groupId: -1, active: id === 12, url: 'https://fixture.invalid/' }));
  const storageArea = (values, session = false) => ({
    async get(key) {
      if (session && key === anchorKey && anchorRead) return anchorRead.promise;
      return { [key]: values[key] };
    },
    async set(next) { Object.assign(values, next); },
    async remove(key) { delete values[key]; },
  });
  const chrome = {
    storage: { local: storageArea(localValues), session: storageArea(sessionValues, true) },
    runtime: {
      id: 'synthetic-extension-id', onMessage: event(), onInstalled: event(),
      async sendMessage(message) { outgoingMessages.push(message.type); },
    },
    debugger: { onEvent: event(), onDetach: event() },
    tabs: {
      onRemoved: event(), onActivated: event(), onCreated: event(), onUpdated: event(), onMoved: event(),
      async query() { if (queryGate) await queryGate.promise; return tabs; },
      async get(id) {
        const tab = tabs.find(value => value.id === id);
        if (!tab) throw new Error('Synthetic tab does not exist');
        return tab;
      },
    },
    alarms: { onAlarm: event(), async create() {} },
    action: { onClicked: event(), async setBadgeText() {}, async setTitle() {} },
    notifications: { onClicked: event() },
    declarativeNetRequest: {
      async updateDynamicRules(value) {
        // No live credentials are loaded and no rules are installed anywhere.
        assert.ok(!value.addRules?.length || initialLocalValues.codeAiPersonalChromeSettings?.deviceToken === 'synthetic-token');
        calls.push(['rules', value.removeRuleIds?.length || 0]);
      },
    },
    sidePanel: {
      onOpened: event(),
      setOptions(value) {
        const key = value.tabId ?? 'global';
        options.set(key, { ...options.get(key), ...value });
        calls.push(['options', key, value.enabled]);
        return Promise.resolve();
      },
      async setPanelBehavior(value) { calls.push(['behavior', value.openPanelOnActionClick]); },
      open(value) {
        assert.equal(gesture, true, 'the full worker must request opening inside the click');
        assert.equal(options.get(value.tabId)?.enabled, true);
        calls.push(['open', value.tabId]);
        return Promise.resolve();
      },
    },
  };
  const context = vm.createContext({
    chrome, crypto: webcrypto, URL, Headers, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { platform: 'synthetic', userAgent: 'synthetic-browser' },
    console: { error: () => { errors.push('worker-error'); } },
    fetch: fetchImpl || (() => { throw new Error('Source-only test must not make network requests'); }),
    WebSocket: WebSocketClass || class { constructor() { throw new Error('Source-only test must not connect a bridge'); } },
  });
  const modules = new Map();
  async function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    assert.equal(path.dirname(filename), extensionRoot);
    const source = await fs.readFile(filename, 'utf8');
    // Observe readiness without extracting or replacing any worker functions.
    const probe = path.basename(filename) === 'background.js'
      ? '\n globalThis.workerProbe = { ready: settingsReady, connectionReady: transportReady, snapshot: statusSnapshot, syncActiveSession, dispatchCommand, active: () => activeSessionContext, stop: () => transport.stop() };'
      : '';
    const module = new vm.SourceTextModule(source + probe, { context, identifier: filename });
    modules.set(filename, module);
    return module;
  }
  const worker = await load(path.join(extensionRoot, 'background.js'));
  await worker.link((specifier, referencing) => load(path.resolve(path.dirname(referencing.identifier), specifier)));
  await worker.evaluate();
  return {
    chrome, options, calls, errors, outgoingMessages, sessionValues,
    ready: context.workerProbe.ready,
    connectionReady: context.workerProbe.connectionReady,
    snapshot: () => context.workerProbe.snapshot(),
    sync: value => context.workerProbe.syncActiveSession(value),
    dispatch: (...args) => context.workerProbe.dispatchCommand(...args),
    active: () => context.workerProbe.active(),
    stop: () => context.workerProbe.stop(),
    localValues,
    async click(id) {
      gesture = true;
      try { chrome.action.onClicked.emit({ id, windowId: 7 }); }
      finally { gesture = false; }
      // Complete the asynchronous anchor persistence after the synchronous open.
      await new Promise(resolve => setImmediate(resolve));
    },
    request(message) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Synthetic worker response timeout')), 1000);
        const results = chrome.runtime.onMessage.emit(message, {}, value => {
          clearTimeout(timeout);
          resolve(value);
        });
        assert.ok(results.includes(true), 'the message channel must remain open');
      });
    },
  };
}

const syntheticSettings = { controlOrigin: 'https://fixture.invalid', deviceId: 'synthetic-device', deviceToken: 'synthetic-token' };
class SyntheticSocket {
  static OPEN=1; static CLOSING=2;
  static instances=[];
  readyState=0;
  constructor() { SyntheticSocket.instances.push(this); }
  addEventListener() {}
  close() { this.readyState=3; }
}
class ProfileSocket extends SyntheticSocket {
  listeners={}; sent=[];
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  fire(name,event={}){for(const fn of this.listeners[name]||[])fn(event);}
  send(value){this.sent.push(JSON.parse(value));}
  message(value){this.fire('message',{data:JSON.stringify(value)});}
}
async function authenticateProfile(worker,identity,revision=1) {
  await worker.connectionReady;
  const socket=SyntheticSocket.instances.at(-1);socket.readyState=1;socket.fire('open');
  socket.message({type:'auth_ok',profileSyncSupported:true,profileIdentity:identity,profileRevision:revision});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  return socket;
}
function sessionContext(sessionKey) {
  return { authenticated:true, deviceUnlocked:true, provider:'codex', profileId:'synthetic-profile', sessionKey };
}
function syntheticModeResponse(sessionKey) {
  return { ok:true, headers:new Headers({'content-type':'application/json'}),
    json:async()=>({personalChromeMode:{enabled:true,deviceId:'synthetic-device',bindingId:`binding-${sessionKey}`}}) };
}

test('background connects before slow tab reconciliation and recreates its wakeup alarm', async () => {
  SyntheticSocket.instances=[];
  const gate=deferred();
  const worker=await fullWorker({initialLocalValues:{codeAiPersonalChromeSettings:syntheticSettings},queryGate:gate,WebSocketClass:SyntheticSocket});
  try {
    await worker.connectionReady;
    assert.equal(SyntheticSocket.instances.length,1,'no panel or tab reconciliation is needed to connect');
    assert.equal(worker.chrome.alarms.onAlarm.listenerCount,1);
    gate.resolve(); await worker.ready;
  } finally { worker.stop(); }
});
test('switching conversations preserves the previous workspace and shares its transport', async () => {
  SyntheticSocket.instances=[];
  const worker=await fullWorker({initialLocalValues:{codeAiPersonalChromeSettings:syntheticSettings},WebSocketClass:SyntheticSocket,
    fetchImpl:async url=>syntheticModeResponse(new URL(url).searchParams.get('sessionKey'))});
  // Explicit Chrome group doubles, not extracted/replaced production functions.
  worker.chrome.tabs.group=async()=>10;
  worker.chrome.tabGroups={update:async()=>({})};
  worker.chrome.tabs.get=async id=>({id,windowId:7,groupId:10});
  try {
    await worker.ready;
    const a=await worker.sync(sessionContext('A')); const b=await worker.sync(sessionContext('B'));
    assert.deepEqual(Array.from(a.workspace.tabIds),[12]);
    assert.deepEqual(Array.from(b.workspace.tabIds),[],'changing chat must not steal A’s tab');
    const statusA=await worker.dispatch('browser_workspace',{action:'status'},{profileId:'synthetic-profile',sessionKey:'A',bindingId:'binding-A'});
    assert.deepEqual(Array.from(statusA.workspace.tabIds),[12]);
    assert.equal(worker.active().sessionKey,'B'); assert.equal(SyntheticSocket.instances.length,1);
  } finally { worker.stop(); }
});
test('late conversation synchronization cannot replace the newer panel context', async () => {
  const slow=deferred();
  const worker=await fullWorker({initialLocalValues:{codeAiPersonalChromeSettings:syntheticSettings},WebSocketClass:SyntheticSocket,
    fetchImpl:async url=>{
      const key=new URL(url).searchParams.get('sessionKey');
      if(key==='A')await slow.promise;
      return syntheticModeResponse(key);
    }});
  worker.chrome.tabs.group=async()=>10; worker.chrome.tabGroups={update:async()=>({})};
  try {
    await worker.ready; const a=worker.sync(sessionContext('A'));
    await worker.sync(sessionContext('B')); slow.resolve(); const late=await a;
    assert.equal(late.superseded,true); assert.equal(worker.active().sessionKey,'B');
  } finally { worker.stop(); }
});
test('profile name and raster picture persist locally without a panel or account login', async () => {
  const worker=await fullWorker(); await worker.ready;
  const response=await worker.request({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'פרופיל בדיקה',avatarDataUrl:'data:image/png;base64,aGVsbG8='}});
  assert.equal(response.ok,true); assert.equal(response.deviceName,'פרופיל בדיקה');
  assert.equal(worker.localValues.codeAiChromeProfileIdentityV1.avatarDataUrl,'data:image/png;base64,aGVsbG8=');
});

test('full worker receives a phone edit, acknowledges durable saves and restores them after worker reload',async()=>{
  const worker=await fullWorker({initialLocalValues:{codeAiPersonalChromeSettings:syntheticSettings,codeAiChromeProfileIdentityV1:{name:'old local'}},WebSocketClass:ProfileSocket,
    fetchImpl:async(url,init)=>{
      assert.ok(url.endsWith('/devices/synthetic-device/profile'));
      const edit=JSON.parse(init.body);assert.equal(edit.baseRevision,3);
      return Response.json({saved:true,device:{id:'synthetic-device',profileIdentity:edit.profileIdentity,profileRevision:4}});
    }});
  try{
    await worker.ready;const socket=await authenticateProfile(worker,{name:'מהטלפון'},3);
    assert.equal(worker.snapshot().deviceName,'מהטלפון');
    const saved=await worker.request({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'מהתוסף'}});
    assert.equal(saved.ok,true);assert.equal(saved.profileSyncStatus,'synced');
    socket.message({type:'profile_updated',profileIdentity:{name:'עדכון מהאתר'},profileRevision:5});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(worker.localValues.codeAiChromeProfileIdentityV1.name,'עדכון מהאתר');
    const restored=await fullWorker({initialLocalValues:worker.localValues,WebSocketClass:SyntheticSocket});
    try{await restored.ready;assert.equal(restored.snapshot().deviceName,'עדכון מהאתר');assert.equal(restored.snapshot().profileRevision,5);}finally{restored.stop();}
  }finally{worker.stop();}
});
test('full worker retains a conflicting local edit and retries only after an explicit second save',async()=>{
  let attempts=0;
  const worker=await fullWorker({initialLocalValues:{codeAiPersonalChromeSettings:syntheticSettings},WebSocketClass:ProfileSocket,
    fetchImpl:async(_url,init)=>{
      const edit=JSON.parse(init.body);attempts++;
      return attempts===1
        ? Response.json({device:{profileIdentity:{name:'remote winner'},profileRevision:2}},{status:409})
        : Response.json({saved:true,device:{profileIdentity:edit.profileIdentity,profileRevision:3}});
    }});
  try{
    await worker.ready;const socket=await authenticateProfile(worker,{name:'original'},1);
    const conflict=await worker.request({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'my draft'}});
    assert.equal(conflict.ok,false);assert.equal(conflict.profileSyncStatus,'conflict');
    assert.equal(worker.localValues.codeAiChromeProfileIdentityV1.name,'my draft');
    socket.message({type:'ping'});await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
    const saved=await worker.request({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'my draft'}});
    assert.equal(saved.ok,true);assert.equal(saved.profileSyncStatus,'synced');assert.equal(attempts,2);
  }finally{worker.stop();}
});
test('offline profile drafts survive worker shutdown and resume without being discarded',async()=>{
  const first=await fullWorker();await first.ready;
  await first.request({type:'PANEL_SAVE_PROFILE',profileIdentity:{name:'offline preserved'}});
  const restored=await fullWorker({initialLocalValues:first.localValues});await restored.ready;
  assert.equal(restored.snapshot().deviceName,'offline preserved');
  assert.equal(restored.localValues.codeAiChromeProfileSyncV1.pendingIdentity.name,'offline preserved');
});

test('complete unpaired worker links imports, registers the toolbar, and serves its real panel protocol', async () => {
  const worker = await fullWorker();
  await worker.ready;
  assert.equal(worker.chrome.action.onClicked.listenerCount, 1);
  assert.equal(worker.chrome.runtime.onMessage.listenerCount, 1);
  assert.equal(worker.snapshot().paired, false);
  assert.equal(worker.snapshot().connected, false);
  const configured = await worker.request({ type: 'PANEL_CONFIGURE_ORIGIN', controlOrigin: 'https://fixture.invalid' });
  assert.equal(configured.ok, true);
  const response = await worker.request({ type: 'PANEL_GET_STATE' });
  assert.notEqual(response.ok, false);
  assert.equal(response.paired, false);
  assert.equal(response.controlOrigin, 'https://fixture.invalid');
  assert.equal(response.workspaceState.tabs.length, 2);
  assert.equal(worker.errors.length, 0);
  assert.equal(worker.options.get('global').enabled, false);
});

test('complete worker supports repeated opens across tabs without consuming an opening quota', async () => {
  const worker = await fullWorker();
  await worker.ready;
  for (let index = 0; index < 60; index += 1) {
    const id = index % 2 ? 12 : 15;
    await worker.click(id);
    assert.equal(worker.sessionValues[anchorKey].tabId, id);
    assert.equal(worker.options.get(id).enabled, true);
    if (index) assert.equal(worker.options.get(id === 12 ? 15 : 12).enabled, false);
  }
  assert.equal(worker.calls.filter(([kind]) => kind === 'open').length, 60);
  assert.equal(worker.errors.length, 0);
});

test('a cold full worker can open before startup completes without a late anchor restore taking ownership', async () => {
  const anchorRead = deferred();
  const worker = await fullWorker({ anchorRead });
  await worker.click(15);
  anchorRead.resolve({ [anchorKey]: { tabId: 12, windowId: 7 } });
  await worker.ready;
  assert.equal(worker.sessionValues[anchorKey].tabId, 15);
  assert.equal(worker.options.get(15).enabled, true);
  assert.equal(worker.errors.length, 0);
});

test('worker wakeup restores the same tab-specific owner and can reopen there and on another tab', async () => {
  const sessionValues = {};
  const first = await fullWorker({ sessionValues });
  await first.ready;
  await first.click(12);
  const resumed = await fullWorker({ sessionValues });
  await resumed.ready;
  assert.equal(resumed.options.get(12).enabled, true);
  await resumed.click(12);
  await resumed.click(15);
  assert.equal(sessionValues[anchorKey].tabId, 15);
  assert.equal(resumed.options.get(12).enabled, false);
  assert.equal(resumed.options.get('global').enabled, false);
  assert.equal(resumed.errors.length, 0);
});
