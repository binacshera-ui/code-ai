import test from 'node:test';import assert from 'node:assert/strict';
import {stopBudgetMs,waitOwnerStopped,recordedGenerationDead} from './owner-stop-contract.mjs';
const stat=(state,generation)=>{const f=Array(20).fill('0');f[0]=state;f[19]=generation;return '111 (native) '+f.join(' ');};
const units=[{name:'owner',prior:[{pid:111,generation:'original'}]}];
test('stop budget follows installed timeout plus margin, refuses unknown or unbounded timeout',()=>{
 assert.equal(stopBudgetMs('30s'),45000);assert.equal(stopBudgetMs('1min 15s'),90000);
 for(const s of ['infinity','unknown','30s extra','2min'])assert.throws(()=>stopBudgetMs(s));
});
test('failed unit with dead prior generations is safely stopped, not confused with a live error',async()=>{
 await waitOwnerStopped({units,readUnit:()=>({ActiveState:'failed',MainPID:'0'}),readFile:async()=>stat('Z','original'),sleep:async()=>{},timeoutMs:1});
});
test('no plan can change while a writer survives failed/inactive unit or MainPID remains live',async()=>{
 for(const s of [{ActiveState:'failed',MainPID:'0'},{ActiveState:'inactive',MainPID:'0'},{ActiveState:'failed',MainPID:'999'}]) {
  let clock=0;await assert.rejects(waitOwnerStopped({units,readUnit:()=>s,readFile:async()=>stat('S','original'),now:()=>clock++,sleep:async()=>{},timeoutMs:1}),/owner_stop_failed/);
 }
});
test('generation mismatch is dead predecessor, missing proc is dead, unreadable/malformed proc is NOT proof',async()=>{
 assert.equal(await recordedGenerationDead(async()=>stat('S','replacement'),111,'original'),true);
 assert.equal(await recordedGenerationDead(async()=>{throw Object.assign(Error(),{code:'ENOENT'});},111,'original'),true);
 assert.equal(await recordedGenerationDead(async()=>{throw Object.assign(Error(),{code:'EACCES'});},111,'original'),false);
 assert.equal(await recordedGenerationDead(async()=>'malformed',111,'original'),false);
});
