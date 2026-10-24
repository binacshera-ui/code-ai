from pathlib import Path
import json,hashlib,shutil,tarfile,os
ops=Path('/root/projects/code-ai/ops/codex-0163-upgrade-20261016')
j=json.loads((ops/'build-result.json').read_text());assert j['buildId']=='2b73fb76-d311-4679-8c04-91a1cbabd059' and j['attestation']['status']=='QUALIFIED'
a=Path(j['artifact'])
if not (a/'release.json').exists():a=a/'dist'
m=json.loads((a/'release-files.json').read_text());release=json.loads((a/'release.json').read_text())
assert release['version']=='fleet-20261016-5968fec9d003' and release['expectedCodexVersion']=='0.163.0'
dest=Path('/mnt/hdd/code-ai-builds')/release['version'];assert not dest.exists();dest.mkdir(mode=0o755)
for name,expected in m['files'].items():
 assert not Path(name).is_absolute() and '..' not in Path(name).parts
 assert hashlib.sha256((a/name).read_bytes()).hexdigest()==expected,'Qualified artifact changed: '+name
 p=dest/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o755);shutil.copyfile(a/name,p);p.chmod(0o644)
shutil.copyfile(a/'release-files.json',dest/'release-files.json');(dest/'release-files.json').chmod(0o644)
archive=ops/(release['version']+'.tgz');assert not archive.exists()
with tarfile.open(archive,'w:gz') as tar:
 for name in [*sorted(m['files']),'release-files.json']:tar.add(dest/name,arcname=name,recursive=False)
tests=json.loads((dest/'qualification/fleet-tests.json').read_text());assert tests['passed'] and all(x['passed'] for x in tests['results'])
receipt={'buildId':j['buildId'],'qualified':True,'release':release,'candidate':str(dest),'filesVerified':len(m['files']),'selectedSuitesPassed':len(tests['results']),'archive':str(archive),'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'artifactCodeChangedAfterQualification':False}
(ops/'qualified-export.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
