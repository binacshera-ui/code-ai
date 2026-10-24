import assert from 'node:assert/strict';import{promises as fs}from'node:fs';import path from'node:path';import os from'node:os';import test from'node:test';
test('overlapping reads of an appending rollout keep stable snapshots and include a late append exactly once',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-read-snapshot-'));const home=path.join(root,'.codex'),folder=path.join(home,'sessions','2026','10','20');await fs.mkdir(folder,{recursive:true});
 const id='12345678-1234-4234-8234-123456789012',file=path.join(folder,'rollout-'+id+'.jsonl');
 await fs.writeFile(file,[JSON.stringify({type:'session_meta',timestamp:'2026-10-20T08:00:00Z',payload:{id,cwd:root,source:'cli',model_provider:'openai'}}),JSON.stringify({type:'event_msg',timestamp:'2026-10-20T08:00:01Z',payload:{type:'user_message',message:'Synthetic snapshot input'}}),''].join('\n'));
 process.env.CODEX_APP_ROOT=root;process.env.CODEX_STORAGE_ROOT=path.join(root,'state');process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';process.env.CODEX_PROFILES_JSON=JSON.stringify([{id:'snapshot-test',label:'Snapshot test',provider:'codex',codexHome:home,workspaceCwd:root,defaultProfile:true}]);delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
 const service=await import('./codexService.js');await service.listCodexSessions('snapshot-test');
 const originalStat=fs.stat;let armed=true,observedResolve!:()=>void;const observed=new Promise<void>(r=>observedResolve=r);
 fs.stat=(async(...args:any[])=>{const result=await(originalStat as any)(...args);if(String(args[0])===file&&armed){armed=false;await fs.appendFile(file,JSON.stringify({type:'event_msg',timestamp:'2026-10-20T08:00:02Z',payload:{type:'agent_message',phase:'final',message:'Synthetic late append'}})+'\n');observedResolve()}return result}) as typeof fs.stat;
 t.after(async()=>{fs.stat=originalStat;await new Promise(r=>setTimeout(r,50));await fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:30})});
 const firstPromise=service.getCodexSessionDetail(id,'snapshot-test',{tail:40});await observed;
 const followup=service.getCodexSessionDetail(id,'snapshot-test',{tail:40});const joined=service.getCodexSessionDetail(id,'snapshot-test',{tail:40});
 const first=await firstPromise;assert.equal(first.timeline.some(e=>e.text==='Synthetic late append'),false,'An append after the captured source size leaked into the earlier snapshot');
 const [fresh,alsoFresh]=await Promise.all([followup,joined]);assert.deepEqual(fresh,alsoFresh);assert.equal(fresh.timeline.filter(e=>e.text==='Synthetic late append').length,1);assert.equal(fresh.timeline.filter(e=>e.text==='Synthetic snapshot input').length,1);
 const warm=await service.getCodexSessionDetail(id,'snapshot-test',{tail:40});assert.equal(warm.timeline.filter(e=>e.text==='Synthetic late append').length,1);
});
