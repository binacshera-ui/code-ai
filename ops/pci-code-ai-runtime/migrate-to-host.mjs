// One-shot migration of the explicitly authorized PCI VM to its physical host.
// All command errors and credential comparisons are metadata-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile, chmod, rename, mkdtemp, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root='/root/projects/code-ai';
const buildId='8a7d514b-4731-4b06-959c-f2d6cd3ed031';
const artifact=`/mnt/hdd/code-ai-builds/pci-runtime-imports/${buildId}/artifact/dist`;
const registryFile=root+'/.code-ai/remote-hosts.json';
const base='/srv/beam254/code-ai-native';
const release=base+'/releases/pci-'+buildId;
const legacy='/opt/code-ai-releases/pci-'+buildId;
const host=['-F','/root/.ssh/bina_pci_gateway_config','bina-pci-bootstrap'];
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'pipe',encoding:'utf8',timeout:300000,...options}).trim();
const ssh=(command,options={})=>run('ssh',[...host,command],options);
let phase='preflight',stage,remoteStage,expectedRegistry,originalRegistry,token,before,sourceStopped=false,promoted=false;
const metadata={buildId,serverId:'pci',source:'code-ai-pci',destination:'binapay-cde-host',native:true};
async function checkpoint(fields) {
  Object.assign(metadata,fields);
  if(stage)await writeFile(stage+'/receipt.json',JSON.stringify(metadata,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({phase,...fields}));
}
async function updateRegistry(mutator) {
  assert.equal(await readFile(registryFile,'utf8'),expectedRegistry,'Concurrent registry change blocks switch');
  const registry=JSON.parse(expectedRegistry);
  const pci=registry.hosts.find(x=>x.id==='pci');assert.ok(pci);
  const others=JSON.stringify(registry.hosts.filter(x=>x.id!=='pci'));
  mutator(pci);
  assert.equal(JSON.stringify(registry.hosts.filter(x=>x.id!=='pci')),others);
  const temporary=registryFile+`.native-${process.pid}.tmp`;
  expectedRegistry=JSON.stringify(registry,null,2)+'\n';
  await writeFile(temporary,expectedRegistry,{mode:0o600,flag:'wx'});
  await rename(temporary,registryFile);await chmod(registryFile,0o600);
}
const hostPhase=p=>JSON.parse(ssh(`sudo -n ${release}/bin/node ${remoteStage}/migration-host.mjs`,{input:JSON.stringify({phase:p,buildId,token,snapshot:remoteStage+'/snapshot.tar.gz'})}));
const check=(where,health,inventory)=>JSON.parse(run('ssh',where==='source'?['code-ai-pci',`${legacy}/bin/node ${remoteStageSource}/migration-check.mjs`]:[...host,`sudo -n -u admin ${legacy}/bin/node ${remoteStage}/migration-check.mjs`],{input:JSON.stringify({token,health,inventory,hostname:where==='source'?'code-ai-pci':'binapay-cde-host'})}));
let remoteStageSource;
try {
  const resume=process.argv[2]==='--resume';
  originalRegistry=await readFile(registryFile,'utf8');expectedRegistry=originalRegistry;
  const pci=JSON.parse(originalRegistry).hosts.find(x=>x.id==='pci');
  assert.equal(pci.sshTarget,'code-ai-pci');assert.equal(pci.enabled,true);assert.equal(pci.remotePort,4010);
  token=pci.token;assert.ok(token?.length>=32);
  if(resume) {
    [stage,remoteStage,remoteStageSource]=process.argv.slice(3);
    assert.match(stage,/^\/mnt\/hdd\/code-ai-builds\/pci-native-migration-[A-Za-z0-9]+$/);
    assert.match(remoteStage,/^\/var\/tmp\/code-ai-native\.[A-Za-z0-9]+$/);
    assert.match(remoteStageSource,/^\/var\/tmp\/code-ai-native-source\.[A-Za-z0-9]+$/);
    const receipt=JSON.parse(await readFile(stage+'/receipt.json','utf8'));
    assert.equal(receipt.buildId,buildId);
    assert.deepEqual(JSON.parse(originalRegistry),JSON.parse(await readFile(stage+'/registry-before.json','utf8')));
    ssh(`sudo -n test -e ${base}/recovery/cde-baseline.json && test ! -e /home/admin && test ! -e /srv/projects && test ! -e /var/lib/code-ai-pci && test ! -e ${legacy}`);
    assert.equal(ssh(`${release}/codex-vendor/bin/codex --version`),'codex-cli 0.160.1');
    ssh(`${release}/bin/node -e 'require("${release}/app/node_modules/node-pty")'`);
    await checkpoint({nativeRuntimeCompatible:true,resumedPreparedStage:true});
  } else {
  run('bina-build',['verify-import',buildId,'--import-root','/mnt/hdd/code-ai-builds/pci-runtime-imports']);
  assert.equal(ssh('hostname'),'binapay-cde-host');
  ssh(`test ! -e ${base} && test ! -e /home/admin && test ! -e /srv/projects && test ! -e /var/lib/code-ai-pci && test ! -e ${legacy} && ! getent passwd admin >/dev/null`);
  stage=await mkdtemp('/mnt/hdd/code-ai-builds/pci-native-migration-');await chmod(stage,0o700);
  await copyFile(registryFile,stage+'/registry-before.json');await chmod(stage+'/registry-before.json',0o600);
  const archive=stage+'/runtime.tar.gz';
  run('tar',['-C',artifact,'-czf',archive,'.']);await chmod(archive,0o600);
  const runtimeDigest=createHash('sha256').update(await readFile(archive)).digest('hex');
  remoteStage=ssh('mktemp -d /var/tmp/code-ai-native.XXXXXX');
  assert.match(remoteStage,/^\/var\/tmp\/code-ai-native\.[A-Za-z0-9]+$/);
  remoteStageSource=run('ssh',['code-ai-pci','mktemp -d /var/tmp/code-ai-native-source.XXXXXX']);
  assert.match(remoteStageSource,/^\/var\/tmp\/code-ai-native-source\.[A-Za-z0-9]+$/);
  run('scp',['-F','/root/.ssh/bina_pci_gateway_config',archive,root+'/ops/pci-code-ai-runtime/migration-host.mjs',root+'/ops/pci-code-ai-runtime/migration-check.mjs',`bina-pci-bootstrap:${remoteStage}/`]);
  run('scp',[root+'/ops/pci-code-ai-runtime/migration-check.mjs',`code-ai-pci:${remoteStageSource}/`]);
  assert.equal(ssh(`sha256sum ${remoteStage}/runtime.tar.gz`).split(' ')[0],runtimeDigest);
  ssh(`sudo -n install -d -m 755 ${release} && sudo -n tar --no-same-owner -xzf ${remoteStage}/runtime.tar.gz -C ${release}`);
  phase='prepare-native';await checkpoint(hostPhase('prepare'));
  // Separate alias allows the required local tunnel; bootstrap intentionally clears forwarding.
  const aliasFile='/root/.ssh/code-ai-pci-host_config';
  assert.equal(await access(aliasFile).then(()=>true,()=>false),false);
  await writeFile(aliasFile,`Host code-ai-pci-host\n    HostName 198.23.160.30\n    User binapay-admin\n    Port 22\n    IdentityFile /root/.ssh/bina_pci_gateway_ed25519\n    IdentitiesOnly yes\n    PreferredAuthentications publickey\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    StrictHostKeyChecking yes\n    UserKnownHostsFile /root/.ssh/bina_pci_gateway_known_hosts\n    ForwardAgent no\n    ClearAllForwardings no\n    ServerAliveInterval 30\n    ServerAliveCountMax 3\n    ConnectTimeout 10\n`,{mode:0o600,flag:'wx'});
  // The normal registry inherits root's existing SSH configuration.
  // This is installed via a narrow Include patch, not a rewrite of existing aliases.
  assert.ok((await readFile('/root/.ssh/config','utf8')).includes('Include /root/.ssh/code-ai-pci-host_config'));
  }
  phase='admission-fence';await updateRegistry(p=>{p.enabled=false;});
  await checkpoint({registryAdmissionFenced:true});
  before=check('source',true,false);
  await checkpoint({sourceHealth:before.health,sourceQueue:before.counts});
  phase='stop-source';
  run('ssh',['code-ai-pci','sudo -n systemctl stop code-ai-remote-pci.service']);sourceStopped=true;
  const active=run('ssh',['code-ai-pci','systemctl show code-ai-remote-pci.service -p ActiveState --value'],{timeout:30000});
  assert.equal(active,'inactive');
  await checkpoint({sourceStopped:true});
} catch(error) {
    if(sourceStopped&&!promoted) {try{run('ssh',['code-ai-pci','sudo -n systemctl start code-ai-remote-pci.service']);}catch{}}
    if(originalRegistry&&expectedRegistry!==originalRegistry) {
      try{await updateRegistry(p=>Object.assign(p,JSON.parse(originalRegistry).hosts.find(x=>x.id==='pci')));}catch{}
    }
    await checkpoint({ok:false,errorType:error.code||error.name,errorStatus:error.status??null,location:error.stack?.match(/migrate-to-host\.mjs:\d+:\d+/)?.[0],receiptPath:stage?stage+'/receipt.json':null});
    process.exit(1);
}
try {
  phase='snapshot';
  const finalSource=check('source',false,true);
  run('ssh',['code-ai-pci',`sudo -n tar -C / -czf ${remoteStageSource}/snapshot.tar.gz home/admin srv/projects var/lib/code-ai-pci && sudo -n chown admin:admin ${remoteStageSource}/snapshot.tar.gz && chmod 600 ${remoteStageSource}/snapshot.tar.gz`]);
  run('scp',[`code-ai-pci:${remoteStageSource}/snapshot.tar.gz`,stage+'/snapshot.tar.gz']);await chmod(stage+'/snapshot.tar.gz',0o600);
  const snapshotDigest=createHash('sha256').update(await readFile(stage+'/snapshot.tar.gz')).digest('hex');
  run('scp',['-F','/root/.ssh/bina_pci_gateway_config',stage+'/snapshot.tar.gz',`bina-pci-bootstrap:${remoteStage}/`]);
  assert.equal(ssh(`sha256sum ${remoteStage}/snapshot.tar.gz`).split(' ')[0],snapshotDigest);
  await checkpoint({snapshotPrivate:true,snapshotFileCount:finalSource.inventory.files,snapshotBytes:finalSource.inventory.bytes});
  phase='install-native';await checkpoint(hostPhase('install'));
  phase='verify-native';
  let verified;
  for(let i=0;i<20;i++) {try{verified=check('host',true,true);break;}catch{await new Promise(resolve=>setTimeout(resolve,1000));}}
  assert.ok(verified?.ok);
  assert.deepEqual(verified.inventory,finalSource.inventory,'Data content changed during migration');
  assert.deepEqual(verified.counts,finalSource.counts);
  assert.deepEqual(verified.health.profiles,before.health.profiles);
  await new Promise(resolve=>setTimeout(resolve,15000));
  const stable=check('host',true,false);assert.deepEqual(stable.counts,verified.counts);
  assert.equal(ssh('sudo -n systemctl show code-ai-remote-pci.service -p NRestarts --value'),'0');
  await checkpoint({nativeHealth:verified.health,dataContentPreserved:true,queuePreserved:true,stableSeconds:15,credentialRotation:false});
  phase='promote';
  await updateRegistry(p=>{p.enabled=true;p.sshTarget='code-ai-pci-host';p.description='ColoCrossing · שרת פיזי · Admin';});promoted=true;
  const proof=JSON.parse(run(process.execPath,['--experimental-vm-modules',root+'/ops/pci-code-ai-runtime/verify-registry.mjs','binapay-cde-host'],{cwd:root}));
  assert.equal(proof.registryContract,true);
  await checkpoint({registryProof:proof,readyForVmRemoval:true,receiptPath:stage+'/receipt.json'});
} catch(error) {
  // Before promotion there are no remote admissions; stop only the new native service and resume VM.
  if(!promoted) {
    try{ssh('sudo -n systemctl stop code-ai-remote-pci.service');}catch{}
    try{run('ssh',['code-ai-pci','sudo -n systemctl start code-ai-remote-pci.service']);}catch{}
    try{await updateRegistry(p=>Object.assign(p,JSON.parse(originalRegistry).hosts.find(x=>x.id==='pci')));}catch{}
  }
  await checkpoint({ok:false,errorType:error.code||error.name,errorStatus:error.status??null,promoted,vmKept:true,receiptPath:stage+'/receipt.json'});
  process.exit(1);
}
