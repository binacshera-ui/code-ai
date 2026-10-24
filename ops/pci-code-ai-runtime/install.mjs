// Deploy a verified immutable artifact to the newly created VM only.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, cp, stat, chmod, rename, mkdtemp, copyFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import path from 'node:path';
process.on('uncaughtException',error=>{
  console.error(JSON.stringify({operation:'pci-first-install',failed:true,errorCode:error.code||error.name,status:error.status??null}));
  process.exit(1);
});
const root='/root/projects/code-ai';
const buildId=process.argv[2];
assert.match(buildId,/^[a-f0-9-]{36}$/);
const imports='/mnt/hdd/code-ai-builds/pci-runtime-imports';
const artifact=path.join(imports,buildId,'artifact/dist');
const registryPath=root+'/.code-ai/remote-hosts.json';
const run=(command,args,options={})=>{
  const result=execFileSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:180000,...options});
  return result.trim();
};
run('bina-build',['verify-import',buildId,'--import-root',imports]);
const initialRegistry=await readFile(registryPath,'utf8');
const registry=JSON.parse(initialRegistry);
assert.equal(registry.version,1);
assert.ok(!registry.hosts.some(host=>host.id==='pci'),'Existing PCI entry requires an update plan');
assert.equal(run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','code-ai-pci','id -un']), 'admin');
const release=`/opt/code-ai-releases/pci-${buildId}`;
run('ssh',['code-ai-pci',`test ! -e ${release} && test ! -e /etc/systemd/system/code-ai-remote-pci.service && test ! -e /var/lib/code-ai-pci/runtime.env`]);
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/pci-install-');
const archive=stage+'/runtime.tar.gz';
run('tar',['-C',artifact,'-czf',archive,'.']);
const archiveDigest=createHash('sha256').update(await readFile(archive)).digest('hex');
const remoteStage=run('ssh',['code-ai-pci','mktemp -d /home/admin/code-ai-install.XXXXXX']);
assert.match(remoteStage,/^\/home\/admin\/code-ai-install\.[A-Za-z0-9]+$/);
run('scp',[archive,'ops/pci-code-ai-runtime/install-guest.mjs','ops/pci-code-ai-runtime/verify-guest.mjs',`code-ai-pci:${remoteStage}/`],{cwd:root});
assert.equal(run('ssh',['code-ai-pci',`sha256sum ${remoteStage}/runtime.tar.gz`]).split(' ')[0],archiveDigest);
run('ssh',['code-ai-pci',`sudo -n install -d -m 755 ${release} && sudo -n tar --no-same-owner -xzf ${remoteStage}/runtime.tar.gz -C ${release}`]);
const remoteToken=randomBytes(32).toString('hex');
// Read only the previously approved Code AI notification fields, privately.
const localEnv=parseEnv(await readFile(root+'/.env','utf8').catch(()=>''));
const notifications={CODEX_NTFY_ENABLED:'false'};
if(localEnv.CODEX_NTFY_URL) {
  for(const key of ['CODEX_NTFY_URL','CODEX_NTFY_ENABLED','CODEX_NTFY_DEFAULT_ENABLED','CODEX_NTFY_ACCESS_TOKEN','CODEX_PUBLIC_ORIGIN']) {
    if(localEnv[key])notifications[key]=localEnv[key];
  }
  notifications.CODEX_NTFY_ENABLED=localEnv.CODEX_NTFY_ENABLED||'true';
  notifications.CODEX_NTFY_DEFAULT_ENABLED=localEnv.CODEX_NTFY_DEFAULT_ENABLED||'true';
}
const payload=JSON.stringify({buildId,remoteToken,devicePassword:randomBytes(32).toString('hex'),sessionSecret:randomBytes(32).toString('hex'),notifications});
const installed=JSON.parse(run('ssh',['code-ai-pci',`sudo -n /usr/bin/node ${remoteStage}/install-guest.mjs`],{input:payload}));
const verified=JSON.parse(run('ssh',['code-ai-pci',`${release}/bin/node --env-file=/var/lib/code-ai-pci/runtime.env ${remoteStage}/verify-guest.mjs`]));
assert.equal(verified.ok,true);
// Never lose a concurrent registry edit or overwrite existing hosts/tokens.
assert.equal(await readFile(registryPath,'utf8'),initialRegistry,'Registry changed concurrently; leave the new service unregistered for review');
await copyFile(registryPath,stage+'/registry-before.json');
await chmod(stage+'/registry-before.json',0o600);
registry.hosts.push({id:'pci',label:'PCI — ארה״ב',transport:'ssh',enabled:true,token:remoteToken,sshTarget:'code-ai-pci',remotePort:4010,description:'ColoCrossing · VM נפרדת · Admin'});
const temporary=registryPath+`.pci-${process.pid}.tmp`;
await writeFile(temporary,JSON.stringify(registry,null,2)+'\n',{mode:0o600,flag:'wx'});
await rename(temporary,registryPath);
await chmod(registryPath,0o600);
const receipt={...installed,...verified,serverId:'pci',registryUpdated:true,registryMode:(await stat(registryPath)).mode&0o777,archiveDigest,buildId,notificationsEnabled:notifications.CODEX_NTFY_ENABLED==='true',originalHostsPreserved:true};
await writeFile(stage+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({...receipt,receiptPath:stage+'/receipt.json'}));
