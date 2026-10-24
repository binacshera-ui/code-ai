from pathlib import Path
import json,hashlib,time,subprocess,os,tempfile
root=Path('/mnt/hdd/code-ai-builds/auth-cycle-source-20261016');p=root/'payload'
f=p/'server/codexQueue.drafts.test.ts';s=f.read_text()
old="  await assert.rejects(queue.retryCodexQueueItem('confirmed-cancelled'), /same message identity/);"
new="""  const confirmed = await queue.getCodexQueueItem('confirmed-cancelled');
  const retried = await queue.retryCodexQueueItem('confirmed-cancelled');
  assert.notEqual(retried.id, 'confirmed-cancelled');
  assert.equal(retried.retryOfItemId, 'confirmed-cancelled');
  assert.equal(retried.nativeSubmission, null);
  assert.deepEqual(await queue.getCodexQueueItem('confirmed-cancelled'), confirmed);"""
assert s.count(old)==1
f.write_text(s.replace(old,new))
ops=Path('/root/projects/code-ai/ops/auth-cycle-repair-20261016')
node='/root/.nvm/versions/node/v24.12.0/bin/node'
# Compile through the installed toolchain without adding dependencies to source.
tmp=Path(tempfile.mkdtemp(prefix='auth-cycle-drafts-',dir='/mnt/hdd/code-ai-builds'))
(tmp/'node_modules').symlink_to(Path('/root/projects/code-ai/node_modules').resolve())
js="""import{createRequire}from'node:module';const{build}=createRequire('/root/projects/code-ai/package.json')('esbuild');await build({absWorkingDir:process.argv[1],entryPoints:['server/codexQueue.drafts.test.ts'],outfile:process.argv[2],bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});"""
subprocess.run([node,'--input-type=module','-e',js,str(p),str(tmp/'test.mjs')],check=True)
env={**os.environ,'CODEX_APP_ROOT':str(p),'CODEX_STORAGE_ROOT':str(tmp/'state'),'CODEX_QUEUE_DISABLE_EXECUTION':'1','CODEX_DEVICE_ADMIN_PASSWORD':'isolated-test-only','SESSION_SECRET':'isolated-test-only'}
with (ops/'drafts-corrected-unit.log').open('w') as log:
    subprocess.run([node,'--test',str(tmp/'test.mjs')],cwd=p,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
h=hashlib.sha256()
for f in sorted(p.rglob('*')):
    if f.is_file():h.update((str(f.relative_to(p))+'\0'+hashlib.sha256(f.read_bytes()).hexdigest()+'\n').encode())
for name in ['build.mjs','test.mjs']:h.update((name+'\0'+hashlib.sha256((root/name).read_bytes()).hexdigest()+'\n').encode())
digest=h.hexdigest();c=json.loads((root/'source-contract.json').read_text());c.update(sourceSha256=digest,payloadSha256=digest,capturedAtEpoch=time.time());(root/'source-contract.json').write_text(json.dumps(c,indent=2)+'\n')
(ops/'state.json').write_text(json.dumps(dict(phase='qualified-build-final',sourceSha256=digest,release='fleet-20261016-'+digest[:12],stage=str(root),expectedSelectedSuites=42,priorFailedBuilds=['9d805353-8cbe-49f7-afc8-3c9b8e3c144b','54792479-0229-4bb8-8e2a-912217cbd455'],correction='Existing confirmed-cancelled retry assertion now checks fresh identity and unchanged parent; uncertain native custody is still forbidden; all six draft tests passed directly'),indent=2)+'\n')
print(json.dumps(dict(sourceSha256=digest,draftTestsPassed=True)))
