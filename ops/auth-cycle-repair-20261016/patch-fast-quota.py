from pathlib import Path
import json,shutil,hashlib,time,subprocess,tempfile,os
ops=Path('/root/projects/code-ai/ops/auth-cycle-repair-20261016')
base=Path('/mnt/hdd/code-ai-builds/auth-cycle-source-20261016')
root=Path('/mnt/hdd/code-ai-builds/auth-cycle-fast-quota-source-20261016')
assert not root.exists();shutil.copytree(base,root)
for name in ['state.json','prepared-release.json','source-backport.json']:
    shutil.copy2(ops/name,ops/('r9-'+name))
p=root/'payload';f=p/'server/codexService.ts';s=f.read_text()
old="""  } else {
    const sessionFiles = await scanSessionFiles(profile);
    for (const sessionRecord of sessionFiles) {
      const snapshot = await readRateLimitSnapshotFromSessionRecord(profile, sessionRecord);
      if (snapshot) {
        sessionSnapshot = snapshot;
        break;
      }
    }
  }

  const accountUsage = await loadCodexAccountUsage(profile, { forceRefresh: forceAccountRefresh });"""
new="""  }

  // Account login/logout and the account panel must not wait for a complete
  // history scan, or borrow quota/context from a different, older account.
  // Session context is read only when the caller selected that exact thread.
  const accountUsage = await loadCodexAccountUsage(profile, { forceRefresh: forceAccountRefresh });"""
assert s.count(old)==1;f.write_text(s.replace(old,new))
test=r"""import assert from 'node:assert/strict';
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
"""
(p/'server/codexRateLimits.accountOnly.test.ts').write_text(test)
f=root/'test.mjs';s=f.read_text();needle="const ts=['server/codexAccountAuth.lifecycle.test.ts'";assert s.count(needle)==1;f.write_text(s.replace(needle,"const ts=['server/codexRateLimits.accountOnly.test.ts','server/codexAccountAuth.lifecycle.test.ts'"))
node='/root/.nvm/versions/node/v24.12.0/bin/node';tmp=Path(tempfile.mkdtemp(prefix='auth-cycle-account-only-',dir='/mnt/hdd/code-ai-builds'));(tmp/'node_modules').symlink_to(Path('/root/projects/code-ai/node_modules').resolve())
js="import{createRequire}from'node:module';const{build}=createRequire('/root/projects/code-ai/package.json')('esbuild');await build({absWorkingDir:process.argv[1],entryPoints:['server/codexRateLimits.accountOnly.test.ts'],outfile:process.argv[2],bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});"
subprocess.run([node,'--input-type=module','-e',js,str(p),str(tmp/'test.mjs')],check=True)
with (ops/'account-only-unit.log').open('w') as log:subprocess.run([node,'--test',str(tmp/'test.mjs')],env={**os.environ,'CODEX_DEVICE_ADMIN_PASSWORD':'synthetic-unit-only','SESSION_SECRET':'synthetic-unit-only'},cwd=p,stdout=log,stderr=subprocess.STDOUT,check=True)
h=hashlib.sha256()
for f in sorted(p.rglob('*')):
    if f.is_file():h.update((str(f.relative_to(p))+'\0'+hashlib.sha256(f.read_bytes()).hexdigest()+'\n').encode())
for name in ['build.mjs','test.mjs']:h.update((name+'\0'+hashlib.sha256((root/name).read_bytes()).hexdigest()+'\n').encode())
digest=h.hexdigest();c=json.loads((root/'source-contract.json').read_text());c.update(stage=str(root),predecessor=str(base),sourceSha256=digest,payloadSha256=digest,capturedAtEpoch=time.time());(root/'source-contract.json').write_text(json.dumps(c,indent=2)+'\n')
state=json.loads((ops/'state.json').read_text());state.update(phase='fast-account-quota-build',sourceSha256=digest,release='fleet-20261016-'+digest[:12],stage=str(root),baseline='/mnt/hdd/code-ai-builds/fleet-20261016-7a00082e7f9c',sourceBaseline=str(base/'payload'),expectedSelectedSuites=43);(ops/'state.json').write_text(json.dumps(state,indent=2)+'\n')
print(json.dumps(dict(sourceSha256=digest,accountOnlyTestPassed=True)))
