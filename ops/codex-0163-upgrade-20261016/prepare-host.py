from pathlib import Path
import json,os,sys,hashlib,time,subprocess
os.umask(0o022)
c=json.loads(Path(sys.argv[1]).read_text());r=Path(c['release']);b=Path(c['baseline'])
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest=json.loads((r/'release-files.json').read_text())
for name,digest in manifest['files'].items():
 assert not Path(name).is_absolute() and '..' not in Path(name).parts
 assert sha(r/name)==digest,'Artifact file changed: '+name
release=json.loads((r/'release.json').read_text());assert release['version']=='fleet-20261016-5968fec9d003' and release['expectedCodexVersion']=='0.163.0'
assert not (r/'node_modules').exists();(r/'node_modules').symlink_to((b/'node_modules').resolve())
# Installation mode for the newly shipped executable adapter; no existing permissions change.
(r/'scripts/codex-shared-cli.mjs').chmod(0o755)
if (b/'.remote-agent.env').exists():(r/'.remote-agent.env').symlink_to((b/'.remote-agent.env').resolve())
request=json.loads((b/'fleet-request.json').read_text());host=json.loads((b/'fleet-host.json').read_text())
request.update(candidate=str(r),baseline=str(b),buildId='2b73fb76-d311-4679-8c04-91a1cbabd059',releaseOrder='1792132680000',attemptId='codex-0163-20261016',ownerAuthorizedInterruption=True,terminalNativeBinary=c['native'],terminalNativeBinarySha256=sha(c['native']),expectedBaselineSha256=sha(b/'dist/server.js'),expectedServerSha256=sha(r/'dist/server.js'),expectedAppSha256=sha(r/'dist/app.mjs'))
if c['id']=='main':request.update(uploadBaselineModule=str(b/'dist/server.js'),uploadBaselineSha256=sha(b/'dist/server.js'))
host.update(terminalNativeBinary=c['native'],candidate=str(r))
for name,data in [('fleet-request.json',request),('fleet-host.json',host)]:
 p=r/name;p.write_text(json.dumps(data,indent=2)+'\n');p.chmod(0o600)
receipt={'host':c['id'],'release':release,'allQualifiedManifestFilesMatched':True,'manifestFiles':len(manifest['files']),'externalDependenciesReusedFrom':str((b/'node_modules').resolve()),'adapterExecutable':os.access(r/'scripts/codex-shared-cli.mjs',os.X_OK),'existingCredentialFilesChanged':False,'preparedAtEpoch':time.time()}
(r/'installation-readiness.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
