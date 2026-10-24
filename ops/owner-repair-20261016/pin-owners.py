from pathlib import Path
import os,json,subprocess,hashlib,time,sys
os.umask(0o077)
host=sys.argv[1];profiles=json.loads(sys.argv[2]);expected='628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1'
native=Path('/opt/code-ai-tools/codex-0.162.1-'+expected[:12]+'/package/vendor/x86_64-unknown-linux-musl/bin/codex')
assert hashlib.sha256(native.read_bytes()).hexdigest()==expected
backup=Path('/root/.code-ai/maintenance/owner-repair-20261016')/host;backup.mkdir(parents=True,exist_ok=True)
rows=[]
for profile,home in profiles.items():
 planfile=Path(home)/'code-ai-native-owner/profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json';plan=json.loads(planfile.read_text());assert plan['profileId']==profile and plan['nativeBinarySha256']==expected
 lock=Path(plan['ownerDirectory'])/'owner.lock';inode=lock.stat().st_ino
 original=backup/(profile+'-plan-before.json');assert not original.exists(),'Existing repair receipt requires reconciliation'
 original.write_bytes(planfile.read_bytes())
 unit='code-ai-native-owner-'+profile+'.service'
 subprocess.run(['systemctl','stop',unit],check=True,timeout=40,capture_output=True)
 custody=Path(plan['ownerDirectory'])/'ownership.json'
 if custody.exists():
  (backup/(profile+'-custody-before.json')).write_bytes(custody.read_bytes())
  old=json.loads(custody.read_text())
  for key in ['runnerPid','nativePid']:
   p=Path('/proc')/str(old[key])
   if p.exists():
    stat=(p/'stat').read_text().rsplit(') ',1)[1].split();identity=old['runnerIdentity' if key=='runnerPid' else 'nativeIdentity'];assert stat[0]=='Z' or stat[19]!=identity['startTime'],'Recorded native/runner still alive'
 plan['nativeBinary']=str(native)
 temp=planfile.with_name(planfile.name+'.pin-tmp');temp.write_text(json.dumps(plan,indent=2)+'\n');assert temp.stat().st_uid==planfile.stat().st_uid;temp.chmod(planfile.stat().st_mode&0o777);temp.replace(planfile)
 drop=Path('/etc/systemd/system')/(unit+'.d')/'zzzzzzzzzzzzz-runtime-pin-20261016.conf';drop.parent.mkdir(parents=True,exist_ok=True);assert not drop.exists();drop.write_text('[Service]\nEnvironment="CODEX_CLI_PATH='+str(native)+'"\n')
 rows.append({'profile':profile,'plan':str(planfile),'unit':unit,'lockInode':inode,'ownerDirectory':plan['ownerDirectory'],'brokerModuleSha256':plan['brokerModuleSha256'],'dropin':str(drop)})
subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)
for row in rows:subprocess.run(['systemctl','start',row['unit']],check=True,timeout=40,capture_output=True)
deadline=time.monotonic()+45
while True:
 ready=True
 for row in rows:
  p=Path(row['ownerDirectory'])/'ready.json'
  if not p.exists():ready=False;break
  r=json.loads(p.read_text());nativeproc=Path('/proc')/str(r['nativePid'])
  if not nativeproc.exists() or r.get('nativeBinarySha256')!=expected or r.get('brokerModuleSha256')!=row['brokerModuleSha256'] or not r.get('profileVerified'):ready=False;break
  if os.readlink(nativeproc/'exe')!=str(native):ready=False;break
  row['nativePid']=r['nativePid']
 if ready:break
 if time.monotonic()>deadline:raise RuntimeError('Pinned owner readiness deadline')
 time.sleep(.25)
for row in rows:assert (Path(row['ownerDirectory'])/'owner.lock').stat().st_ino==row['lockInode']
report={'host':host,'profiles':rows,'nativeBinary':str(native),'nativeVersion':'0.162.1','ownerLockInodesPreserved':True,'socketRecovery':'qualified existing runner proved dead generations and recovered recorded sockets','otherProviderDataChanged':False,'finishedAtEpoch':time.time()}
(backup/'owner-pin-receipt.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
