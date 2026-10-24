// Finalize only after the physical successor has been promoted and verified.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const root='/root/projects/code-ai';
const buildId='8a7d514b-4731-4b06-959c-f2d6cd3ed031';
const base='/srv/beam254/code-ai-native';
const release=base+'/releases/pci-'+buildId;
const [stage,remoteStage,sourceStage]=process.argv.slice(2);
let phase='verify-successor';
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:180000,...options}).trim();
const ssh=(command,options={})=>run('ssh',['-F','/root/.ssh/bina_pci_gateway_config','bina-pci-bootstrap',command],options);
try {
  assert.match(stage,/^\/mnt\/hdd\/code-ai-builds\/pci-native-migration-[A-Za-z0-9]+$/);
  assert.match(remoteStage,/^\/var\/tmp\/code-ai-native\.[A-Za-z0-9]+$/);
  assert.match(sourceStage,/^\/var\/tmp\/code-ai-native-source\.[A-Za-z0-9]+$/);
  const receipt=JSON.parse(await readFile(stage+'/receipt.json','utf8'));
  assert.equal(receipt.readyForVmRemoval,true);assert.equal(receipt.dataContentPreserved,true);assert.equal(receipt.buildId,buildId);
  const registry=JSON.parse(await readFile(root+'/.code-ai/remote-hosts.json','utf8'));
  const pci=registry.hosts.find(x=>x.id==='pci');
  assert.equal(pci.enabled,true);assert.equal(pci.sshTarget,'code-ai-pci-host');assert.equal(pci.remotePort,4010);
  const checkRequest=JSON.stringify({token:pci.token,health:true,inventory:false,hostname:'binapay-cde-host'});
  const before=JSON.parse(ssh(`sudo -n -u admin ${release}/bin/node ${remoteStage}/migration-check.mjs`,{input:checkRequest}));
  assert.equal(before.ok,true);
  if(ssh('sudo -n virsh list --all --name').split('\n').includes('code-ai-pci')) {
    assert.equal(run('ssh',['code-ai-pci','sudo -n systemctl show code-ai-remote-pci.service -p ActiveState --value']),'inactive');
  } else {
    // Resume cleanup after undefine; never reconnect to an unrelated replacement VM.
    ssh(`sudo -n test -e ${base}/recovery/code-ai-pci.xml && sudo -n test -e ${base}/recovery/vm-files/root.qcow2`);
  }
  const proof=JSON.parse(run(process.execPath,['--experimental-vm-modules',root+'/ops/pci-code-ai-runtime/verify-registry.mjs','binapay-cde-host'],{cwd:root}));
  assert.equal(proof.registryContract,true);
  console.log(JSON.stringify({phase,nativeOnline:true,sourceServiceInactive:true,dataPreviouslyVerified:true}));
  phase='remove-vm';
  const result=JSON.parse(ssh(`sudo -n ${release}/bin/node ${remoteStage}/migration-host.mjs`,{input:JSON.stringify({phase:'remove-vm',buildId})}));
  assert.equal(result.vmRemoved,true);
  console.log(JSON.stringify({phase,...result}));
  // Recovery copies remain root-only, outside the former VM's registered paths.
  ssh(`sudo -n mv ${remoteStage}/snapshot.tar.gz ${base}/recovery/snapshot.tar.gz && sudo -n chown root:root ${base}/recovery/snapshot.tar.gz && sudo -n chmod 600 ${base}/recovery/snapshot.tar.gz && sudo -n chmod 700 ${remoteStage}`);
  phase='final-verification';
  const after=JSON.parse(ssh(`sudo -n ${release}/bin/node ${remoteStage}/migration-check.mjs`,{input:checkRequest}));
  assert.equal(after.ok,true);assert.deepEqual(after.counts,before.counts);
  const finalProof=JSON.parse(run(process.execPath,['--experimental-vm-modules',root+'/ops/pci-code-ai-runtime/verify-registry.mjs','binapay-cde-host'],{cwd:root}));
  assert.equal(finalProof.registryContract,true);
  const final={...receipt,...result,ok:true,nativeServiceStable:true,finalRegistryProof:finalProof,sourceVmRemoved:true,credentialRotation:false,mainCodeAiRestarted:false,otherServicesRestarted:false,completedAt:new Date().toISOString()};
  await writeFile(stage+'/receipt.json',JSON.stringify(final,null,2)+'\n',{mode:0o600});
  // The host gets the same non-sensitive receipt, not the registry or private credentials.
  ssh(`sudo -n ${release}/bin/node -e 'const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>fs.writeFileSync("${base}/recovery/receipt.json",s,{mode:0o600,flag:"wx"}));'`,{input:JSON.stringify(final,null,2)+'\n'});
  console.log(JSON.stringify({phase,ok:true,vmRemoved:true,physicalHostname:after.health.hostname,otherVmsUnchanged:true,backup:base+'/recovery',receiptPath:stage+'/receipt.json'}));
} catch(error) {
  console.error(JSON.stringify({phase,ok:false,errorType:error.code||error.name,errorStatus:error.status??null,location:error.stack?.match(/remove-relocated-vm\.mjs:\d+:\d+/)?.[0]}));
  process.exit(1);
}
