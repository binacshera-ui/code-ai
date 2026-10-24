from pathlib import Path
import json,hashlib,subprocess,datetime
ops=Path('/root/projects/code-ai/ops/auth-cycle-repair-20261016')
state=json.loads((ops/'state.json').read_text())
root=Path('/mnt/hdd/code-ai-builds')/state['release']
request=json.loads((root/'fleet-request.json').read_text())
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2'
rec=next(x for x in json.loads(subprocess.check_output([pm2,'jlist'])) if x['name']=='code-ai-app')
env=dict(s.split('=',1) for s in Path(f'/proc/{rec["pid"]}/environ').read_bytes().decode().split('\0') if '=' in s)
assert rec['pm2_env']['status']=='online'
assert env['CODE_AI_PM2_TARGET_MODULE']==str(root/'dist/server.js')
assert Path('/root/projects/code-ai/dist').resolve()==root/'dist'
manifest=json.loads((root/'release-files.json').read_text())
assert all(sha(root/name)==value for name,value in manifest['files'].items())
owners=[]
for user,expected_pid in [('developer',1614273),('developer2',1614274)]:
    unit='code-ai-native-owner-'+user+'.service'
    assert subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active'
    ownership=json.loads(Path('/home/'+user+'/code-ai-native-owner/ownership.json').read_text())
    pid=ownership['nativePid']
    assert pid==expected_pid,'Unnecessary native owner restart detected'
    binary=Path(f'/proc/{pid}/exe')
    assert sha(binary)=='399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215'
    version=subprocess.check_output([str(binary),'--version'],text=True).strip()
    assert version=='codex-cli 0.163.0'
    owners.append(dict(profileId=user,pid=pid,version=version,executableSha256=sha(binary),ownerSurvivedCoreDeployment=True))
assert subprocess.check_output(['systemctl','is-active','code-ai-upload-api.service'],text=True).strip()=='active'
upload_command=subprocess.check_output(['systemctl','show','code-ai-upload-api.service','-p','ExecStart','--value'],text=True)
assert str(root/'dist/server.js') in upload_command
retry=json.loads((ops/'live/retry-acceptance.json').read_text());assert retry['passed']
tests=json.loads((root/'qualification/fleet-tests.json').read_text());assert tests['passed'] and len(tests['results'])==state['expectedSelectedSuites']
old_thread=json.loads((ops/'existing-thread-preflight/native-proof.json').read_text());assert old_thread['passed']
new_thread=json.loads((ops/'acceptance-cpu-tool.json').read_text());assert new_thread['passed']
receipt=json.loads((root/'activation-receipt.json').read_text());assert receipt['installed']
external=json.loads((ops/'external-http.json').read_text());assert external['passed']
device_cycle=json.loads((ops/'external-device-cycle.json').read_text());assert device_cycle['passed']
fetch_smoke=json.loads((ops/'fetch-smoke.json').read_text());assert fetch_smoke['passed']
report=dict(completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Germany Code AI only',passed=True,release=state['release'],buildId=request['buildId'],selectedSuitesPassed=state['expectedSelectedSuites'],manifestFilesVerified=len(manifest['files']),main=dict(pid=rec['pid'],status=rec['pm2_env']['status'],restartCount=rec['pm2_env']['restart_time'],actualTarget=str(root/'dist/server.js')),uploadService='active; qualified release verified',nativeOwners=owners,authRepair=dict(completedAuthenticationCacheRemoved=True,accountBoundaryInvalidatesUsageAndModels=True,staleInFlightResponsesFenced=True,logoutLoginSerialized=True,nativeLogoutReadBackVerified=True,noStoreApiHeadersVerified=True,accountOnlyRefreshDoesNotScanHistory=True),retryAcceptance=retry,externalHttp=external,postUserLoginExistingThread=old_thread,postUserLoginNewThreadPassed=True,activation=receipt,failedAttemptsPreserved=['build-first-failure.log','build-second-failure.log','preflight-first-read-failure.json','existing-thread-preflight/first-read-failure.json','live-r9/first-api-read-timeout.json'],limits=['Actual external OAuth consent cycle was not repeated; lifecycle overlap and logout acknowledgment use isolated native RPC and child-process fixtures, plus real post-user-login model calls.','Browser visual interaction was not tested; deployed asset hashes, API headers, authentication and native execution were verified.'],unrelatedChanges=False,nativeDowngrade=False,windowsTouched=False,gpuTouched=False,credentialsChanged=False)
(ops/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
report.update(externalDeviceLoginLogoutCycle=device_cycle,builtInFetchSmoke=fetch_smoke,compatibilityDecision='Account-only quota reads retain the same JSON fields but do not borrow context or quota from an unselected historic thread; explicit selected-thread context remains supported. Canonical owner broker is byte-identical to the existing qualified owner; no native restart or downgrade.',priorActivation=json.loads((Path('/mnt/hdd/code-ai-builds/fleet-20261016-7a00082e7f9c')/'activation-receipt.json').read_text()))
(ops/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
state.update(phase='complete',report=str(ops/'report.json'),verifiedAt=report['completedAt'],buildId=request['buildId'],activeRelease=str(root));(ops/'state.json').write_text(json.dumps(state,indent=2)+'\n')
print(json.dumps(dict(passed=True,release=state['release'],mainPid=rec['pid'],nativeOwners=owners,selectedSuitesPassed=state['expectedSelectedSuites'],retryPassed=True)))
