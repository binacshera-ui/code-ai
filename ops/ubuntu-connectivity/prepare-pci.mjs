import fs from 'node:fs/promises';import os from 'node:os';import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';import {validateReport,CENTRAL_PIN,validateKey} from './contract.mjs';

const root=new URL('./',import.meta.url);
const report=JSON.parse(await fs.readFile(new URL('code-ai-ubuntu-public.json',root),'utf8'));validateReport(report);
const hostKey=(await fs.readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8')).trim();
if(validateKey(hostKey)!==CENTRAL_PIN)throw new Error('CENTRAL_HOST_KEY_MISMATCH');
const node='/srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node';
const payload={report,centralHostKey:hostKey,contract:await fs.readFile(new URL('contract.mjs',root),'utf8'),
 checker:await fs.readFile(new URL('pci-ubuntu-check.mjs',root),'utf8'),node};
const body=await fs.readFile(new URL('pci-install-body.mjs',root),'utf8');
const script=`const payload=JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(payload)).toString('base64')}','base64').toString());\n`+body;
const result=JSON.parse(execFileSync('/usr/bin/ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8',
 '-o','HostKeyAlgorithms=ssh-ed25519','-o','StrictHostKeyChecking=yes','code-ai-pci-host',node+' --input-type=module'],
 {input:script,encoding:'utf8',timeout:40000,maxBuffer:1024*1024}));
validateKey(result.relayPublicKey);
if(result.pciClientRegistered!==true||result.existingKeysPreserved!==true)throw new Error('PCI_REGISTRATION_NOT_VERIFIED');
await fs.writeFile(new URL('pci-registration-receipt.json',root),JSON.stringify(result,null,2)+'\n',{mode:0o644});
console.log(JSON.stringify(result));
