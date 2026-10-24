#!/usr/bin/env node
// Run only after the owner supplies the public report from the new Windows PC.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WINDOWS_LINK_USER, WINDOWS_LINK_HOME, PC_CLIENT_KEY, runSafe } from './prepare-server.mjs';

export function normalizePublicKey(input) {
  const parts = String(input || '').trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/=]+$/.test(parts[1])) throw new Error('Expected only an ED25519 public key');
  const bytes = Buffer.from(parts[1], 'base64');
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 || bytes.subarray(4,15).toString() !== 'ssh-ed25519' || bytes.readUInt32BE(15) !== 32) throw new Error('Invalid public key encoding');
  return parts.slice(0,2).join(' ');
}

export function validateReport(value) {
  if (!value || value.format !== 'code-ai-windows-public-bootstrap' || value.version !== 1) throw new Error('Unsupported public report');
  const allowed = new Set(['format','version','windowsUsername','windowsComputerName','centralPublicKey','pciPublicKey','windowsHostPublicKey']);
  if (Object.keys(value).some(k=>!allowed.has(k))) throw new Error('Public report contains unexpected fields');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value.windowsUsername)) throw new Error('Expected the local Windows username, not an Entra/domain identity');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(value.windowsComputerName)) throw new Error('Invalid Windows computer name');
  return { ...value, centralPublicKey: normalizePublicKey(value.centralPublicKey), pciPublicKey: normalizePublicKey(value.pciPublicKey), windowsHostPublicKey: normalizePublicKey(value.windowsHostPublicKey) };
}

function appendOwnedKey(filename, keyLine, comment, uid, gid) {
  const previous = fs.existsSync(filename) ? fs.readFileSync(filename,'utf8') : '';
  const matches = previous.split('\n').filter(l=>l.endsWith(' '+comment));
  if (matches.length>1 || (matches.length && matches[0]!==keyLine)) throw new Error('Registered key changed; explicit replacement required');
  if (!matches.length) {
    const tmp=filename+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,previous+(previous&&!previous.endsWith('\n')?'\n':'')+keyLine+'\n',{mode:0o600,flag:'wx'});
    fs.chownSync(tmp,uid,gid);
    fs.renameSync(tmp,filename);
  }
}

export function registerCentral(report) {
  const account=runSafe('/usr/bin/getent',['passwd',WINDOWS_LINK_USER]).trim().split(':');
  const comment='code-ai-new-windows-20261008';
  // Restrict reverse listeners to the existing private computer ports. No agent forwarding.
  const line=`restrict,pty,port-forwarding,permitlisten="127.0.0.1:44022",permitlisten="127.0.0.1:44001",permitopen="127.0.0.1:44022" ${report.centralPublicKey} ${comment}`;
  if(Number(account[2])===0||account[5]!==WINDOWS_LINK_HOME)throw new Error('Unexpected Windows connection account');
  const hostFile='/root/.ssh/code-ai-new-windows_known_hosts';
  const expected=`[127.0.0.1]:44022 ${report.windowsHostPublicKey}\n`;
  if(fs.existsSync(hostFile)&&fs.readFileSync(hostFile,'utf8')!==expected)throw new Error('New Windows host key changed; explicit review required');
  const candidate='/root/.ssh/personal-windows-new_config';
  const config=`Host personal-windows-new-ssh\n  HostName 127.0.0.1\n  Port 44022\n  User ${report.windowsUsername}\n  IdentityFile ${PC_CLIENT_KEY}\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${hostFile}\n  ConnectTimeout 10\n  ForwardAgent no\n`;
  if(fs.existsSync(candidate)&&fs.readFileSync(candidate,'utf8')!==config)throw new Error('New Windows SSH candidate changed; inspect before replacing');
  appendOwnedKey(WINDOWS_LINK_HOME+'/.ssh/authorized_keys',line,comment,Number(account[2]),Number(account[3]));
  if(!fs.existsSync(hostFile))fs.writeFileSync(hostFile,expected,{mode:0o600,flag:'wx'});
  if(!fs.existsSync(candidate))fs.writeFileSync(candidate,config,{mode:0o600,flag:'wx'});
  return {account:WINDOWS_LINK_USER,remotePorts:[44022,44001],candidateConfig:candidate,oldSshAliasPreserved:true,credentialRotation:false};
}

export function registerPci(report) {
  const comment='code-ai-new-windows-pci-20261008';
  // Input is a validated public key only. The remote installer never prints existing keys.
  const script=`import fs from 'node:fs';\nconst filename='/home/binapay-admin/.ssh/authorized_keys';\nconst comment=${JSON.stringify(comment)};\nconst line=${JSON.stringify(`restrict,pty ${report.pciPublicKey} ${comment}`)};\nconst previous=fs.readFileSync(filename,'utf8');\nconst lines=previous.split('\\n').filter(l=>l.endsWith(' '+comment));\nif(lines.length>1||(lines.length&&lines[0]!==line))throw new Error('Conflicting Windows PCI key');\nif(!lines.length){const stat=fs.statSync(filename);const tmp=filename+'.new-windows-'+process.pid;fs.writeFileSync(tmp,previous+(previous.endsWith('\\n')?'':'\\n')+line+'\\n',{mode:0o600,flag:'wx'});fs.chownSync(tmp,stat.uid,stat.gid);fs.renameSync(tmp,filename);}\nconsole.log(JSON.stringify({pciPublicKeyRegistered:true,sshRestartRequired:false}));\n`;
  const r=spawnSync('/usr/bin/ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','code-ai-pci-host','sudo -n /srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node --input-type=module'],{input:script,encoding:'utf8',timeout:30000});
  if(r.error||r.status!==0)throw new Error('PCI public key registration failed; inspect metadata without dumping keys/config');
  return JSON.parse(r.stdout);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    const report=validateReport(input);
    if(process.argv[3]!=='--apply'){console.log(JSON.stringify({valid:true,user:report.windowsUsername,computer:report.windowsComputerName,applied:false}));}
    else{console.log(JSON.stringify({central:registerCentral(report),pci:registerPci(report),workloadsRestarted:false}));}
  }catch(e){console.error(e.message);process.exitCode=1;}
}
