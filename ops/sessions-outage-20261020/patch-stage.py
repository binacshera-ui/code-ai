from pathlib import Path
import shutil,json,hashlib,time
base=Path('/mnt/hdd/code-ai-builds/auth-cycle-fast-quota-source-20261016')
stage=Path('/mnt/hdd/code-ai-builds/sessions-read-source-20261020')
assert not stage.exists();shutil.copytree(base,stage);p=stage/'payload'
(p/'server/codexSessionReadBudget.mjs').write_text('''/** Keep displayed text independent of a potentially enormous backing string.
 * UTF-16 preserves code units even when a display cutoff bisects a surrogate. */
export function detachSessionText(text) {
 return Buffer.from(text, 'utf16le').toString('utf16le');
}

/** One active and at most one fresh follow-up read per profile/window.
 * Callers arriving during a read share the follow-up, which captures its source
 * revision only after the preceding read finishes. Globally bound all reads,
 * including persisted JSON decoding, so changing files cannot multiply heaps. */
export function createSessionReadBudget({concurrency=2}={}) {
 if(!Number.isSafeInteger(concurrency)||concurrency<1)throw Error('Invalid session read concurrency');
 const entries=new Map(),queue=[];let active=0;
 function work(key,read){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{key,read,promise,resolve,reject,started:false}}
 function drain(){
  while(active<concurrency&&queue.length){
   const job=queue.shift();job.started=true;active++;
   void(async()=>{
    try{job.resolve(await job.read())}catch(e){job.reject(e)}finally{
     active--;const entry=entries.get(job.key);
     if(entry?.active===job){if(entry.pending){entry.active=entry.pending;entry.pending=null;queue.push(entry.active)}else entries.delete(job.key)}
     drain();
    }
   })();
  }
 }
 return{
  read(key,read){
   const entry=entries.get(key);
   if(entry){
    if(!entry.active.started){entry.active.read=read;return entry.active.promise}
    if(entry.pending){entry.pending.read=read;return entry.pending.promise}
    entry.pending=work(key,read);return entry.pending.promise;
   }
   const job=work(key,read);entries.set(key,{active:job,pending:null});queue.push(job);drain();return job.promise;
  },
  stats(){return{active,queued:queue.length,keys:entries.size}}
 };
}
''')
(p/'server/codexSessionReadBudget.test.mjs').write_text('''import assert from 'node:assert/strict';import test from 'node:test';import{execFileSync}from'node:child_process';
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
test('detachment preserves every UTF-16 code unit including a cutoff surrogate',()=>{for(const value of ['שלום abc','x'.repeat(200000),'a\\ud83d','\\udc00b'])assert.equal(detachSessionText(value),value)});
test('clipped display strings do not retain huge raw payload allocations',()=>{
 const url=new URL('./codexSessionReadBudget.mjs',import.meta.url).href;
 const source=`import assert from 'node:assert/strict';import{detachSessionText}from ${JSON.stringify(url)};global.gc();const baseline=process.memoryUsage().heapUsed;const output=[];for(let i=0;i<8;i++){const raw=Buffer.alloc(16*1024*1024,65+i).toString();output.push(detachSessionText(raw.slice(0,200000))+'\\\\n…')}global.gc();assert.ok(output.every(x=>x.length===200003));const retained=process.memoryUsage().heapUsed-baseline;assert.ok(retained<32*1024*1024,'Retained raw payload bytes: '+retained);`;
 execFileSync(process.execPath,['--expose-gc','--input-type=module','-e',source],{timeout:15000,stdio:'pipe'});
});
''')
f=p/'server/codexService.ts';s=f.read_text()
old="import { normalizeCodexSessionRow,createCodexMessageProjection } from './codexSessionMessages.js';"
assert s.count(old)==1;s=s.replace(old,old+"\nimport { createSessionReadBudget, detachSessionText } from './codexSessionReadBudget.mjs';")
old='const sessionDetailLoads = new Map<string, Promise<CodexSessionDetail>>();';assert s.count(old)==1;s=s.replace(old,old+'\nconst sessionReadBudget = createSessionReadBudget({ concurrency: 2 });')
old='''  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}\\n…`;'''
new='''  if (normalized.length <= limit) {
    return normalized === text ? normalized : detachSessionText(normalized);
  }

  return `${detachSessionText(normalized.slice(0, limit - 1).trimEnd())}\\n…`;'''
assert s.count(old)==1;s=s.replace(old,new)
old='export async function getCodexSessionDetail(\n';assert s.count(old)==1
wrapper='''export function getCodexSessionDetail(
  sessionId: string,
  profileId?: string,
  options?: { tail?: number; before?: number; full?: boolean }
): Promise<CodexSessionDetail> {
  const profile = resolveProfile(profileId);
  const key = JSON.stringify([profile.id, sessionId, buildSessionDetailVariant(options) || 'full']);
  return sessionReadBudget.read(key, () => readCodexSessionDetail(sessionId, profile.id, options));
}

async function readCodexSessionDetail(
'''
s=s.replace(old,wrapper)
# A read is tied to the source size used by its cache signature. Never consume
# a later append and then parse that same append again as an incremental read.
needle='interface ParseSessionFileOptions {';assert s.count(needle)==1;s=s.replace(needle,needle+'\n  endByte?: number;')
old="  const stream = createReadStream(sessionPath, {\n    encoding: 'utf-8',";assert s.count(old)==1;s=s.replace(old,old+"\n    ...(typeof options?.endByte === 'number' ? { end: Math.max(0, options.endByte - 1) } : {}),")
old='      startByte: staleRecord.sourceSize,';assert s.count(old)==1;s=s.replace(old,old+'\n      endByte: stats.size,')
old='''    const parsedBase = await parseSessionFile(sessionFile.path, sessionId, indexMap.get(sessionId), {
      maxRetainedMessages: requestedTailLimit,''';assert s.count(old)==1;s=s.replace(old,old.replace('      maxRetainedMessages:', '      endByte: stats.size,\n      maxRetainedMessages:'))
f.write_text(s)
f=stage/'test.mjs';s=f.read_text();needle="const mjs=['server/codexRuntimeHealth.test.mjs'";assert s.count(needle)==1;s=s.replace(needle,"const mjs=['server/codexSessionReadBudget.test.mjs','server/codexRuntimeHealth.test.mjs'")
needle="const ts=['server/codexRateLimits.accountOnly.test.ts'";assert s.count(needle)==1;s=s.replace(needle,"const ts=['server/codexSessionReadSnapshot.test.ts','server/codexRateLimits.accountOnly.test.ts'");f.write_text(s)
f=stage/'build.mjs';s=f.read_text();assert "'fleet-20261016-'" in s;f.write_text(s.replace("'fleet-20261016-'","'fleet-20261020-'"))
print(json.dumps(dict(stage=str(stage),phase='patched; snapshot integration test pending',productionSourceChanged=False)))
