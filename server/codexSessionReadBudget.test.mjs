import assert from 'node:assert/strict';import test from 'node:test';import{execFileSync}from'node:child_process';
import{createSessionReadBudget,detachSessionText}from'./codexSessionReadBudget.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
test('live revisions coalesce into one fresh follow-up after the active snapshot',async()=>{
 const budget=createSessionReadBudget();const gate=deferred();let value=1,reads=0;
 const first=budget.read('profile/session/window',async()=>{reads++;const snapshot=value;await gate.promise;return snapshot});
 value=2;const second=budget.read('profile/session/window',async()=>{reads++;return value});
 value=3;const latest=budget.read('profile/session/window',async()=>{reads++;return value});
 assert.equal(second,latest);assert.equal(reads,1);gate.resolve();assert.equal(await first,1);assert.deepEqual(await Promise.all([second,latest]),[3,3]);assert.equal(reads,2);assert.deepEqual(budget.stats(),{active:0,queued:0,keys:0});
});
test('distinct conversations have a global bound and errors release capacity',async()=>{
 const budget=createSessionReadBudget({concurrency:2});const gate=deferred();let active=0,peak=0;
 const jobs=Array.from({length:12},(_,i)=>budget.read('profile/'+i,async()=>{active++;peak=Math.max(peak,active);try{await gate.promise;if(i===0)throw Error('synthetic-read-failure');return i}finally{active--}}));
 const settled=Promise.allSettled(jobs);assert.equal(active,2);gate.resolve();const results=await settled;assert.equal(results[0].status,'rejected');assert.equal(results.filter(x=>x.status==='fulfilled').length,11);assert.equal(peak,2);assert.deepEqual(budget.stats(),{active:0,queued:0,keys:0});assert.equal(await budget.read('profile/0',async()=>42),42);
});
test('queued windows remain separate across profiles and requested history pages',async()=>{
 const budget=createSessionReadBudget({concurrency:1});const gate=deferred();const first=budget.read('p1/thread/latest',()=>gate.promise);
 const a=budget.read('p2/thread/latest',async()=>2),b=budget.read('p1/thread/before-10',async()=>3);assert.notEqual(a,b);gate.resolve(1);assert.deepEqual(await Promise.all([first,a,b]),[1,2,3]);
});
test('detachment preserves every UTF-16 code unit including a cutoff surrogate',()=>{for(const value of ['שלום abc','x'.repeat(200000),'a\ud83d','\udc00b'])assert.equal(detachSessionText(value),value)});
test('clipped display strings do not retain huge raw payload allocations',()=>{
 const url=new URL('./codexSessionReadBudget.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import{detachSessionText}from ${JSON.stringify(url)};global.gc();const baseline=process.memoryUsage().heapUsed;const output=[];for(let i=0;i<8;i++){const raw=Buffer.alloc(16*1024*1024,65+i).toString();output.push(detachSessionText(raw.slice(0,200000))+'\\n…')}global.gc();assert.ok(output.every(x=>x.length===200002));const retained=process.memoryUsage().heapUsed-baseline;assert.ok(retained<32*1024*1024,'Retained raw payload bytes: '+retained);`;
 execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',source],{timeout:15000,stdio:'pipe'});
});
