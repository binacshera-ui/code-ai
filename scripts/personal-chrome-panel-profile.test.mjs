import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root=path.resolve('chrome-extension');
async function panel(options={}) {
  const html=await fs.readFile(path.join(root,'panel.html'),'utf8');
  const messages=[];
  class Element {
    value=''; hidden=false; dataset={}; className=''; listeners={}; src=''; disabled=false;
    contentWindow={postMessage(){}};
    addEventListener(name,fn) { this.listeners[name]=fn; }
    async emit(name, event={}) { await this.listeners[name]?.({target:this,preventDefault(){},...event}); }
    replaceChildren() {} append() {}
    querySelector(selector) { assert.equal(selector,'button[type=submit]'); return this.submitButton ||= new Element(); }
  }
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const chrome={runtime:{
    async sendMessage(message){messages.push(message);if(message.type==='PAIR_DEVICE'&&options.failPairing)return {ok:false,error:'Synthetic expired code'};
      if(message.type==='PANEL_SAVE_PROFILE'&&options.failSave)return {ok:false,error:'Synthetic failed save',profileSyncStatus:'conflict',profileIdentity:message.profileIdentity};
      return {
      ok:true,paired:message.type==='PAIR_DEVICE'||options.paired!==false,connected:options.paired!==false,deviceName:'Fixture Chrome',
      settings:{controlOrigin:'https://fixture.invalid',deviceId:'fixture-device'},
      profileIdentity:message.profileIdentity||{name:'Fixture Chrome',avatarDataUrl:null,source:'custom'},
      profileSyncStatus:options.syncStatus || 'local',
      saveMessage:options.syncStatus === 'synced' ? 'Saved and synchronized' : 'Saved on this device only',
      workspaceState:{tabs:[]},
    };}, onMessage:{addListener(){}},
  }};
  const document={
    querySelector(selector) {
      if(selector==='meta[name="code-ai-control-origin"]')return {content:'https://fixture.invalid'};
      const element=elements.get(selector.slice(1)); assert.ok(element,`missing real HTML element ${selector}`);return element;
    }, createElement(){return new Element();},
  };
  const context=vm.createContext({document,chrome,URL,console,window:{addEventListener(){}}});
  const identity=new vm.SourceTextModule(await fs.readFile(path.join(root,'profileIdentity.js'),'utf8'),{context});
  const module=new vm.SourceTextModule(await fs.readFile(path.join(root,'panel.js'),'utf8')+'\nglobalThis.profileProbe={setStatus};',{context});
  const pairing=new vm.SourceTextModule(await fs.readFile(path.join(root,'panelPairing.js'),'utf8'),{context});
  await module.link(specifier=>{
    if(specifier==='./profileIdentity.js')return identity;
    assert.equal(specifier,'./panelPairing.js');return pairing;
  });
  await module.evaluate();await new Promise(resolve=>setImmediate(resolve));
  return {elements,messages,status:context.profileProbe.setStatus};
}
test('profile form sends a saved alias and displays its avatar without unsafe markup',async()=>{
  const h=await panel();await h.elements.get('profile-settings').emit('click');
  h.elements.get('profile-name').value='הדפדפן שלי';
  await h.elements.get('profile-form').emit('submit');
  const sent=h.messages.find(m=>m.type==='PANEL_SAVE_PROFILE');
  assert.equal(sent.profileIdentity.name,'הדפדפן שלי');
  assert.equal(h.elements.get('profile-drawer').hidden,true);
  h.status({profileIdentity:{name:'בדיקה',avatarDataUrl:'data:image/png;base64,aGVsbG8='}});
  assert.equal(h.elements.get('profile-avatar').src,'data:image/png;base64,aGVsbG8=');
  h.status({profileIdentity:{name:'בדיקה',avatarDataUrl:'https://tracker.invalid/avatar'}});
  assert.equal(h.elements.get('profile-avatar').hidden,true);
});
test('new installation exposes recovery and hides it after a successful one-use code claim',async()=>{
  const h=await panel({paired:false});
  assert.equal(h.elements.get('pairing-drawer').hidden,false);
  h.elements.get('pairing-code').value='ABCD-EFGH';
  await h.elements.get('pairing-form').emit('submit');
  const sent=h.messages.find(m=>m.type==='PAIR_DEVICE');
  assert.equal(sent.code,'ABCD-EFGH');
  assert.equal(sent.password,undefined);
  assert.equal(h.elements.get('pairing-code').value,'');
  assert.equal(h.elements.get('pairing-drawer').hidden,true);
  assert.equal(h.elements.get('pairing-submit').disabled,false);
  assert.equal(h.elements.get('code-ai-frame').src,'https://fixture.invalid/extension-panel');
});
test('failed code claim remains unpaired and keeps recovery actionable',async()=>{
  const h=await panel({paired:false,failPairing:true});
  h.elements.get('pairing-code').value='ABCD-EFGH';
  await h.elements.get('pairing-form').emit('submit');
  assert.equal(h.elements.get('pairing-drawer').hidden,false);
  assert.equal(h.elements.get('pairing-submit').disabled,false);
  assert.equal(h.elements.get('selection-banner').dataset.tone,'error');
});
test('only the explicit identity export format is accepted; raw Chrome settings are rejected',async()=>{
  const h=await panel();
  await h.elements.get('profile-import').emit('change',{target:{value:'x',files:[{size:10,text:async()=>JSON.stringify({profile:{info_cache:{}}})}]}});
  assert.equal(h.elements.get('selection-banner').dataset.tone,'error');
  await h.elements.get('profile-import').emit('change',{target:{value:'x',files:[{size:100,text:async()=>JSON.stringify({format:'code-ai-chrome-profile',version:1,profileIdentity:{name:'השם של Chrome'}})}]}});
  assert.equal(h.elements.get('profile-name').value,'השם של Chrome');
  await h.elements.get('profile-form').emit('submit');
  assert.equal(h.messages.find(m=>m.type==='PANEL_SAVE_PROFILE').profileIdentity.source,'chrome-local');
});
test('local-only saves are not presented as synchronized server saves',async()=>{
  const h=await panel({syncStatus:'pending'});await h.elements.get('profile-settings').emit('click');
  h.elements.get('profile-name').value='offline';await h.elements.get('profile-form').emit('submit');
  assert.equal(h.elements.get('selection-banner').dataset.tone,'info');
  assert.equal(h.elements.get('selection-banner').textContent,'Saved on this device only');
  assert.match(h.elements.get('profile-sync-status').textContent,/ממתינים לסנכרון/);
});
test('only an acknowledged server save gets a synchronized success notice',async()=>{
  const h=await panel({syncStatus:'synced'});await h.elements.get('profile-settings').emit('click');await h.elements.get('profile-form').emit('submit');
  assert.equal(h.elements.get('selection-banner').dataset.tone,'success');
  assert.equal(h.elements.get('selection-banner').textContent,'Saved and synchronized');
});
test('a failed profile save retains the form and its current name for retry',async()=>{
  const h=await panel({failSave:true});await h.elements.get('profile-settings').emit('click');
  h.elements.get('profile-name').value='keep my edit';await h.elements.get('profile-form').emit('submit');
  assert.equal(h.elements.get('profile-drawer').hidden,false);
  assert.equal(h.elements.get('profile-name').value,'keep my edit');
  assert.equal(h.elements.get('selection-banner').dataset.tone,'error');
});
