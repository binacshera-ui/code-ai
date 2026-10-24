/** Additive, release-specific idle workers. Never borrow operator credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {selectOwnerPlanFile} from './owner-plan-contract.mjs';
const dir='/root/projects/code-ai/ops/native-large-frames';
const stage=JSON.parse(await fs.readFile(dir+'/staged.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const files=['activate-owner-idle.mjs','owner-census.mjs','idle-contract.mjs','idle-contract.test.mjs','owner-lifecycle.test.mjs','owner-plan-contract.mjs','owner-plan-contract.test.mjs','owner-stop-contract.mjs','owner-stop-contract.test.mjs','owner-predecessor-cleanup.mjs'];
const scripts=Object.fromEntries(await Promise.all(files.map(async f=>[f,await fs.readFile(dir+'/'+f,'utf8')])));
const scriptHashes=Object.fromEntries(Object.entries(scripts).map(([f,s])=>[f,hash(s)]));
const opsSuffix=hash(JSON.stringify(scriptHashes)).slice(0,16);
const proof=JSON.parse(await fs.readFile(dir+'/owner-stop-qualification.json','utf8'));assert.equal(proof.passed,5);assert.equal(proof.installedEffects,false);assert.equal(proof.cleanupSha256,scriptHashes['owner-predecessor-cleanup.mjs']);assert.equal(proof.stopContractSha256,scriptHashes['owner-stop-contract.mjs']);
const run=(p,a,o={})=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:60000,env:{...process.env,PM2_HOME:'/root/.pm2'},...o}).trim();
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const units=[];
for(const r of stage.targets){
 const code=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},scripts=${JSON.stringify(scripts)},scriptHashes=${JSON.stringify(scriptHashes)},proof=${JSON.stringify(proof)},hash=b=>crypto.createHash('sha256').update(b).digest('hex'),selectOwnerPlanFile=${selectOwnerPlanFile.toString()};
 const manifest=JSON.parse(fs.readFileSync(r.candidate+'/release-files.json'));for(const[f,h]of Object.entries(manifest.files))if(hash(fs.readFileSync(r.candidate+'/'+f))!==h)throw Error('candidate_hash');
 const receipt=JSON.parse(fs.readFileSync(r.candidate+'/verified-activation-receipt.json'));if(receipt.buildId!==r.buildId||!receipt.credentialConfigurationBytePreserved)throw Error('core_not_accepted');
 const wanted=manifest.files['server/codexSharedOwnerBroker.mjs'];
 const installed=r.ownerProfiles.every(p=>{const o=JSON.parse(fs.readFileSync(p.userHome+'/code-ai-native-owner/ownership.json')),ready=JSON.parse(fs.readFileSync(p.userHome+'/code-ai-native-owner/ready.json'));return o.brokerModuleSha256===wanted&&ready.brokerModuleSha256===wanted;});
 if(installed){console.log(JSON.stringify({id:r.id,scheduled:false,alreadyInstalled:true}));process.exit(0);}
 const ops=r.candidate+'/host-frame-ops-${opsSuffix}';r.hostOpsDirectory=ops;fs.mkdirSync(ops,{recursive:true,mode:0o755});
 for(const[f,s]of Object.entries(scripts)){const target=ops+'/'+f;if(fs.existsSync(target)){if(hash(fs.readFileSync(target))!==scriptHashes[f])throw Error('script_drift');}else fs.writeFileSync(target,s,{mode:0o644,flag:'wx'});}
 const test=cp.execFileSync(r.nodeExecutable,['--test','--test-reporter=tap',ops+'/idle-contract.test.mjs',ops+'/owner-lifecycle.test.mjs',ops+'/owner-plan-contract.test.mjs',ops+'/owner-stop-contract.test.mjs'],{encoding:'utf8',stdio:'pipe'});if(!test.includes('# pass 17')||!test.includes('# fail 0'))throw Error('idle_gate_tests');
 r.newBrokerSha256=manifest.files['server/codexSharedOwnerBroker.mjs'];r.ownerUpdates=[];
 const request=ops+'/request.json';r.predecessorMaintenanceUnit='code-ai-large-frames-'+r.buildId+'.service';
 if(fs.existsSync(request)){
  const prior=JSON.parse(fs.readFileSync(request));
  if(prior.id!==r.id||prior.buildId!==r.buildId||prior.candidate!==r.candidate||prior.newBrokerSha256!==r.newBrokerSha256||prior.hostOpsDirectory!==ops||!Array.isArray(prior.ownerUpdates)||prior.ownerUpdates.length!==r.ownerProfiles.length)throw Error('owner_request_drift');
  r.ownerUpdates=prior.ownerUpdates;
 }else for(const p of r.ownerProfiles){
  const ownerDirectory=p.userHome+'/code-ai-native-owner',execStart=cp.execFileSync('systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),'show','code-ai-native-owner-'+p.id+'.service','-p','ExecStart','--value'],{encoding:'utf8',stdio:'pipe'}),planFile=selectOwnerPlanFile(execStart,ownerDirectory),bytes=fs.readFileSync(planFile),plan=JSON.parse(bytes),o=JSON.parse(fs.readFileSync(ownerDirectory+'/ownership.json'));
  if(plan.codexHome!==p.codexHome||plan.brokerModuleSha256!==o.brokerModuleSha256)throw Error('owner_plan_drift');
  const s=fs.readFileSync('/proc/'+o.runnerPid+'/status','utf8'),uid=Number(/^Uid:\\s+(\\d+)/m.exec(s)?.[1]),gid=Number(/^Gid:\\s+(\\d+)/m.exec(s)?.[1]);
  const username=cp.execFileSync('getent',['passwd',String(uid)],{encoding:'utf8'}).split(':')[0];if(!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(username))throw Error('owner_account_unavailable');
  const runnerSha256=hash(fs.readFileSync(plan.runnerModule)),artifactsSha256=hash(fs.readFileSync(require('path').join(require('path').dirname(plan.runnerModule),'profile-artifacts.mjs')));if(runnerSha256!==proof.runnerSha256||artifactsSha256!==proof.artifactsSha256)throw Error('unqualified_runner_cleanup');
  r.ownerUpdates.push({id:p.id,codexHome:p.codexHome,ownerDirectory,planFile,planSha256:hash(bytes),oldBrokerSha256:o.brokerModuleSha256,uid,gid,username,runnerPid:o.runnerPid,runnerSha256,artifactsSha256});
 }
 if(!fs.existsSync(request))fs.writeFileSync(request,JSON.stringify(r,null,2),{mode:0o600,flag:'wx'});
 const user=r.id==='ubuntu-gpu-lab',unit='code-ai-large-frames-'+r.buildId+'-${opsSuffix}.service',directory=user?'/home/refael/.config/systemd/user':'/etc/systemd/system';
 const text='[Unit]\\nDescription=Qualified Code AI native image transport replacement at idle\\nAfter='+r.ownerUpdates.map(p=>'code-ai-native-owner-'+p.id+'.service').join(' ')+'\\n\\n[Service]\\nType=oneshot\\nUMask=0077\\nEnvironment=PM2_HOME=/root/.pm2\\nExecStart='+r.nodeExecutable+' '+ops+'/activate-owner-idle.mjs '+request+'\\nTimeoutStartSec=infinity\\nRemainAfterExit=yes\\n\\n[Install]\\nWantedBy='+(user?'default.target':'multi-user.target')+'\\n';
 fs.mkdirSync(directory,{recursive:true});const unitFile=directory+'/'+unit;if(fs.existsSync(unitFile)){if(fs.readFileSync(unitFile,'utf8')!==text)throw Error('unit_drift');}else fs.writeFileSync(unitFile,text,{mode:0o600,flag:'wx'});
 const ctl=args=>cp.execFileSync('systemctl',[...(user?['--user']:[]),...args],{stdio:'pipe'});ctl(['daemon-reload']);ctl(['enable',unit]);ctl(['start','--no-block',unit]);console.log(JSON.stringify({id:r.id,unit,scheduled:true,idleTests:17,hostOpsDirectory:ops}));`;
 const out=hosts[r.id]?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:code}):run(r.nodeExecutable,['-'],{input:code});
 units.push(JSON.parse(out));
}
await fs.writeFile(dir+'/owner-upgrades-scheduled.json',JSON.stringify({buildId:stage.buildId,units,scriptHashes,observedAt:new Date().toISOString()},null,2),{mode:0o600});
console.log(JSON.stringify({scheduled:true,units:units.map(u=>u.id),ownersRestartedByScheduling:false}));
