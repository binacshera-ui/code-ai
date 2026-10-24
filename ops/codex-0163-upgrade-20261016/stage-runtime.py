from pathlib import Path
import urllib.request,json,hashlib,base64,tarfile,subprocess,os,time
os.umask(0o022)
version='0.163.0';expected='399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215'
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else '/opt/code-ai-tools')/('codex-'+version+'-'+expected[:12])
metadata=json.load(urllib.request.urlopen('https://registry.npmjs.org/@openai%2fcodex/'+version+'-linux-x64',timeout=30))
assert metadata['name']=='@openai/codex' and metadata['version']==version+'-linux-x64'
integrity=metadata['dist']['integrity'];assert integrity.startswith('sha512-')
url=metadata['dist']['tarball'];assert url.startswith('https://registry.npmjs.org/@openai/codex/-/')
root.mkdir(parents=True,exist_ok=True)
archive=root/'official-platform.tgz'
if not archive.exists():
 with urllib.request.urlopen(url,timeout=60) as source, (root/'official-platform.tgz.partial').open('wb') as target:
  while True:
   data=source.read(1024*1024)
   if not data:break
   target.write(data)
 (root/'official-platform.tgz.partial').replace(archive)
assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()==integrity.split('-',1)[1]
native=root/'package/vendor/x86_64-unknown-linux-musl/bin/codex'
if not native.exists():
 with tarfile.open(archive,'r:gz') as tar:
  for m in tar.getmembers():
   assert m.isfile() or m.isdir()
   assert not Path(m.name).is_absolute() and '..' not in Path(m.name).parts and m.name.startswith('package/')
  tar.extractall(root,filter='data')
assert hashlib.sha256(native.read_bytes()).hexdigest()==expected
assert subprocess.check_output([str(native),'--version'],text=True).strip()=='codex-cli '+version
files=list((root/'package').rglob('*'))
assert any(p.is_file() and p.name=='codex-code-mode-host' for p in files)
assert any(p.is_file() and p.name=='rg' for p in files)
receipt={'version':version,'nativeBinary':str(native),'nativeBinarySha256':expected,'source':url,'officialIntegritySha512Matched':True,'completePlatformPackage':True,'fileCount':sum(p.is_file() for p in files),'installedAtEpoch':time.time(),'globalNpmInstallationModified':False}
(root/'installation-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
