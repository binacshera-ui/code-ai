from pathlib import Path
import json,os,sys,subprocess,hashlib,time,fcntl,socket,errno,stat,collections,datetime
os.umask(0o077)
c=json.loads(Path(sys.argv[1]).read_text());ops=Path(c['ops']);ops.mkdir(parents=True,exist_ok=True)
backup=Path('/root/.code-ai/maintenance/codex-0163-upgrade-20261016')/c['id']
backup.mkdir(parents=True,exist_ok=False)
expected='399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215'
oldsha='628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1'
native=Path(c['native']);assert hashlib.sha256(native.read_bytes()).hexdigest()==expected
r={'host':c['id'],'startedAtEpoch':time.time(),'phase':'preparing','nativeVersion':'0.163.0','targetApplicationRelease':c['release'],'applicationActivationPending':True,'retiredEndpoints':[]}
def save(): (ops/'upgrade-receipt.json').write_text(json.dumps(r,indent=2)+'\n')
def run(args,env=None,timeout=90):
 p=subprocess.run(args,capture_output=True,text=True,env=env,timeout=timeout)
 if p.returncode:raise RuntimeError('Command failed: '+args[0]+' exit '+str(p.returncode))
 return p.stdout.strip()
def ctl(*args):return run(['systemctl',*args])
def environment(pid):return dict(s.split('=',1) for s in Path('/proc',str(pid),'environ').read_text().split('\0') if '=' in s)
pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2'
pm2env={**os.environ,'PATH':'/root/.nvm/versions/node/v24.12.0/bin:'+os.environ.get('PATH',''),'HOME':'/root','PM2_HOME':'/root/.pm2'}
def core_pid():
 if c['id']=='main':return next(x['pid'] for x in json.loads(run([pm2,'jlist'],pm2env)) if x['name']=='code-ai-app')
 return int(ctl('show',c['core'],'-p','MainPID','--value'))
def stop_core():
 if c['id']=='main':run([pm2,'stop','code-ai-app'],pm2env)
 else:ctl('stop',c['core'])
def start_core():
 if c['id']=='main':run([pm2,'restart','code-ai-app','--update-env'],{**pm2env,**original_env,'CODEX_BIN':str(native),'CODEX_TERMINAL_BIN':str(native),'CODEX_CLI_PATH':str(native)})
 else:ctl('start',c['core'])
def dead(pid,identity):
 try:
  f=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()
  return f[0]=='Z' or f[19]!=identity['startTime']
 except FileNotFoundError:return True
def identity(p,record):
 s=p.lstat();return all(str(getattr(s,'st_'+k))==record[k] for k in ['dev','ino','uid'])
def no_listener(filename):
 assert not any(line.rstrip().endswith(' '+filename) for line in Path('/proc/net/unix').read_text().splitlines()),'Endpoint still used'
 s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(1)
 try:code=s.connect_ex(filename)
 finally:s.close()
 assert code in [errno.ENOENT,errno.ECONNREFUSED],'Endpoint live or uncertain'
def retire(filename,record):
 p=Path(filename)
 no_listener(filename)
 if not os.path.lexists(p):return
 assert record and identity(p,record),'Endpoint identity changed'
 dest=p.with_name(p.name+'.retired-codex0163-20261016');assert not os.path.lexists(dest)
 p.rename(dest);r['retiredEndpoints'].append({'from':str(p),'to':str(dest)})
queue=Path(c['queue']);plans=[];held=[];core_stopped=False
try:
 assert run([str(native),'--version'])=='codex-cli 0.163.0'
 if c.get('serviceUser'):assert run(['runuser','-u',c['serviceUser'],'--',str(native),'--version'])=='codex-cli 0.163.0'
 original_env=environment(core_pid())
 original_auth={k:v for k,v in original_env.items() if any(s in k for s in ['PASSWORD','SECRET','TOKEN','API_KEY','AUTH_BASELINE'])}
 before=json.loads(queue.read_text());(backup/'queue-before.json').write_bytes(queue.read_bytes())
 r['queueBefore']=dict(collections.Counter(i['status'] for i in before['items']))
 for profile,home in c['profiles'].items():
  f=Path(home)/'code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';p=json.loads(f.read_text());assert p['nativeBinarySha256']==oldsha and p['profileId']==profile
  (backup/(profile+'-plan-before.json')).write_bytes(f.read_bytes())
  assert hashlib.sha256(Path(p['brokerModule']).read_bytes()).hexdigest()==p['brokerModuleSha256']
  lock=Path(p['ownerDirectory'])/'owner.lock';ls=lock.stat()
  plans.append({'profile':profile,'file':f,'plan':p,'unit':'code-ai-native-owner-'+profile+'.service','lock':lock,'lockIdentity':(ls.st_dev,ls.st_ino),'stat':f.stat()})
 r['phase']='stopping-core';save();stop_core();core_stopped=True
 (backup/'queue-after-core-stop.json').write_bytes(queue.read_bytes())
 r['phase']='stopping-native-owners';save()
 for x in plans:ctl('stop',x['unit'])
 for x in plans:
  handle=x['lock'].open('r+');fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);held.append(handle)
  assert (x['lock'].stat().st_dev,x['lock'].stat().st_ino)==x['lockIdentity']
  p=x['plan'];d=Path(p['ownerDirectory']);recordfile=d/'ownership.json';record=json.loads(recordfile.read_text())
  assert record['profileId']==x['profile'] and record['nativeBinarySha256']==oldsha
  assert dead(record['runnerPid'],record['runnerIdentity']) and dead(record['nativePid'],record['nativeIdentity']),'Old writer survived stop'
  (backup/(x['profile']+'-custody-before.json')).write_bytes(recordfile.read_bytes())
  if record['backend'].get('kind')=='native-alias':
   target=record['backend']['target'];assert Path(target['path']).parent.name=='codex-daemon-'+record['backend']['uid']
   if os.path.lexists(target['path']):
    assert identity(Path(target['path']).parent,target['parent'])
   retire(target['path'],target)
  retire(record['backendSocket'],record['backend']);retire(record['frontendSocket'],record.get('frontend'))
  for name in ['ownership.json','ready.json','broker-handoff.json']:
   f=d/name
   if f.exists():f.rename(backup/(x['profile']+'-retired-'+name))
  previous=json.loads(json.dumps(p));release=Path(c['release'])
  p.update(nativeBinary=str(native),nativeBinarySha256=expected,brokerModule=str(release/'server/codexSharedOwnerBroker.mjs'),brokerModuleSha256=hashlib.sha256((release/'server/codexSharedOwnerBroker.mjs').read_bytes()).hexdigest(),dispatcherModule=str(release/'scripts/codex-shared-cli.mjs'),adapterModule=str(release/'scripts/codex-shared-stdio.mjs'),runnerModule=str(release/'ops/native-owner/profile-runner.mjs'),guiLauncherModule=str(release/'ops/native-owner/gui-launcher.mjs'))
  for d in p.get('mcpDispatchers',[]):d['args'][0]=str(release/'server/codex-shared-modes/mcp.mjs')
  public_fields=['nativeBinary','nativeBinarySha256','brokerModule','brokerModuleSha256','dispatcherModule','adapterModule','runnerModule','guiLauncherModule','mcpDispatchers']
  assert all(p[k]==v for k,v in previous.items() if k not in public_fields)
  for original,updated in zip(previous.get('mcpDispatchers',[]),p.get('mcpDispatchers',[])):
   assert {k:v for k,v in original.items() if k!='args'}=={k:v for k,v in updated.items() if k!='args'} and original['args'][1:]==updated['args'][1:]
  f=x['file'];temp=f.with_name(f.name+'.upgrade-0163');temp.write_text(json.dumps(p,indent=2)+'\n');os.chmod(temp,stat.S_IMODE(x['stat'].st_mode));os.chown(temp,x['stat'].st_uid,x['stat'].st_gid);temp.replace(f)
  drop=Path('/etc/systemd/system')/(x['unit']+'.d')/'zzzzzzzzzzzzzz-codex-0163-20261016.conf';assert not drop.exists();drop.write_text('[Service]\nExecStart=\nExecStart="'+p['nodeBinary']+'" "'+p['runnerModule']+'" "'+str(f)+'"\nEnvironment="CODEX_CLI_PATH='+str(native)+'"\n')
 if c['id']!='main':
  envfile=ops/'runtime-native.env';envfile.write_text('CODEX_BIN='+str(native)+'\nCODEX_TERMINAL_BIN='+str(native)+'\nCODEX_CLI_PATH='+str(native)+'\n')
  drop=Path('/etc/systemd/system')/(c['core']+'.d')/'zzzzzzzzzzzzzz-codex-0163-20261016.conf';assert not drop.exists();drop.write_text('[Service]\nEnvironmentFile='+str(envfile)+'\n')
 r['phase']='starting-native-0163';save();ctl('daemon-reload')
 for handle in held:fcntl.flock(handle,fcntl.LOCK_UN);handle.close()
 held=[]
 for x in plans:ctl('start',x['unit'])
 until=time.monotonic()+60
 while True:
  ready=[]
  for x in plans:
   try:
    j=json.loads((Path(x['plan']['ownerDirectory'])/'ready.json').read_text());good=j['profileVerified'] and j['nativeBinarySha256']==expected and j['brokerModuleSha256']==x['plan']['brokerModuleSha256'] and os.readlink('/proc/'+str(j['nativePid'])+'/exe')==str(native)
    if good:x['nativePid']=j['nativePid']
    ready.append(good)
   except (FileNotFoundError,json.JSONDecodeError,KeyError):ready.append(False)
  if all(ready):break
  if time.monotonic()>until:raise RuntimeError('0.163 native owner readiness deadline')
  time.sleep(.25)
 if c.get('publicCli'):
  link=Path(c['publicCli']);assert link.is_symlink() and run([str(link),'--version'])=='codex-cli 0.162.1'
  (backup/'public-cli-before.json').write_text(json.dumps({'path':str(link),'target':os.readlink(link)})+'\n')
  temp=link.with_name(link.name+'.upgrade-0163');assert not os.path.lexists(temp);temp.symlink_to(native);temp.replace(link)
  assert run([str(link),'--version'])=='codex-cli 0.163.0';r['publicCliUpdated']=True
 r['phase']='starting-core';save();start_core();core_stopped=False
 until=time.monotonic()+30
 while True:
  pid=core_pid();actual=environment(pid)
  if all(actual.get(k)==str(native) for k in ['CODEX_BIN','CODEX_TERMINAL_BIN','CODEX_CLI_PATH']):break
  if time.monotonic()>until:raise RuntimeError('Core runtime environment deadline')
  time.sleep(.25)
 assert all(actual.get(k)==v for k,v in original_auth.items()),'Authentication changed'
 if c['id']=='main':run([pm2,'save'],pm2env)
 if c['id']=='beam-10g':assert ctl('show',c['core'],'-p','PrivateTmp','--value')=='yes'
 after=json.loads(queue.read_text());ids={i['id'] for i in after['items']};missing=[i for i in before['items'] if i['id'] not in ids]
 for i in missing:
  assert i['status'] in ['completed','failed','cancelled'],'Active queue item lost'
  timestamp=i.get('updatedAt') or i.get('createdAt');assert datetime.datetime.fromisoformat(timestamp.replace('Z','+00:00')).timestamp()<time.time()-21*86400,'Recent queue item lost'
 for x in plans:assert (x['lock'].stat().st_dev,x['lock'].stat().st_ino)==x['lockIdentity']
 r.update(phase='upgraded-awaiting-acceptance',mainPid=pid,nativeBinary=str(native),authenticationValuesPreserved=True,authenticationFieldsCompared=len(original_auth),ownerLockInodesPreserved=True,profileSettingsPreserved=True,nonterminalAndRecentQueueItemIdsPreserved=True,expiredTerminalQueueItemsRetiredByExistingPolicy=len(missing),privateBackup=str(backup),profiles=[{'id':x['profile'],'nativePid':x['nativePid'],'nativeVersion':run(['/proc/'+str(x['nativePid'])+'/exe','--version'])} for x in plans],finishedAtEpoch=time.time());save();print(json.dumps(r))
except Exception as e:
 r.update(failed=True,errorType=type(e).__name__,reason=str(e),phaseFailed=r['phase']);save();print(json.dumps({'failed':True,'host':c['id'],'phase':r['phase'],'errorType':type(e).__name__,'reason':str(e)}));raise SystemExit(1)
finally:
 for handle in held:handle.close()
