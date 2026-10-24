// Uploaded as an SSH stdin program; payload contains public values only.
import fs from 'node:fs/promises';import os from 'node:os';import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
if(os.userInfo().username!=='binapay-admin'||os.hostname()!=='binapay-cde-host')throw new Error('PCI_IDENTITY_MISMATCH');
const base='/home/binapay-admin/.ssh';await fs.mkdir(base,{mode:0o700,recursive:true});
async function read(file){try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
async function ownFile(file,contents,mode=0o600){const current=await read(file);if(current&&current!==contents)throw new Error('OWNED_FILE_CONFLICT');if(!current)await fs.writeFile(file,contents,{mode,flag:'wx'});}
const contract=base+'/code-ai-ubuntu-contract.mjs';const checker=base+'/code-ai-ubuntu-check.mjs';
await ownFile(contract,payload.contract);await ownFile(checker,payload.checker);
const auth=base+'/authorized_keys';const beforeKeys=await read(auth);
const keyBlob=payload.report.pciPublicKey.split(' ')[1];
const keyLine=`restrict,command="${payload.node} ${checker}" ${payload.report.pciPublicKey} code-ai-ubuntu-client-refael-gpu-lab`;
const matches=beforeKeys.split('\n').filter(l=>l.match(/\bssh-ed25519\s+([A-Za-z0-9+/=]+)/)?.[1]===keyBlob);
if(matches.length>1||(matches.length===1&&matches[0]!==keyLine))throw new Error('EXISTING_UBUNTU_PCI_KEY_POLICY_CONFLICT');
if(matches.length===0)await fs.appendFile(auth,(beforeKeys&&!beforeKeys.endsWith('\n')?'\n':'')+keyLine+'\n',{mode:0o600});
const afterKeys=await read(auth);
if(!afterKeys.startsWith(beforeKeys)||!afterKeys.split('\n').includes(keyLine))throw new Error('PCI_KEY_PRESERVATION_FAILED');
await fs.chmod(auth,0o600);
const identity=base+'/id_ed25519_code_ai_ubuntu_relay_gpu_lab';
try{await fs.stat(identity);}catch(e){if(e.code!=='ENOENT')throw e;execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',identity,'-C','code-ai-pci-ubuntu-relay-binapay-admin-refael-gpu-lab']);}
await fs.chmod(identity,0o600);
const relayPublicKey=execFileSync('/usr/bin/ssh-keygen',['-y','-f',identity],{encoding:'utf8'}).trim().split(/\s+/).slice(0,2).join(' ')+' code-ai-pci-ubuntu-relay-binapay-admin-refael-gpu-lab';
const known=base+'/code_ai_ubuntu_relay_known_hosts';
await ownFile(known,'162.55.2.222 '+payload.centralHostKey.split(' ').slice(0,2).join(' ')+'\n');
const peer=base+'/code-ai-ubuntu-relay_config';
await ownFile(peer,`Host personal-ubuntu-ssh\n  HostName 162.55.2.222\n  Port 22\n  User root\n  IdentityFile ${identity}\n  UserKnownHostsFile ${known}\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  ForwardAgent no\n  ClearAllForwardings yes\n  RequestTTY no\nHost *\n`);
const config=base+'/config';const oldConfig=await read(config);const include='Include '+peer+'\n';
if(!oldConfig.startsWith(include)){
 if(oldConfig.includes(peer))throw new Error('PCI_INCLUDE_SCOPE_CONFLICT');
 if(await read(config)!==oldConfig)throw new Error('PCI_CONFIG_CHANGED_CONCURRENTLY');
 await fs.writeFile(config,include+oldConfig,{mode:0o600});
}
const afterConfig=await read(config);if(!afterConfig.endsWith(oldConfig))throw new Error('PCI_CONFIG_PRESERVATION_FAILED');
const effective=execFileSync('/usr/bin/ssh',['-G','personal-ubuntu-ssh'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
for(const exact of ['hostname 162.55.2.222','user root','stricthostkeychecking true','forwardagent no','identitiesonly yes','batchmode yes'])if(!effective.split('\n').includes(exact))throw new Error('PCI_RELAY_CONFIG_NOT_EFFECTIVE');
console.log(JSON.stringify({pciClientRegistered:true,existingKeysPreserved:true,existingConfigPreserved:true,
 relayPublicKey,pciUser:os.userInfo().username,pciHostname:os.hostname(),relayCommands:['hostname','id','id -un'],
 ubuntuClientCommands:['hostname','id','id -un']}));
