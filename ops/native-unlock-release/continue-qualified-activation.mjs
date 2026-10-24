/** Resume the exact interrupted transaction, not a new build or repeated rollout. */
import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [buildId,controllerBuildId]=process.argv.slice(2);
assert.equal(buildId,'b6196953-8f40-4acb-a040-1b31a912bea6');
assert.equal(controllerBuildId,'aff5bbc8-e0a0-4d34-8bd1-a04f42a95036');
const transactionId=buildId+'-'+controllerBuildId;
const directory='/root/projects/code-ai/ops/native-unlock-release';
const originalFile=directory+'/receipt-'+transactionId+'.json',outputFile=directory+'/continuation-receipt-'+transactionId+'.json';
const stage=JSON.parse(await readFile(directory+'/staged-'+transactionId+'.json','utf8'));
const originalBytes=await readFile(originalFile),original=JSON.parse(originalBytes);
assert.equal(original.complete,false);assert.equal(original.failure.id,'ubuntu-gpu-lab');assert.equal(original.failure.phase,'scoped-gui-migration');
assert.deepEqual(original.hosts.map(x=>x.id),['beam-10g','pci']);
const completed=[...original.hosts];
const receipt={format:'code-ai-native-unlock-live-release-continuation',version:1,buildId,controllerBuildId,
  startedAt:new Date().toISOString(),originalFailureReceiptPreserved:originalFile,originalFailureReceiptSha256:createHash('sha256').update(originalBytes).digest('hex'),
  unchangedQualifiedRuntimeArtifacts:true,alreadyCompletedHostsNotReactivated:true,guiNotRelaunchedAgain:true,
  ownerAuthorizedInterruption:true,credentialRotation:false,unrelatedProcessesStopped:false,oldLockInodesDeleted:false,
  hosts:completed,windowsDeployed:false,windowsReason:'Reverse SSH unavailable; native Windows GUI integration unverified',complete:false};
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:420000,...opts}).trim();
async function save(){receipt.observedAt=new Date().toISOString();await writeFile(outputFile+'.tmp',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});await rename(outputFile+'.tmp',outputFile);}
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
function invoke(r,script){const host=hosts[r.id];return host?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+r.requestFile],{input:script}):run(r.nodeExecutable,['--input-type=module','-',r.requestFile],{input:script});}
const verifyScript=await readFile(directory+'/verify-installed-host.mjs','utf8');
const qualifiedInvoke=(r,module)=>invoke(r,'await import('+JSON.stringify(r.ownerControllerDirectory+'/ops/native-unlock-release/'+module+'.mjs')+');');
await save();let phase='completed-host-readback',id='beam-10g';
try{
  receipt.completedHostsFreshReadbacks=[];
  for(const r of stage.targets.filter(x=>['beam-10g','pci'].includes(x.id))){id=r.id;receipt.completedHostsFreshReadbacks.push(JSON.parse(invoke(r,verifyScript)));}
  const ubuntu=stage.targets.find(x=>x.id==='ubuntu-gpu-lab');id=ubuntu.id;phase='authoritative-gui-readback-gate';
  const gui=JSON.parse(invoke(ubuntu,"import {readFile} from 'node:fs/promises'; const r=JSON.parse(await readFile(process.argv[2],'utf8')); console.log(await readFile(r.candidate+'/gui-migration-readback-receipt.json','utf8'));"));
  assert.equal(gui.buildId,buildId);assert.equal(gui.controllerBuildId,controllerBuildId);assert.equal(gui.liveGuiUsesManagedDispatcher,true);
  assert.equal(gui.managedOwnerAndHomeVerified,true);assert.equal(gui.adapterToBrokerSocketPeerVerified,true);
  assert.equal(gui.existingGpuThreadResumedSameIdWithHistory,true);assert.equal(gui.realModelTurns,0);
  assert.ok(Date.now()-Date.parse(gui.observedAt)<15*60*1000);receipt.ubuntuGuiAcceptance=gui;await save();
  for(const r of [ubuntu,stage.targets.find(x=>x.id==='main')]){
    id=r.id;
    if(r.id==='main'){phase='owner-preparation';const prepared=JSON.parse(qualifiedInvoke(r,'prepare-owner'));assert.equal(prepared.prepared,true);}
    phase='core-activation-and-readback';const result=JSON.parse(qualifiedInvoke(r,'activate-host'));assert.equal(result.sharedOwnerEnabled,true);
    if(r.id==='ubuntu-gpu-lab'){result.gui=gui;result.nativeGuiMigrationVerified=true;}
    completed.push(result);await writeFile(directory+'/continuation-receipt-'+r.id+'-'+transactionId+'.json',JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
    await save();console.log(JSON.stringify({id:r.id,installed:true,sharedOwnerEnabled:true}));
  }
  phase='independent-final-readback';receipt.finalReadbacks=[];
  for(const r of stage.targets){id=r.id;receipt.finalReadbacks.push(JSON.parse(invoke(r,verifyScript)));}
  assert.ok(originalBytes.equals(await readFile(originalFile)));receipt.complete=completed.length===stage.targets.length;assert.equal(receipt.complete,true);
  await save();console.log(JSON.stringify({complete:true,hosts:completed.map(x=>x.id),receipt:outputFile}));
}catch{
  receipt.failure={id,phase,reason:'qualified_continuation_gate_failed',subsequentHostsNotChanged:true};await save();
  console.error(JSON.stringify({complete:false,id,phase,receipt:outputFile}));process.exitCode=1;
}
