import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocation, buildReport, consumeRow, counters, initialCursor, modelKey, weeklyQuota } from './core.mjs';
import { begin, collect, openStore, readQuota, readRows, reportFromStore, validateConfig } from '../codex-subscription-meter.mjs';

const start = '2026-11-16T00:00:00.000Z';
const stamp = sec => new Date(Date.parse(start)+sec*1000).toISOString();
const config = { profileId:'synthetic',codexHome:'/synthetic/home',stateDir:'/synthetic/state',monthlyUsd:500 };
const count = (input=100, cache=60, output=20, reasoning=10) => ({ input_tokens:input,cached_input_tokens:cache,
  output_tokens:output,reasoning_output_tokens:reasoning,total_tokens:input+output });
const tokenRow = (c, sec=1) => ({type:'event_msg',timestamp:stamp(sec),payload:{type:'token_count',info:{total_token_usage:c,last_token_usage:count(999,0,999,0)}}});
const context = (model='model-a',sec=0,speed=undefined) => ({type:'turn_context',timestamp:stamp(sec),payload:{model,effort:'high',service_tier:speed}});
const snapshot = (percent,sec,extra={}) => ({timestamp:stamp(sec),accountKey:'account-a',quota:{usedPercent:percent,resetsAt:2000000000,planType:'promax',quotaGroup:'codex-standard',...extra}});
const event = (sec=30,model='model-a',tokens=1000000) => ({timestamp:stamp(sec),accountKey:'account-a',model,speed:'unknown',effort:'high',modelKey:modelKey({model,speed:'unknown'}),...count(tokens,0,0,0),uncached_input_tokens:tokens});
const snapshots = [snapshot(10,0),snapshot(11,60),snapshot(12,120),snapshot(13,180),snapshot(14,240),snapshot(15,300)];
const report = options => buildReport({config,startedAt:start,snapshots,events:[event()],...options});

test('reported counters retain cache/reasoning as subsets',()=>{
  assert.equal(counters(count()).total_tokens,120);
  assert.equal(counters({...count(),cached_input_tokens:101}),null);
  assert.equal(counters({...count(),reasoning_output_tokens:21}),null);
  assert.equal(counters({...count(),cached_input_tokens:undefined}),null);
});
test('duplicates and last-token snapshots are not added',()=>{
  const c=initialCursor();consumeRow(c,context());consumeRow(c,tokenRow(count()),{bootstrap:true});
  assert.equal(consumeRow(c,tokenRow(count(),2),{measurementStartedAt:start}).event,undefined);
  const e=consumeRow(c,tokenRow(count(130,70,30,15),3),{measurementStartedAt:start}).event;
  assert.equal(e.input_tokens,30);assert.equal(e.cached_input_tokens,10);assert.equal(e.uncached_input_tokens,20);
  assert.equal(e.output_tokens,10);assert.equal(e.total_tokens,40);
});
test('counter decrease is a gap, not a second full session',()=>{
  const c=initialCursor();consumeRow(c,tokenRow(count()),{bootstrap:true});
  assert.equal(consumeRow(c,tokenRow(count(10,5,2,1)),{measurementStartedAt:start}).gap,'counter-discontinuity');
});
test('missing baseline does not invent usage',()=>{
  assert.equal(consumeRow(initialCursor(),tokenRow(count()),{measurementStartedAt:start}).gap,'missing-initial-baseline');
});
test('copied fork prefixes establish inherited baseline only',()=>{
  const c=initialCursor({createdAt:stamp(100),model:'child'});
  consumeRow(c,context('parent',1));consumeRow(c,tokenRow(count(10000,5000,1000,500),2),{measurementStartedAt:start});
  assert.equal(c.model,'child');consumeRow(c,context('child',101));
  const e=consumeRow(c,tokenRow(count(10010,5000,1005,502),102),{measurementStartedAt:start}).event;
  assert.equal(e.model,'child');assert.equal(e.total_tokens,15);
});
test('model switches and absent speed metadata remain explicit',()=>{
  const c=initialCursor();consumeRow(c,context('a',1,'fast'));assert.equal(c.speed,'fast');
  consumeRow(c,context('b',2));assert.equal(c.model,'b');assert.equal(c.speed,'unknown');
  consumeRow(c,{type:'event_msg',timestamp:stamp(3),payload:{type:'model_reroute',from_model:'b',to_model:'fallback'}});
  assert.equal(c.model,'fallback');assert.equal(c.modelSource,'provider-reroute');
});
test('quota preserves fractions when supplied, rejects wrong pools and invalid values',()=>{
  const p={plan_type:'pro',rate_limit:{primary_window:{used_percent:12.5,limit_window_seconds:604800,reset_at:2000000000}}};
  assert.equal(weeklyQuota(p).usedPercent,12.5);
  p.rate_limit.primary_window.limit_window_seconds=18000;assert.equal(weeklyQuota(p),null);
  p.rate_limit.secondary_window={used_percent:45,limit_window_seconds:604800,reset_at:2000000000};
  assert.equal(weeklyQuota(p).usedPercent,45);
  p.rate_limit.primary_window.limit_window_seconds=604800;assert.equal(weeklyQuota(p),null);
});
test('canonical ledger includes compaction without double counting legacy snapshots',()=>{
  const c=initialCursor();consumeRow(c,context());
  const rec=(value,sec)=>({type:'token_usage_record',timestamp:stamp(sec),payload:{thread_token_usage:value}});
  consumeRow(c,tokenRow(count(1000,500,100,50)),{bootstrap:true});
  consumeRow(c,rec(count(1000,500,100,50),1),{bootstrap:true});
  const e=consumeRow(c,rec(count(1300,600,110,55),2),{measurementStartedAt:start}).event;
  assert.equal(e.total_tokens,310);assert.equal(e.counterSource,'canonical-thread-token-usage');
  assert.equal(consumeRow(c,tokenRow(count(1000,500,100,50),3),{measurementStartedAt:start}).event,undefined);
  assert.equal(consumeRow(c,rec(count(1400,600,120,60),4),{measurementStartedAt:start}).event.total_tokens,110);
  assert.equal(consumeRow(c,tokenRow(count(1100,500,110,55),5),{measurementStartedAt:start}).event,undefined);
});
test('mid-measurement ledger transition rebaselines instead of combining counters',()=>{
  const c=initialCursor();consumeRow(c,tokenRow(count()),{bootstrap:true});
  const r={type:'token_usage_record',timestamp:stamp(10),payload:{thread_token_usage:count(10000,5000,1000,500)}};
  assert.equal(consumeRow(c,r,{measurementStartedAt:start}).gap,'usage-ledger-transition');
});
test('500/month is annualized, not four-week arithmetic',()=>{
  const m=allocation(config);assert.ok(Math.abs(m.weeklyAllocatedUsd-114.99)<0.01);
  assert.ok(Math.abs(m.usdPerWeeklyPercentagePoint-1.1499)<0.001);
  assert.equal(m.additionalCashChargeUsd,0);
  assert.equal(allocation({...config,billingStart:'2026-11-01',billingEnd:'2026-12-01'}).weeklyAllocatedUsd,500*7/30);
  assert.throws(()=>allocation({...config,billingStart:'bad',billingEnd:'bad'}));
});
test('one-model five-point segment gives a conditional blended envelope',()=>{
  const r=report();assert.equal(r.calibrationSegments.length,1);
  const c=r.byModel[0].calibration;assert.equal(c.status,'tentative-observational-not-causal');
  assert.equal(c.quotaPointsPerMillionObservedTokens.central,5);
  assert.equal(c.quotaPointsPerMillionObservedTokens.low,3);
  assert.equal(c.quotaPointsPerMillionObservedTokens.high,7);
  assert.equal(c.separateInputOutputPrices,null);
});
test('small movements and flat quota are not precise model prices',()=>{
  for(const percent of [10,11,14]) {
    const r=report({snapshots:[snapshot(10,0),snapshot(percent,60),snapshot(percent,120),snapshot(percent,180),snapshot(percent,240),snapshot(percent,300)]});
    assert.equal(r.byModel[0].calibration.status,'insufficient-observations');
  }
});
test('mixed models, unknown models and speeds are not attributed arbitrarily',()=>{
  const r=report({events:[event(30,'a'),event(90,'b')]});
  assert.equal(r.calibrationSegments.length,0);assert.equal(r.excludedSegments[0].reason,'mixed-models-or-speeds');
  assert.equal(report({events:[event(30,'unknown')]}).excludedSegments[0].reason,'unknown-model');
});
test('saturation, resets, account changes and long missing periods cannot calibrate',()=>{
  assert.equal(report({snapshots:snapshots.map((x,i)=>snapshot(95+i,i*60))}).excludedSegments[0].reason,'quota-saturated');
  assert.equal(report({snapshots:[snapshot(50,0),snapshot(1,60,{resetsAt:2100000000})]}).calibrationSegments.length,0);
  assert.equal(report({snapshots:[snapshot(10,0),{...snapshot(20,300),accountKey:'other'}]}).calibrationSegments.length,0);
  assert.equal(report({snapshots:[snapshot(10,0),snapshot(20,3600)]}).calibrationSegments.length,0);
});
test('telemetry gaps exclude otherwise tempting correlations',()=>{
  assert.equal(report({gaps:[{timestamp:stamp(60)}]}).excludedSegments[0].reason,'telemetry-gap');
});
test('small reset timestamp jitter does not discard a stable weekly calibration',()=>{
  const r=report({snapshots:snapshots.map((s,i)=>({...s,quota:{...s.quota,resetsAt:s.quota.resetsAt+i%2}}))});
  assert.equal(r.calibrationSegments.length,1);
});
test('precomputed model totals avoid loading event history for routine reports',()=>{
  const e=event();const r=report({events:[],modelTotals:[{modelKey:e.modelKey,model:e.model,speed:e.speed,totals:e,efforts:{high:1},usageIncrements:1}],savedSegments:[]});
  assert.equal(r.observedTokens.total_tokens,1000000);assert.equal(r.usageIncrements,1);
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(process.env.CODE_AI_TEST_TMPDIR||os.tmpdir(),'code-ai-subscription-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),state=path.join(root,'state'),sessions=path.join(home,'sessions');fs.mkdirSync(sessions,{recursive:true});
  const c={...config,codexHome:home,stateDir:state};const db=openStore(c);t.after(()=>db.close());
  const started=begin(db,c).startedAt,created=new Date(Date.parse(started)-60000).toISOString();
  const filename=path.join(sessions,'rollout.jsonl');
  fs.writeFileSync(filename,JSON.stringify({...context(),timestamp:created})+'\n'+JSON.stringify({...tokenRow(count()),timestamp:created})+'\n');
  const thread={id:'thread',rollout_path:filename,created_at_ms:Date.parse(created),model:'model-a',reasoning_effort:'high'};
  let minute=0,percent=10,accountKey='synthetic-account';
  return {root,c,db,filename,started,thread,
    setPercent:x=>percent=x,setAccount:x=>accountKey=x,
    async sample(){minute++;return collect(db,c,{discoverThreads:()=>[thread],quotaReader:async()=>({timestamp:new Date(Date.parse(started)+minute*60000).toISOString(),accountKey,quota:snapshot(percent,0).quota,error:null})})},
    append(input=120,sec=90){fs.appendFileSync(filename,JSON.stringify({...tokenRow(count(input,60,30,10)),timestamp:new Date(Date.parse(started)+sec*1000).toISOString()})+'\n')} };
}
test('incremental collector baseline, repeat sampling and durable reopening',async t=>{
  const f=fixture(t);const first=await f.sample();assert.equal(first.baselineFiles,1);assert.equal(first.inserted,0);
  f.append();assert.equal((await f.sample()).inserted,1);assert.equal((await f.sample()).inserted,0);
  const r=reportFromStore(f.db,f.c);assert.equal(r.observedTokens.total_tokens,30);assert.equal(r.byModel[0].uncached_input_tokens,20);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.c.stateDir,'report.json'),'utf8')).usageIncrements,1);
  const other=openStore(f.c);assert.equal(reportFromStore(other,f.c).usageIncrements,1);other.close();
});
test('same database serializes concurrent samplers without duplicate usage',async t=>{
  const f=fixture(t);await f.sample();f.append();await Promise.all([f.sample(),f.sample()]);
  assert.equal(reportFromStore(f.db,f.c).usageIncrements,1);
});
test('closed calibration segments persist exactly once',async t=>{
  const f=fixture(t);await f.sample();
  for(let i=1;i<=5;i++){f.append(100+i*10,(i+1)*60-15);f.setPercent(10+i);await f.sample()}
  let r=reportFromStore(f.db,f.c);assert.equal(r.calibrationSegments.length,1);assert.equal(r.byModel[0].calibrationSegments,1);
  await f.sample();r=reportFromStore(f.db,f.c);assert.equal(r.calibrationSegments.length,1);
});
test('initial auth failure still binds the first later authenticated account',async t=>{
  const f=fixture(t);f.setAccount(undefined);await f.sample();f.setAccount('real-account');await f.sample();
  f.setAccount('different-account');f.append();await f.sample();
  assert.equal(reportFromStore(f.db,f.c).latestQuota.error,'account-changed-begin-new-measurement');
});
test('new campaign preserves previous measurements and resets baselines',async t=>{
  const f=fixture(t);await f.sample();f.append();await f.sample();begin(f.db,f.c);await f.sample();
  assert.equal(reportFromStore(f.db,f.c).usageIncrements,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM events').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM campaigns').get().n,2);
});
test('file replacement is a coverage gap, never another full token total',async t=>{
  const f=fixture(t);await f.sample();fs.writeFileSync(f.filename,JSON.stringify(tokenRow(count(500,0,50,10)))+'\n');
  await f.sample();const r=reportFromStore(f.db,f.c);assert.equal(r.usageIncrements,0);assert.ok(r.coverageGaps>0);
});
test('partial final row waits for newline',t=>{
  const f=fixture(t);const offset=fs.statSync(f.filename).size;fs.appendFileSync(f.filename,'{"type":');
  assert.equal(readRows(f.filename,offset).offset,offset);
  fs.appendFileSync(f.filename,'"test"}\n');assert.equal(readRows(f.filename,offset).rows.length,1);
});
test('large tool payload is streamed past without losing following usage',t=>{
  const f=fixture(t),offset=fs.statSync(f.filename).size;
  fs.appendFileSync(f.filename,JSON.stringify({timestamp:start,type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(10*1024*1024)}})+'\n'+JSON.stringify(tokenRow(count(200,100,30,10)))+'\n');
  const r=readRows(f.filename,offset);
  assert.equal(r.gap,null);assert.equal(r.invalidRows,0);assert.equal(r.pendingTelemetry,false);
  assert.equal(r.skippedIrrelevantLines,1);assert.equal(r.rows.length,1);
  assert.equal(r.rows[0].row.payload.info.total_token_usage.total_tokens,230);
  assert.equal(r.offset,fs.statSync(f.filename).size);
});
test('large payload continuation crosses sampling budgets and a restart',t=>{
  const f=fixture(t),offset=fs.statSync(f.filename).size;
  fs.appendFileSync(f.filename,JSON.stringify({timestamp:start,type:'response_item',payload:{output:'x'.repeat(300000)}})+'\n'+JSON.stringify(tokenRow(count()))+'\n');
  let r=readRows(f.filename,offset,{maxBytes:65536}),loops=1;assert.ok(r.readerState);assert.equal(r.pendingTelemetry,true);
  let rows=[...r.rows];
  while(r.pendingTelemetry && loops<10){r=readRows(f.filename,r.offset,{maxBytes:65536,readerState:JSON.parse(JSON.stringify(r.readerState))});rows.push(...r.rows);loops++}
  assert.equal(r.pendingTelemetry,false);assert.equal(r.gap,null);assert.equal(rows.length,1);assert.ok(loops>1);
});
test('incomplete irrelevant payload is safe and finishes on later append',t=>{
  const f=fixture(t),offset=fs.statSync(f.filename).size;
  fs.appendFileSync(f.filename,'{"timestamp":"'+start+'","type":"response_item","payload":{"output":"'+'x'.repeat(50000));
  const a=readRows(f.filename,offset);assert.equal(a.pendingTelemetry,false);assert.ok(a.readerState);
  fs.appendFileSync(f.filename,'"}}\n'+JSON.stringify(tokenRow(count()))+'\n');
  const b=readRows(f.filename,a.offset,{readerState:a.readerState});assert.equal(b.rows.length,1);assert.equal(b.gap,null);
});
test('oversized accounting metadata is an explicit gap, not a silent EOF jump',t=>{
  const f=fixture(t),offset=fs.statSync(f.filename).size;
  fs.appendFileSync(f.filename,JSON.stringify({timestamp:start,type:'turn_context',payload:{model:'a',extra:'x'.repeat(5*1024*1024)}})+'\n'+JSON.stringify(tokenRow(count()))+'\n');
  const r=readRows(f.filename,offset);assert.equal(r.gap,'oversize-telemetry-row');assert.equal(r.rows.length,1);
});
test('large response between samples causes no artificial historical gap',async t=>{
  const f=fixture(t);await f.sample();
  fs.appendFileSync(f.filename,JSON.stringify({timestamp:f.started,type:'response_item',payload:{output:'x'.repeat(6*1024*1024)}})+'\n');
  f.append();await f.sample();const r=reportFromStore(f.db,f.c);
  assert.equal(r.coverageGaps,0);assert.equal(r.observedTokens.total_tokens,30);assert.equal(r.latestQuota.telemetryPending,false);
});
test('preliminary ratio is separate from calibration and preserves uncertainty',async t=>{
  const f=fixture(t);await f.sample();f.append(200);f.setPercent(12);await f.sample();
  const r=reportFromStore(f.db,f.c);assert.equal(r.preliminary.quotaPercentagePoints,2);
  assert.equal(r.preliminary.status,'very-low-confidence-observation-not-calibration');
  assert.equal(r.preliminary.roundingEnvelopeOnlyUsdPerMillion.low,0);
  assert.equal(r.byModel[0].calibration.status,'insufficient-observations');
});
test('incomplete accounting rows hold calibration until their counters arrive',async t=>{
  const f=fixture(t);await f.sample();
  for(let i=1;i<=4;i++){f.append(100+i*10,(i+1)*60-15);f.setPercent(10+i);await f.sample()}
  const late={...tokenRow(count(150,60,30,10)),timestamp:new Date(Date.parse(f.started)+345000).toISOString()};
  fs.appendFileSync(f.filename,JSON.stringify(late));f.setPercent(15);await f.sample();
  let r=reportFromStore(f.db,f.c);assert.equal(r.latestQuota.telemetryPending,true);assert.equal(r.calibrationSegments.length,0);assert.equal(r.preliminary,null);
  fs.appendFileSync(f.filename,'\n');await f.sample();r=reportFromStore(f.db,f.c);
  assert.equal(r.latestQuota.telemetryPending,false);assert.equal(r.calibrationSegments.length,1);assert.equal(r.coverageGaps,0);
});
test('subscription GET uses credentials in memory and never returns them',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.c.codexHome,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-secret',account_id:'synthetic-id'}}));
  const r=await readQuota(f.c,async(url,init)=>{assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer synthetic-secret');
    return {ok:true,json:async()=>({plan_type:'pro',rate_limit:{primary_window:{used_percent:12.5,limit_window_seconds:604800,reset_at:2000000000}}})}});
  assert.equal(r.quota.usedPercent,12.5);assert.equal(JSON.stringify(r).includes('synthetic-secret'),false);assert.equal(JSON.stringify(r).includes('synthetic-id'),false);
});
test('account swap stops attribution until a new measurement',async t=>{
  const f=fixture(t);await f.sample();f.setAccount('different-account');f.append();await f.sample();
  const r=reportFromStore(f.db,f.c);assert.equal(r.usageIncrements,0);assert.equal(r.latestQuota.error,'account-changed-begin-new-measurement');
});
test('unsafe state placement and invalid sampling settings are refused',()=>{
  assert.throws(()=>validateConfig({...config,stateDir:'/synthetic/home/state'}));
  assert.throws(()=>validateConfig({...config,minimumQuotaDelta:1}));
  assert.throws(()=>validateConfig({...config,minimumSegmentSeconds:10}));
});
