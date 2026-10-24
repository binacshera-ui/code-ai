from pathlib import Path
import json,os,sys,hashlib,subprocess,time,socket,stat
root=Path(sys.argv[1]);h=json.loads((root/'fleet-host.json').read_text());id=h['id'];user=id=='ubuntu-gpu-lab';ctl=['systemctl']+(['--user'] if user else [])
assert socket.gethostname()==h['host'] and os.getuid()==(1000 if user else 0)
backup=root/('private-owner-backup-r2' if id=='main' else 'private-owner-backup');backup.mkdir(mode=0o700,exist_ok=False)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args,env=None,check=True):
 r=subprocess.run(args,text=True,capture_output=True,env=env,timeout=100)
 if check and r.returncode:raise RuntimeError('Command failed: '+args[0]+' '+str(r.returncode))
 return r.stdout.strip()
def ctlrun(*args,**kw):return run(ctl+list(args),**kw)
pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2'
core={'beam-10g':'code-ai-remote-beam-10g.service','pci':'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'}.get(id)
profiles=h['sharedProfiles'].split(',');plans=[];oldunits={};overrides=[];moved=[]
for profile in profiles:
 if profile in ['developer','developer2']: home=Path('/home')/profile
 elif profile=='beam-root':home=Path('/root')
 elif profile=='beam-admin':home=Path('/home/beamadmin')
 elif profile=='pci-admin':home=Path('/srv/beam254/code-ai-native/home')
 elif profile=='ubuntu-refael':home=Path('/home/refael')
 else:raise RuntimeError('Unknown profile')
 planfile=home/'code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';oldbytes=planfile.read_bytes();p=json.loads(oldbytes);s=planfile.stat();unit='code-ai-native-owner-'+profile+'.service'
 assert p['profileId']==profile
 (backup/(profile+'-plan.json')).write_bytes(oldbytes);os.chmod(backup/(profile+'-plan.json'),0o600)
 custody=Path(p['ownerDirectory'])/'ownership.json';record=json.loads(custody.read_text())
 (backup/(profile+'-ownership.json')).write_bytes(custody.read_bytes());os.chmod(backup/(profile+'-ownership.json'),0o600)
 lock=Path(p['ownerDirectory'])/'owner.lock';lockidentity=(lock.stat().st_dev,lock.stat().st_ino)
 oldunits[unit]=ctlrun('cat',unit)
 (backup/(profile+'-unit.txt')).write_text(oldunits[unit]);os.chmod(backup/(profile+'-unit.txt'),0o600)
 plans.append(dict(profile=profile,path=planfile,oldbytes=oldbytes,plan=p,record=record,stat=s,unit=unit,lock=lock,lockidentity=lockidentity))
# Preserve entire queue before any stop, without printing prompts or credentials.
queue=Path({'main':'/root/projects/code-ai/.code-ai/queue/state.json','beam-10g':'/var/lib/code-ai-remote/beam-10g/queue/state.json','pci':'/var/lib/code-ai-pci/queue/state.json','ubuntu-gpu-lab':'/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json'}[id])
if queue.exists():(backup/'queue-before.json').write_bytes(queue.read_bytes());os.chmod(backup/'queue-before.json',0o600)
oldenv=None
if id=='main':
 rec=next(x for x in json.loads(run([pm2,'jlist'])) if x['name']=='code-ai-app');oldenv=dict(rec['pm2_env']['env']);pid=rec['pid']
 for part in (Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\0') if pid>1 else []):
  if b'=' in part:
   k,v=part.split(b'=',1)
   if k.decode() not in ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_UNIQUE_ID']:oldenv[k.decode()]=v.decode()
 ctlrun('stop','code-ai-upload-api.service');run([pm2,'stop','code-ai-app'])
else:ctlrun('stop',core)
print(json.dumps({'id':id,'phase':'core-stopped','profiles':profiles}),flush=True)
for x in plans:ctlrun('stop',x['unit'])
def generation_dead(pid,identity):
 p=Path('/proc')/str(pid)
 try:
  status=(p/'status').read_text()
  if any(line.startswith('State:') and '\tZ' in line for line in status.splitlines()):return True
  fields=(p/'stat').read_text().rsplit(') ',1)[1].split();return fields[19]!=identity['startTime']
 except FileNotFoundError:return True

def identity_matches(p,entry):
 s=p.lstat();return str(s.st_dev)==entry['dev'] and str(s.st_ino)==entry['ino'] and str(s.st_uid)==entry['uid']
def no_listener(filename):
 # Any remaining listener or accepted socket makes retirement uncertain.
 return not any(line.rstrip().endswith(' '+filename) for line in Path('/proc/net/unix').read_text().splitlines())
def retire(filename,recorded,alias=False):
 p=Path(filename)
 if not os.path.lexists(p):return
 assert identity_matches(p,recorded),'Endpoint changed'
 assert no_listener(filename),'Endpoint still used'
 dest=p.with_name(p.name+'.retired-fleet-20261014-r7')
 assert not os.path.lexists(dest)
 p.rename(dest);moved.append([str(p),str(dest)])
try:
 for x in plans:
  p=x['plan'];r=x['record'];assert generation_dead(r['runnerPid'],r['runnerIdentity']) and generation_dead(r['nativePid'],r['nativeIdentity']),'Native survived stop'
  assert (x['lock'].stat().st_dev,x['lock'].stat().st_ino)==x['lockidentity']
  if r['backend'].get('kind')=='native-alias':
   target=r['backend']['target'];assert no_listener(target['path']),'Native socket still held';retire(target['path'],target)
  retire(r['backendSocket'],r['backend'],True)
  if r.get('frontend'):retire(r['frontendSocket'],r['frontend'])
  for f in ['ownership.json','ready.json','broker-handoff.json']:
   q=Path(p['ownerDirectory'])/f
   if q.exists():
    retired=Path(p['ownerDirectory'])/'fleet-previous-20261014-r7';retired.mkdir(mode=0o700,exist_ok=True)
    dst=retired/f;assert not dst.exists()
    # The custody snapshot is already in backup; preserve the original inode separately.
    if dst.exists():raise RuntimeError('Retired record already present')
    q.rename(dst);moved.append([str(q),str(dst)])
  p.update(nativeBinary=h['terminalNativeBinary'],nativeBinarySha256=sha(h['terminalNativeBinary']),brokerModule=str(root/'server/codexSharedOwnerBroker.mjs'),brokerModuleSha256=sha(root/'server/codexSharedOwnerBroker.mjs'),dispatcherModule=str(root/'scripts/codex-shared-cli.mjs'),adapterModule=str(root/'scripts/codex-shared-stdio.mjs'),runnerModule=str(root/'ops/native-owner/profile-runner.mjs'),guiLauncherModule=str(root/'ops/native-owner/gui-launcher.mjs'))
  for d in p.get('mcpDispatchers',[]):d['args'][0]=str(root/'server/codex-shared-modes/mcp.mjs')
  temp=x['path'].with_name(x['path'].name+'.fleet');temp.write_text(json.dumps(p,indent=2));os.chmod(temp,stat.S_IMODE(x['stat'].st_mode));os.chown(temp,x['stat'].st_uid,x['stat'].st_gid);temp.replace(x['path'])
  fragment=Path(ctlrun('show',x['unit'],'-p','FragmentPath','--value'));folder=Path(str(fragment)+'.d');folder.mkdir(parents=True,exist_ok=True)
  override=folder/'zzzzzzzzzzzz-fleet-r7-20261014.conf';assert not override.exists()
  override.write_text('[Service]\nExecStart=\nExecStart="'+p['nodeBinary']+'" "'+p['runnerModule']+'" "'+str(x['path'])+'"\nKillMode=control-group\nRestart=on-failure\nEnvironment="CODEX_CLI_PATH='+p['nativeBinary']+'"\nEnvironment="CODE_AI_BROWSER_PYTHON='+h['python']+'"\n')
  os.chmod(override,0o600);overrides.append(str(override))
 if core:
  fragment=Path(ctlrun('show',core,'-p','FragmentPath','--value'));folder=Path(str(fragment)+'.d');folder.mkdir(parents=True,exist_ok=True)
  override=folder/'zzzzzzzzzzzz-fleet-r7-python-20261014.conf';assert not override.exists();override.write_text('[Service]\nEnvironment="CODE_AI_BROWSER_PYTHON='+h['python']+'"\n');os.chmod(override,0o600);overrides.append(str(override))
 ctlrun('daemon-reload')
 for x in plans:ctlrun('start',x['unit'])
 deadline=time.monotonic()+60
 while True:
  ready=[]
  for x in plans:
   try:
    r=json.loads((Path(x['plan']['ownerDirectory'])/'ready.json').read_text());ready.append(r['nativeBinarySha256']==x['plan']['nativeBinarySha256'] and r['brokerModuleSha256']==x['plan']['brokerModuleSha256'] and r['profileVerified'])
   except (FileNotFoundError,json.JSONDecodeError):ready.append(False)
  if all(ready):break
  if time.monotonic()>deadline:raise RuntimeError('Owner readiness deadline exceeded')
  time.sleep(.5)
 if id=='main':
  env={**oldenv,'CODE_AI_BROWSER_PYTHON':h['python']};run([pm2,'restart','code-ai-app','--update-env'],env);ctlrun('start','code-ai-upload-api.service');run([pm2,'save'])
 else:ctlrun('start',core)
 receipt={'id':id,'ownerRelease':str(root),'profiles':profiles,'nativeVersion':run([h['terminalNativeBinary'],'--version']),'previousProcessesStopped':True,'ownerLockInodesPreserved':True,'queueHistoryPreserved':True,'python':h['python'],'retiredEndpoints':moved,'overrides':overrides,'finishedAt':time.time()}
 (root/'owner-update-receipt.json').write_text(json.dumps(receipt,indent=2));os.chmod(root/'owner-update-receipt.json',0o600)
 print(json.dumps({k:v for k,v in receipt.items() if k not in ['retiredEndpoints','overrides']}),flush=True)
except Exception as e:
 # Keep exact failure evidence and originals; do not start a second writer or unlink locks.
 (root/'owner-update-failure.json').write_text(json.dumps({'id':id,'errorType':type(e).__name__,'message':str(e),'moved':moved,'overrides':overrides},indent=2));os.chmod(root/'owner-update-failure.json',0o600)
 print(json.dumps({'id':id,'phase':'owner-update-failed','errorType':type(e).__name__,'reason':str(e)}),flush=True)
 raise
