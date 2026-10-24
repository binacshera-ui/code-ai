import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import test from 'node:test';
test('account-only refresh reads current account without scanning or borrowing session history',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'code-ai-account-only-'));const home=path.join(root,'.codex');await fs.mkdir(home);await fs.mkdir(path.join(home,'sessions'));
 process.env.CODEX_PROFILES_JSON=JSON.stringify([{id:'synthetic-account-only',label:'Synthetic account only',provider:'codex',codexHome:home,workspaceCwd:root,defaultProfile:true}]);
 process.env.CODEX_STORAGE_ROOT=path.join(root,'state');process.env.CODEX_APP_ROOT=root;process.env.CODEX_QUEUE_DISABLE_EXECUTION='1';delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
 const originalReaddir=fs.readdir;const originalFetch=globalThis.fetch;let scans=0,calls=0;
 fs.readdir=(async(...args:any[])=>{if(String(args[0]).startsWith(home)){scans++;throw Error('History must not be read during account refresh')}return (originalReaddir as any)(...args)}) as typeof fs.readdir;
 globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({account_id:'synthetic-new-account',email:'new-account@example.invalid',plan_type:'pro',rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:7,limit_window_seconds:604800,reset_at:1800000000}},credits:[],available_count:0}),{status:200})}) as typeof fetch;
 t.after(async()=>{fs.readdir=originalReaddir;globalThis.fetch=originalFetch;await fs.rm(root,{recursive:true,force:true})});
 const {getCodexRateLimitSnapshot}=await import('./codexService.js');
 const disconnected=await getCodexRateLimitSnapshot('synthetic-account-only',undefined,true);
 assert.equal(disconnected?.account?.authenticated,false);assert.equal(disconnected?.sessionId,null);assert.equal(disconnected?.context,null);assert.equal(disconnected?.primary,null);assert.equal(scans,0);assert.equal(calls,0);
 await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-test-only',account_id:'synthetic-new-account'}}));
 const connected=await getCodexRateLimitSnapshot('synthetic-account-only',undefined,true);
 assert.equal(connected?.account?.authenticated,true);assert.equal(connected?.account?.email,'new-account@example.invalid');assert.equal(connected?.primary?.usedPercent,7);assert.equal(connected?.sessionId,null);assert.equal(connected?.context,null);assert.equal(scans,0);assert.equal(calls,2);
});
