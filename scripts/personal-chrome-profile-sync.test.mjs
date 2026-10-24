import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { adoptInitialProfile, profileSnapshot, receiveProfile, updateProfile } from '../chrome-extension/profileSync.js';

test('a canonical server profile cannot be erased by an empty or stale reconnect',()=>{
  const stored=profileSnapshot({name:'שם מהטלפון',avatarDataUrl:'data:image/png;base64,aGVsbG8='},3);
  assert.deepEqual(adoptInitialProfile(stored,null),stored);
  assert.deepEqual(adoptInitialProfile(stored,{name:'עותק ישן'}),stored);
  assert.equal(adoptInitialProfile(profileSnapshot(null),{name:'שם מקומי'}).profileRevision,1);
});
test('explicit edits are revisioned, and stale editors must resolve a conflict',()=>{
  const first=updateProfile(profileSnapshot({name:'A'}),{baseRevision:0,profileIdentity:{name:'B'}});
  assert.equal(first.profileRevision,1);assert.equal(first.profileIdentity.name,'B');
  assert.throws(()=>updateProfile(first,{baseRevision:0,profileIdentity:{name:'stale'}}),{code:'PROFILE_CONFLICT'});
  assert.deepEqual(updateProfile(first,{baseRevision:1,profileIdentity:{name:'B'}}),first);
  assert.throws(()=>updateProfile(first,{baseRevision:1,profileIdentity:{name:''}}),{code:'INVALID_PROFILE'});
  assert.throws(()=>updateProfile(first,{baseRevision:1,profileIdentity:{name:'safe',avatarDataUrl:'https://tracker.invalid/a'}}),{code:'INVALID_PROFILE'});
});
test('an offline edit survives reload and a conflicting edit from another surface',()=>{
  const initial={...profileSnapshot({name:'old'},4),pendingIdentity:{name:'offline draft'},conflict:false};
  const unchanged=receiveProfile(JSON.parse(JSON.stringify(initial)),profileSnapshot({name:'old'},4));
  assert.equal(unchanged.pendingIdentity.name,'offline draft');assert.equal(unchanged.conflict,false);
  const conflict=receiveProfile(unchanged,profileSnapshot({name:'phone edit'},5));
  assert.equal(conflict.pendingIdentity.name,'offline draft');assert.equal(conflict.conflict,true);
  const accepted=receiveProfile(conflict,profileSnapshot({name:'offline draft'},6));
  assert.equal(accepted.pendingIdentity,null);assert.equal(accepted.conflict,false);
  assert.equal(receiveProfile(accepted,profileSnapshot({name:'late'},5)),accepted);
});

async function clientApi() {
  const context=vm.createContext({Error,Response});
  const identity=new vm.SourceTextModule(await fs.readFile('chrome-extension/profileIdentity.js','utf8'),{context});
  const source=stripTypeScriptTypes(await fs.readFile('client/src/components/codex/personalChromeProfile.ts','utf8'));
  const module=new vm.SourceTextModule(source,{context});
  await module.link(specifier=>{assert.equal(specifier,'../../../../chrome-extension/profileIdentity.js');return identity;});
  await module.evaluate();return module.namespace;
}
test('app profile edits target the exact device and return only an acknowledged save',async()=>{
  const api=await clientApi();let call;
  const saved=await api.saveChromeProfile('device/1',{name:'דפדפן',avatarDataUrl:null},3,async(url,init)=>{
    call={url,init};return Response.json({saved:true,device:{id:'device/1',name:'דפדפן',profileRevision:4,profileIdentity:{name:'דפדפן'}}});
  });
  assert.equal(call.url,'/api/codex/browser-extension/devices/device%2F1/profile');
  assert.equal(JSON.parse(call.init.body).baseRevision,3);assert.equal(saved.profileRevision,4);
});
test('app errors preserve the editor; HTML, unavailable servers and wrong-device replies are not success',async()=>{
  const api=await clientApi();
  await assert.rejects(()=>api.saveChromeProfile('device',{name:'draft'},0,async()=>new Response('<!DOCTYPE html>',{status:404})),/הפרטים שערכת נשארו/);
  await assert.rejects(()=>api.saveChromeProfile('device',{name:'draft'},0,async()=>Response.json({saved:true,device:{id:'another'}})),/נשארו כאן/);
  await assert.rejects(()=>api.saveChromeProfile('device',{name:'draft'},0,async()=>Response.json({device:{id:'device',profileRevision:2}},{status:409})),failure=>failure instanceof api.ChromeProfileConflictError && failure.device.profileRevision===2);
});
test('a delayed device-list response keeps the most recently acknowledged profile',async()=>{
  const api=await clientApi();
  const current=[{id:'one',name:'new',profileRevision:5,profileIdentity:{name:'new'}},{id:'other',name:'other',profileRevision:2}];
  const merged=api.mergeChromeProfiles(current,[{id:'one',name:'old',profileRevision:4,online:false},{id:'other',name:'phone',profileRevision:3}]);
  assert.equal(merged[0].name,'new');assert.equal(merged[0].profileRevision,5);assert.equal(merged[0].online,false);
  assert.equal(merged[1].name,'phone');assert.equal(merged[1].profileRevision,3);
});
