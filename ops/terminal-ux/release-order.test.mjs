import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseOverrideName,assertEffectiveRelease} from './release-order.mjs';
const id='0303ed93-f62f-4b06-891e-1d84a58183f9';
test('time ordering wins over legacy drop-ins even when the UUID sorts earlier',()=>{
 const previous='zzzzzz-code-ai-immediate-b6196953-8f40-4acb-a040-1b31a912bea6.conf';
 const next=releaseOverrideName({releaseOrder:'1791690000000',buildId:id});
 assert.equal([next,previous].sort().at(-1),next);
 assert.equal([releaseOverrideName({releaseOrder:'1791690000001',buildId:'00000000-0000-0000-0000-000000000000'}),next].sort().at(-1),releaseOverrideName({releaseOrder:'1791690000001',buildId:'00000000-0000-0000-0000-000000000000'}));
});
test('ignored candidate configuration fails before any stop/start action',()=>{
 assert.throws(()=>assertEffectiveRelease({workingDirectory:'/old',command:'/node /old/dist/server.js',candidate:'/new'}));
 assert.throws(()=>assertEffectiveRelease({workingDirectory:'/new',command:'/node /old/dist/server.js',candidate:'/new'}));
 assert.doesNotThrow(()=>assertEffectiveRelease({workingDirectory:'/new',command:'/node /new/dist/server.js',candidate:'/new'}));
});
test('malformed order cannot create an override filename',()=>{
 assert.throws(()=>releaseOverrideName({releaseOrder:'../escape',buildId:id}));
});
