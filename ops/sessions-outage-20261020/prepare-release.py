from pathlib import Path
import json, os, hashlib, time, shutil, subprocess, difflib

os.umask(0o022)
ops=Path('/root/projects/code-ai/ops/sessions-outage-20261020')
state=json.loads((ops/'state.json').read_text())
stage=Path(state['stage'])
result=json.loads((ops/'build-result.json').read_text())
assert result['attestation']['status']=='QUALIFIED', result['attestation'].get('status')
artifact=Path(result['artifact'])/'dist'
baseline=Path(state.get('baseline','/mnt/hdd/code-ai-builds/fleet-20261016-5968fec9d003'))
candidate=Path('/mnt/hdd/code-ai-builds')/state['release']
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest=json.loads((artifact/'release-files.json').read_text())
assert not candidate.exists(), 'Candidate already exists; inspect before repeating'
candidate.mkdir(mode=0o755)
for name,digest in manifest['files'].items():
    assert not Path(name).is_absolute() and '..' not in Path(name).parts
    assert sha(artifact/name)==digest
    dest=candidate/name; dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(artifact/name,dest);dest.chmod(0o644)
shutil.copyfile(artifact/'release-files.json',candidate/'release-files.json')
release=json.loads((candidate/'release.json').read_text())
assert release['version']==state['release'] and release['expectedCodexVersion']=='0.163.0'
tests=json.loads((candidate/'qualification/fleet-tests.json').read_text())
assert tests['passed'] and len(tests['results'])==state['expectedSelectedSuites']
assert all(t['passed'] for t in tests['results'])
(candidate/'node_modules').symlink_to((baseline/'node_modules').resolve())
(candidate/'scripts/codex-shared-cli.mjs').chmod(0o755)
request=json.loads((baseline/'fleet-request.json').read_text())
host=json.loads((baseline/'fleet-host.json').read_text())
native=request['terminalNativeBinary']
assert sha(native)=='399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215'
broker='server/codexSharedOwnerBroker.mjs'
assert sha(candidate/broker)==sha(baseline/broker), 'Owner compatibility changed; further qualification required'
request.update(candidate=str(candidate),baseline=str(baseline),buildId=result['buildId'],releaseOrder=str(int(time.time()*1000)),attemptId='sessions-recovery-20261020',ownerAuthorizedInterruption=True,expectedBaselineSha256=sha(baseline/'dist/server.js'),expectedServerSha256=sha(candidate/'dist/server.js'),expectedAppSha256=sha(candidate/'dist/app.mjs'),uploadBaselineModule=str(baseline/'dist/server.js'),uploadBaselineSha256=sha(baseline/'dist/server.js'))
host['candidate']=str(candidate)
for name,data in [('fleet-request.json',request),('fleet-host.json',host)]:
    f=candidate/name;f.write_text(json.dumps(data,indent=2)+'\n');f.chmod(0o600)
proof=dict(release=release,buildId=result['buildId'],manifestFilesVerified=len(manifest['files']),selectedSuitesPassed=len(tests['results']),nativeVersion='0.163.0',ownerBrokerUnchanged=True,ownerRestartRequired=False,scope='Germany Core/UI/account lifecycle only')
(candidate/'installation-readiness.json').write_text(json.dumps(proof,indent=2)+'\n')
(ops/'prepared-release.json').write_text(json.dumps(proof,indent=2)+'\n')

# Backport exactly this qualified change, preserving the dirty working tree.
base=Path(state.get('sourceBaseline','/mnt/hdd/code-ai-builds/codex-0163-source-20261016/payload'))
live=Path('/root/projects/code-ai')
def drift_edits(a,b):
    aa=a.splitlines(True);bb=b.splitlines(True)
    return [(tag,aa[i:j],bb[k:l]) for tag,i,j,k,l in difflib.SequenceMatcher(None,aa,bb).get_opcodes() if tag!='equal']
changed=[];patch=[];live_before={};drift_before={}
for f in sorted((stage/'payload').rglob('*')):
    if not f.is_file():continue
    name=str(f.relative_to(stage/'payload'));old=base/name
    if old.exists() and old.read_bytes()==f.read_bytes():continue
    if not old.exists():assert not (live/name).exists(), 'New source path already exists: '+name
    else:
        assert (live/name).is_file()
        live_before[name]=(live/name).read_bytes()
        drift_before[name]=drift_edits(old.read_text(),(live/name).read_text())
    changed.append(name)
    patch.extend(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],f.read_text().splitlines(True),fromfile='a/'+name if old.exists() else '/dev/null',tofile='b/'+name))
patchfile=ops/'qualified-source.patch';patchfile.write_text(''.join(patch))
subprocess.run(['git','apply','--check',str(patchfile)],cwd=live,check=True)
backup=Path('/root/.code-ai/maintenance/sessions-read-source-backup-20261020-'+state['sourceSha256'][:12])
backup.mkdir(mode=0o700)
for name in changed:
    if not (live/name).exists():continue
    dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(live/name,dest)
assert all((live/n).read_bytes()==data for n,data in live_before.items()), 'Concurrent source edits detected'
subprocess.run(['git','apply',str(patchfile)],cwd=live,check=True)
for name in changed:
    if name in drift_before:assert drift_edits((stage/'payload'/name).read_text(),(live/name).read_text())==drift_before[name], 'Unrelated edits changed: '+name
    else:assert (live/name).read_bytes()==(stage/'payload'/name).read_bytes()
(ops/'source-backport.json').write_text(json.dumps(dict(files=changed,privateBackup=str(backup),unrelatedEditsPreserved=True),indent=2)+'\n')
print(json.dumps(proof))
