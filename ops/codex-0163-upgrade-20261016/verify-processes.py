from pathlib import Path
import json,os,sys,subprocess,hashlib,time
c=json.loads(Path(sys.argv[1]).read_text());ops=Path(c['ops']);r=Path(c['release']);expected='399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215'
def run(args,env=None):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE,env=env,timeout=20).strip()
def ctl(*args):return run(['systemctl',*args])
def unit(name):
 j=dict(line.split('=',1) for line in ctl('show',name,'-p','MainPID','-p','NRestarts','-p','ActiveState').splitlines());assert j['ActiveState']=='active' and int(j['MainPID'])>1;return j
manifest=json.loads((r/'release-files.json').read_text())
for name,digest in manifest['files'].items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==digest,'Qualified application changed'
rows=[];services={}
for profile,home in c['profiles'].items():
 d=Path(home)/'code-ai-native-owner';plan=json.loads((d/'profile-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json').read_text());ready=json.loads((d/'ready.json').read_text());custody=json.loads((d/'ownership.json').read_text())
 assert plan['nativeBinary']==c['native'] and plan['nativeBinarySha256']==expected and ready['nativeBinarySha256']==expected and ready['profileVerified'] and ready['nativePid']==custody['nativePid']
 pid=ready['nativePid'];assert os.readlink('/proc/'+str(pid)+'/exe')==c['native'];assert run(['/proc/'+str(pid)+'/exe','--version'])=='codex-cli 0.163.0'
 assert plan['runnerModule']==str(r/'ops/native-owner/profile-runner.mjs') and plan['brokerModule']==str(r/'server/codexSharedOwnerBroker.mjs')
 assert plan['runnerModule'] in Path('/proc',str(custody['runnerPid']),'cmdline').read_text().split('\0')
 name='code-ai-native-owner-'+profile+'.service';services[name]=unit(name)
 rows.append({'id':profile,'nativePid':pid,'runnerPid':custody['runnerPid'],'nativeVersion':'0.163.0','executable':c['native'],'qualifiedOwnerHelpersActive':True,'profileVerified':True})
if c['id']=='main':
 env={**os.environ,'PATH':'/root/.nvm/versions/node/v24.12.0/bin:'+os.environ.get('PATH',''),'HOME':'/root','PM2_HOME':'/root/.pm2'}
 j=next(x for x in json.loads(run(['/root/.nvm/versions/node/v24.12.0/bin/pm2','jlist'],env)) if x['name']=='code-ai-app');assert j['pm2_env']['status']=='online';pid=j['pid'];services['code-ai-app']={'MainPID':str(pid),'NRestarts':str(j['pm2_env']['restart_time']),'ActiveState':'active'}
 assert Path('/root/projects/code-ai/dist').resolve()==r/'dist';services['code-ai-upload-api.service']=unit('code-ai-upload-api.service')
 assert str(r/'dist/server.js') in ctl('show','code-ai-upload-api.service','-p','ExecStart','--value')
else:
 services[c['core']]=unit(c['core']);pid=int(services[c['core']]['MainPID']);assert Path('/proc',str(pid),'cwd').resolve()==r
 assert str(r) in ctl('show',c['core'],'-p','ExecStart','--value')
actual=dict(s.split('=',1) for s in Path('/proc',str(pid),'environ').read_text().split('\0') if '=' in s)
assert all(actual.get(k)==c['native'] for k in ['CODEX_BIN','CODEX_TERMINAL_BIN','CODEX_CLI_PATH'])
if c['id']=='main':assert actual['CODE_AI_PM2_TARGET_MODULE']==str(r/'dist/server.js')
assert not any(s in actual.get('NODE_OPTIONS','') for s in ['metadata-diagnostic','diagnostic-codex'])
if c['id']=='beam-10g':assert ctl('show',c['core'],'-p','PrivateTmp','--value')=='yes'
first=ops/'service-snapshot-before.json';stable=None
if first.exists():
 previous=json.loads(first.read_text());stable=previous['services']==services and time.time()-previous['atEpoch']>=30;assert stable,'Services restarted or stability observation shorter than 30 seconds'
else:first.write_text(json.dumps({'atEpoch':time.time(),'services':services},indent=2)+'\n')
report={'host':c['id'],'checkedAtEpoch':time.time(),'applicationRelease':json.loads((r/'release.json').read_text())['version'],'nativeVersion':'0.163.0','allQualifiedApplicationFilesMatched':True,'profiles':rows,'services':services,'stableForAtLeast30Seconds':stable,'temporaryDiagnosticImportsPresent':False,'passed':True}
(ops/'final-process-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
