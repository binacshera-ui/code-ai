/** Independent deployment process survives the Code AI service it replaces. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const [buildId,controllerBuildId]=process.argv.slice(2);assert.match(buildId,/^[a-f0-9-]{36}$/);
if(controllerBuildId)assert.match(controllerBuildId,/^[a-f0-9-]{36}$/);
const transactionId=buildId+(controllerBuildId?'-'+controllerBuildId:'');
const directory='/root/projects/code-ai/ops/native-unlock-release';
const stage=JSON.parse(await readFile(directory+'/staged-'+transactionId+'.json','utf8'));
const hostScript=await readFile(new URL('./activate-host.mjs',import.meta.url),'utf8');
const guiScript=await readFile(new URL('./migrate-ubuntu-gui.mjs',import.meta.url),'utf8');
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
const completed=[];
const publicReceipt={format:'code-ai-native-unlock-live-release',version:1,buildId,controllerBuildId,startedAt:new Date().toISOString(),
  ownerAuthorizedInterruption:true,credentialRotation:false,unrelatedProcessesStopped:false,oldLockInodesDeleted:false,
  hosts:completed,windowsDeployed:false,windowsReason:'Reverse SSH unavailable; no Windows native GUI proof',complete:false};
async function save(){publicReceipt.observedAt=new Date().toISOString();await writeFile(directory+'/receipt-'+transactionId+'.json',JSON.stringify(publicReceipt,null,2)+'\n',{mode:0o600});}
const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:420000,...options}).trim();
await save();
for(const r of [...stage.targets.filter(x=>x.id!=='main'),stage.targets.find(x=>x.id==='main')]){
  let phase='owner-preparation';
  try{
    const requestFile=r.requestFile||r.candidate+'/deployment-request.json',host=hosts[r.id];
    const invoke=script=>host?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,
      (r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module - '+requestFile],{input:script}):run(r.nodeExecutable,['--input-type=module','-',requestFile],{input:script});
    const prepare='await import('+JSON.stringify((r.ownerControllerDirectory||r.candidate)+'/ops/native-unlock-release/prepare-owner.mjs')+');';
    const preparation=JSON.parse(invoke(prepare));assert.equal(preparation.prepared,true);
    let gui;
    if(r.id==='ubuntu-gpu-lab'){phase='scoped-gui-migration';gui=JSON.parse(invoke(guiScript));}
    phase='core-activation-and-readback';
    const result=JSON.parse(invoke(hostScript));assert.equal(result.sharedOwnerEnabled,true);
    if(gui){result.gui=gui;result.nativeGuiMigrationVerified=gui.liveGuiUsesManagedDispatcher&&gui.managedOwnerAndHomeVerified;}
    completed.push(result);
    await writeFile(directory+'/receipt-'+r.id+'-'+transactionId+'.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
    await save();console.log(JSON.stringify({id:r.id,installed:true,sharedOwnerEnabled:true}));
  }catch{
    publicReceipt.failure={id:r.id,phase,reason:'scoped_transaction_or_readback_failed',subsequentHostsNotChanged:true};await save();process.exitCode=1;break;
  }
}
publicReceipt.complete=completed.length===stage.targets.length;await save();
console.log(JSON.stringify({buildId,controllerBuildId,complete:publicReceipt.complete,hosts:completed.map(x=>x.id),receipt:directory+'/receipt-'+transactionId+'.json'}));
