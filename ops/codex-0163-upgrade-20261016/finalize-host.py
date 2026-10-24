from pathlib import Path
import json,subprocess,sys,time
c=json.loads(Path(sys.argv[1]).read_text());ops=Path(c['ops']);release=Path(c['release'])
api=json.loads((ops/'final-api-health.json').read_text());process=json.loads((ops/'final-process-verification.json').read_text());acceptance=json.loads((ops/'acceptance-cpu-tool.json').read_text());activation=json.loads((release/'activation-receipt.json').read_text())
assert api['passed'] and process['passed'] and process['stableForAtLeast30Seconds'] and acceptance['passed'] and activation['installed']
assert len(acceptance['runs'])==len(c['profiles']) and all(x['status']=='completed' and x['cpuCommandOutputProven'] and x['expectedReplyPresent'] for x in acceptance['runs'])
units=['code-ai-native-owner-'+p+'.service' for p in c['profiles']]+([c['core']] if c.get('core') else ['code-ai-upload-api.service'])
enabled={u:subprocess.check_output(['systemctl','is-enabled',u],text=True,stderr=subprocess.PIPE).strip() for u in units};assert all(v=='enabled' for v in enabled.values())
cli={'main':'/root/.nvm/versions/node/v24.12.0/bin/codex','beam-10g':'/usr/local/bin/codex','pci':'/usr/local/bin/codex'}[c['id']]
assert subprocess.check_output([cli,'--version'],text=True,stderr=subprocess.PIPE).strip()=='codex-cli 0.163.0'
report=json.loads((ops/'upgrade-receipt.json').read_text());report.update(phase='verified',applicationActivationPending=False,activeApplicationRelease=str(release),realCpuToolAcceptancePassed=True,finalAuthenticatedApiHealthPassed=True,qualifiedApplicationFilesVerified=True,serviceStabilityVerified=True,enabledUnits=enabled,publicCliVersion='0.163.0',verifiedAtEpoch=time.time())
(ops/'upgrade-receipt.json').write_text(json.dumps(report,indent=2)+'\n');(ops/'state.json').write_text(json.dumps({'phase':'complete','host':c['id'],'codexVersion':'0.163.0','codeAiRelease':api['health']['version'],'verifiedAtEpoch':time.time()},indent=2)+'\n');print(json.dumps({'host':c['id'],'verified':True,'codexVersion':'0.163.0','codeAiRelease':api['health']['version'],'enabledUnits':enabled,'cpuToolTestsPassed':len(acceptance['runs'])}))
