#!/usr/bin/env node
// Publish only allowlisted public identities and a verified extension artifact.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizePublicKey } from './register-public.mjs';
import { PC_CLIENT_KEY, runSafe } from './prepare-server.mjs';

const buildId=process.argv[2];
if(!/^[a-f0-9-]{36}$/.test(buildId||''))throw new Error('Expected a verified build id');
const imports='/mnt/hdd/code-ai-builds/windows-reconnect-imports';
runSafe('bina-build',['verify-import',buildId,'--import-root',imports]);
const artifact=path.join(imports,buildId,'artifact/dist');
const hashes=JSON.parse(await fs.readFile(artifact+'/package-hashes.json','utf8'));
if(hashes.version!=='1.5.1'||hashes.backendChanged!==false)throw new Error('Unexpected extension artifact');
for(const [name,digest]of Object.entries(hashes.files)) {
  if(path.basename(name)!==name)throw new Error('Unexpected artifact path');
  if(createHash('sha256').update(await fs.readFile(artifact+'/CODE-AI-Chrome-Extension/'+name)).digest('hex')!==digest)throw new Error('Extension hash mismatch');
}
const centralHost=normalizePublicKey(await fs.readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8'));
const pciHost=normalizePublicKey(runSafe('/usr/bin/ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','code-ai-pci-host','sudo -n /usr/bin/head -n 1 /etc/ssh/ssh_host_ed25519_key.pub']));
const fingerprint=key=>'SHA256:'+createHash('sha256').update(Buffer.from(key.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'');
if(fingerprint(centralHost)!=='SHA256:6xNxgpDHSgKimuH18twY/iudAG2TH8sAFpOqEdLEBEM'||fingerprint(pciHost)!=='SHA256:thugowP6jCGGEeB0+moKaOOTl+Jx11crqaGG0Pd7B0I')throw new Error('Pinned server host key changed; do not publish');
const controller=normalizePublicKey(await fs.readFile(PC_CLIENT_KEY+'.pub','utf8'));
const staging=await fs.mkdtemp('/mnt/hdd/code-ai-builds/windows-reconnect-packet-');
const basename='CODE-AI-Windows-Reconnect-20261008';
const packet=path.join(staging,basename);
await fs.mkdir(packet+'/keys',{recursive:true,mode:0o755});
await fs.cp(artifact+'/CODE-AI-Chrome-Extension',packet+'/CODE-AI-Chrome-Extension',{recursive:true});
await fs.copyFile('ops/windows-reconnect/windows-codex-prompt.txt',packet+'/windows-codex-prompt.txt');
await fs.copyFile('ops/windows-reconnect/README.md',packet+'/README.md');
await fs.copyFile(artifact+'/package-hashes.json',packet+'/extension-qualification.json');
await fs.writeFile(packet+'/keys/controller-to-windows.pub',controller+'\n',{mode:0o644});
await fs.writeFile(packet+'/keys/servers_known_hosts',`162.55.2.222 ${centralHost}\n198.23.160.30 ${pciHost}\n`,{mode:0o644});
await fs.writeFile(packet+'/HOSTS.json',JSON.stringify({format:'code-ai-windows-reconnect-public',version:1,central:{host:'162.55.2.222',sshPort:22,user:'codeai-windows',fingerprint:fingerprint(centralHost)},pci:{host:'198.23.160.30',sshPort:22,user:'binapay-admin',fingerprint:fingerprint(pciHost)},controllerPublicFingerprint:fingerprint(controller),reverse:{ssh:44022,personalComputerApi:44001,bind:'127.0.0.1',apiAgentIncluded:false},extension:{version:'1.5.1',origin:'https://app-codex.bina-cshera.co.il',buildId,nativeWindowsVerification:'pending'},windowsPublicRegistration:'awaiting-owner-report',privateKeysIncluded:false},null,2)+'\n',{mode:0o644});
const publicHashes={};
async function collect(dir,rel='') {
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const next=rel?rel+'/'+entry.name:entry.name;
    if(entry.isDirectory())await collect(dir+'/'+entry.name,next);
    else if(entry.isFile())publicHashes[next]=createHash('sha256').update(await fs.readFile(dir+'/'+entry.name)).digest('hex');
    else throw new Error('Symlink or unsupported packet entry');
  }
}
await collect(packet);
await fs.writeFile(packet+'/SHA256SUMS.json',JSON.stringify(publicHashes,null,2)+'\n',{mode:0o644});
const output='/root/projects/code-ai/.code-ai/uploads/'+basename+'-1.5.1-'+buildId+'.zip';
try{await fs.access(output);throw new Error('Public packet already exists; inspect instead of overwrite');}catch(error){if(error.code!=='ENOENT')throw error;}
const result=spawnSync('/usr/bin/zip',['-q','-r',output,basename],{cwd:staging,encoding:'utf8',timeout:20000});
if(result.error||result.status!==0)throw new Error('Public packet archive failed');
await fs.chmod(output,0o644);
const archive=await fs.readFile(output);
console.log(JSON.stringify({packet:output,staging,buildId,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),privateKeysIncluded:false,apiTokensIncluded:false,nativeWindowsVerification:'pending',backendChanged:false}));
