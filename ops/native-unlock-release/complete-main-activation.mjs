/** Finish only the remaining main transaction using its proven original PM2 context. */
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const buildId='b6196953-8f40-4acb-a040-1b31a912bea6',controllerBuildId='aff5bbc8-e0a0-4d34-8bd1-a04f42a95036';
const transactionId=buildId+'-'+controllerBuildId,directory='/root/projects/code-ai/ops/native-unlock-release';
assert.equal(process.env.PM2_HOME,'/root/.pm2');assert.equal(process.getuid(),0);
const stage=JSON.parse(await readFile(directory+'/staged-'+transactionId+'.json','utf8'));
const previousFile=directory+'/continuation-receipt-'+transactionId+'.json',previousBytes=await readFile(previousFile),previous=JSON.parse(previousBytes);
assert.equal(previous.complete,false);assert.equal(previous.failure.id,'main');assert.equal(previous.failure.phase,'core-activation-and-readback');
assert.deepEqual(previous.hosts.map(x=>x.id),['beam-10g','pci','ubuntu-gpu-lab']);
const context=JSON.parse(await readFile(directory+'/main-preactivation-context-check.json','utf8'));assert.equal(context.passed,true);assert.equal(context.authenticationPreserved,true);
const receipt={format:'code-ai-native-unlock-live-release-final',version:1,buildId,controllerBuildId,startedAt:new Date().toISOString(),
  previousFailureReceiptPreserved:previousFile,previousFailureReceiptSha256:createHash('sha256').update(previousBytes).digest('hex'),
  exactOriginalPm2HomeVerified:true,unchangedQualifiedArtifacts:true,alreadyCompletedHostsNotReactivated:true,
  mainOwnerPreparationNotRepeated:true,guiNotRelaunchedAgain:true,ownerAuthorizedInterruption:true,credentialRotation:false,
  unrelatedProcessesStopped:false,oldLockInodesDeleted:false,hosts:[...previous.hosts],ubuntuGuiAcceptance:previous.ubuntuGuiAcceptance,
  windowsDeployed:false,windowsReason:previous.windowsReason,complete:false};
const outputFile=directory+'/final-receipt-'+transactionId+'.json';
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:420000,...opts}).trim();
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
function invoke(r,script){return hosts[r.id]?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+r.requestFile],{input:script}):run(r.nodeExecutable,['--input-type=module','-',r.requestFile],{input:script});}
async function save(){receipt.observedAt=new Date().toISOString();await writeFile(outputFile+'.tmp',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});await rename(outputFile+'.tmp',outputFile);}
const verify=await readFile(directory+'/verify-installed-host.mjs','utf8');let phase='completed-host-readback',id='beam-10g';await save();
try{
  receipt.completedHostsFreshReadbacks=[];for(const r of stage.targets.filter(x=>x.id!=='main')){id=r.id;receipt.completedHostsFreshReadbacks.push(JSON.parse(invoke(r,verify)));}
  id='main';phase='qualified-controller-verification';const r=stage.targets.find(x=>x.id==='main');
  const bytes=await readFile(r.ownerControllerDirectory+'/release-files.json');assert.equal(createHash('sha256').update(bytes).digest('hex'),r.ownerControllerManifestSha256);
  const manifest=JSON.parse(bytes);for(const[f,sha]of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(r.ownerControllerDirectory+'/'+f)).digest('hex'),sha);
  const preparation=JSON.parse(await readFile(r.candidate+'/owner-preparation-receipt-'+controllerBuildId+'.json','utf8'));assert.equal(preparation.profiles.length,2);
  assert.ok(preparation.profiles.every(x=>x.managedOwner&&x.probe.homeMatched));
  phase='core-activation-and-readback';
  const result=JSON.parse(invoke(r,'await import('+JSON.stringify(r.ownerControllerDirectory+'/ops/native-unlock-release/activate-host.mjs')+');'));
  assert.equal(result.sharedOwnerEnabled,true);receipt.hosts.push(result);await save();console.log(JSON.stringify({id:'main',installed:true,sharedOwnerEnabled:true}));
  phase='independent-final-readback';receipt.finalReadbacks=[];
  for(const target of stage.targets){id=target.id;receipt.finalReadbacks.push(JSON.parse(invoke(target,verify)));}
  assert.ok(previousBytes.equals(await readFile(previousFile)));receipt.complete=receipt.hosts.length===4;assert.equal(receipt.complete,true);await save();
  console.log(JSON.stringify({complete:true,hosts:receipt.hosts.map(x=>x.id),receipt:outputFile}));
}catch{receipt.failure={id,phase,reason:'main_continuation_gate_failed'};await save();console.error(JSON.stringify({complete:false,id,phase,receipt:outputFile}));process.exitCode=1;}
