import fs from 'node:fs/promises';import net from 'node:net';import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateReport,validateKey,CENTRAL_PIN,handoff} from './contract.mjs';
import {verifyTunnelAccount,sudoExplicitlyDenied} from './auth-fixture.mjs';

const root=new URL('./',import.meta.url);
const report=JSON.parse(await fs.readFile(new URL('code-ai-ubuntu-public.json',root),'utf8'));const fingerprints=validateReport(report);
const pci=JSON.parse(await fs.readFile(new URL('pci-registration-receipt.json',root),'utf8'));validateKey(pci.relayPublicKey);
if(pci.pciClientRegistered!==true||pci.pciUser!=='binapay-admin'||pci.pciHostname!=='binapay-cde-host')throw new Error('PCI_RECEIPT_INVALID');
const hostKey=(await fs.readFile('/etc/ssh/ssh_host_ed25519_key.pub','utf8')).trim();
if(validateKey(hostKey)!==CENTRAL_PIN)throw new Error('CENTRAL_HOST_KEY_MISMATCH');
const state='/var/lib/code-ai-ubuntu-gpu-lab';await fs.mkdir(state,{recursive:true,mode:0o700});
async function read(file){try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
function digest(value){return crypto.createHash('sha256').update(value).digest('hex');}
const unchangedFiles=['/root/.ssh/personal-windows-new_config','/usr/local/libexec/code-ai/pci-windows-relay.mjs',
 '/root/projects/code-ai/.code-ai/remote-hosts.json','/etc/ssh/sshd_config.d/99-codex-stability.conf'];
const untouched=Object.fromEntries(await Promise.all(unchangedFiles.map(async p=>[p,digest(await fs.readFile(p))])));
const oldAliasNames=['personal-windows-ssh','personal-windows-new-ssh','code-ai-pci-host'];
const sshView=alias=>execFileSync('/usr/bin/ssh',['-G',alias],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
const oldViews=Object.fromEntries(oldAliasNames.map(a=>[a,digest(sshView(a))]));
const oldRootKeys=await read('/root/.ssh/authorized_keys');
const oldRootConfig=await read('/root/.ssh/config');
const oldSshd=await read('/etc/ssh/sshd_config');
const beforePid=execFileSync('systemctl',['show','ssh.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
const oldPolicies=Object.fromEntries(['root','codeai-windows','codeai-pci'].map(user=>[user,digest(execFileSync('/usr/sbin/sshd',['-T','-C',`user=${user},host=peer,addr=198.23.160.30`],{encoding:'utf8'}))]));

let port=44023;
const prior=await read(state+'/relay.json');
if(prior){const p=JSON.parse(prior);if(p.ubuntuUsername!=='refael'||p.ubuntuComputerName!=='gpu-lab')throw new Error('UBUNTU_PORT_OWNER_CONFLICT');port=p.port;}
else{
 const users=execFileSync('getent',['passwd'],{encoding:'utf8'}).split('\n').filter(l=>/^codeai-/.test(l)).map(l=>l.split(':'));
 const reserved=new Set([44022,44001]);
 for(const user of users)for(const line of (await read(user[5]+'/.ssh/authorized_keys')).split('\n'))for(const m of line.matchAll(/permitlisten="127\.0\.0\.1:(\d+)"/g))reserved.add(Number(m[1]));
 async function free(p){const s=net.createServer();return await new Promise(resolve=>{s.once('error',()=>resolve(false));s.listen(p,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
 for(;port<44123;port++)if(!reserved.has(port)&&await free(port))break;
 if(port>=44123)throw new Error('NO_SEPARATE_UBUNTU_PORT_AVAILABLE');
}
if(!Number.isSafeInteger(port)||port===44022||port<1024||port>65535)throw new Error('INVALID_UBUNTU_PORT');

const controller='/root/.ssh/code-ai-personal-ubuntu-gpu-lab-20261008_ed25519';
try{await fs.stat(controller);}catch(e){if(e.code!=='ENOENT')throw e;execFileSync('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',controller,'-C','code-ai-controller-refael@gpu-lab-20261008'],{stdio:'ignore'});}
await fs.chmod(controller,0o600);
const derived=execFileSync('/usr/bin/ssh-keygen',['-y','-f',controller],{encoding:'utf8'}).trim().split(/\s+/).slice(0,2).join(' ');validateKey(derived);
const controllerPublicKey=derived+' code-ai-controller-refael@gpu-lab-20261008';
if(Object.values(fingerprints).includes(validateKey(controllerPublicKey)))throw new Error('CONTROLLER_KEY_NOT_DISTINCT');
const windowsPublic=await read('/root/.ssh/code-ai-personal-windows-20261008_ed25519.pub');
if(windowsPublic&&validateKey(windowsPublic.trim())===validateKey(controllerPublicKey))throw new Error('WINDOWS_KEY_REUSED');
async function ownFile(file,value,mode=0o600){const old=await read(file);if(old&&old!==value)throw new Error('OWNED_CONFIGURATION_CONFLICT');if(!old)await fs.writeFile(file,value,{flag:'wx',mode});}
await ownFile(state+'/relay.json',JSON.stringify({targetAlias:'personal-ubuntu-ssh',ubuntuUsername:'refael',ubuntuComputerName:'gpu-lab',port})+'\n');
const known='/root/.ssh/code-ai-personal-ubuntu-gpu-lab_known_hosts';
await ownFile(known,`[127.0.0.1]:${port} ${report.ubuntuHostPublicKey}\n`);
const peer='/root/.ssh/personal-ubuntu-ssh_config';
await ownFile(peer,`Host personal-ubuntu-ssh\n  HostName 127.0.0.1\n  Port ${port}\n  User ${report.ubuntuUsername}\n  IdentityFile ${controller}\n  UserKnownHostsFile ${known}\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n  IdentitiesOnly yes\n  BatchMode yes\n  ForwardAgent no\n  ClearAllForwardings yes\n  RequestTTY no\nHost *\n`);
const include='Include '+peer+'\n';
if(!oldRootConfig.startsWith(include)){
 if(oldRootConfig.includes(peer))throw new Error('ROOT_INCLUDE_SCOPE_CONFLICT');
 if(await read('/root/.ssh/config')!==oldRootConfig)throw new Error('ROOT_CONFIG_CHANGED_CONCURRENTLY');
 await fs.writeFile('/root/.ssh/config',include+oldRootConfig,{mode:0o600});
}
for(const alias of oldAliasNames)if(digest(sshView(alias))!==oldViews[alias]){
 if(await read('/root/.ssh/config')===include+oldRootConfig)await fs.writeFile('/root/.ssh/config',oldRootConfig,{mode:0o600});
 throw new Error('EXISTING_SSH_ALIAS_CHANGED');
}
const effectiveAlias=sshView('personal-ubuntu-ssh');
for(const exact of ['hostname 127.0.0.1',`port ${port}`,'user refael','stricthostkeychecking true','identitiesonly yes','batchmode yes','forwardagent no'])if(!effectiveAlias.split('\n').includes(exact))throw new Error('UBUNTU_ALIAS_NOT_EFFECTIVE');

let passwd='';try{passwd=execFileSync('getent',['passwd','codeai-ubuntu'],{encoding:'utf8'}).trim();}catch(e){if(e.status!==2)throw e;}
if(!passwd){execFileSync('/usr/sbin/useradd',['--system','--create-home','--home-dir','/var/lib/code-ai-ubuntu-link','--shell','/usr/sbin/nologin','--user-group','codeai-ubuntu'],{stdio:'pipe'});passwd=execFileSync('getent',['passwd','codeai-ubuntu'],{encoding:'utf8'}).trim();}
const p=passwd.split(':');const uid=Number(p[2]),gid=Number(p[3]),home=p[5];
if(p[0]!=='codeai-ubuntu'||home!=='/var/lib/code-ai-ubuntu-link'||p[6]!=='/usr/sbin/nologin'||uid===0)throw new Error('ACCOUNT_REUSE_POLICY_CONFLICT');
const groups=execFileSync('id',['-Gn','codeai-ubuntu'],{encoding:'utf8'}).trim().split(/\s+/);
if(groups.length!==1||groups[0]!=='codeai-ubuntu')throw new Error('ACCOUNT_HAS_EXTRA_PRIVILEGE_GROUPS');
let sudoDenied=false;try{sudoDenied=sudoExplicitlyDenied(execFileSync('/usr/bin/sudo',['-n','-l','-U','codeai-ubuntu'],{encoding:'utf8',env:{...process.env,LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe']}));}catch(e){sudoDenied=sudoExplicitlyDenied(String(e.stdout||'')+String(e.stderr||''));}
if(!sudoDenied)throw new Error('ACCOUNT_HAS_SUDO_AUTHORIZATION');
const shadow=execFileSync('getent',['shadow','codeai-ubuntu'],{encoding:'utf8'}).trim().split(':');
if(!/^[!*]/.test(shadow[1])||shadow[7])throw new Error('ACCOUNT_PASSWORD_OR_EXPIRY_POLICY_CONFLICT');
if(await read('/etc/nologin'))throw new Error('PAM_NOLOGIN_BLOCKS_NEW_TUNNEL');
const authDir=home+'/.ssh';await fs.mkdir(authDir,{recursive:true,mode:0o700});await fs.chown(authDir,uid,gid);await fs.chmod(authDir,0o700);
const auth=authDir+'/authorized_keys';const existingAccountKeys=await read(auth);
const centralKeyLine=`restrict,port-forwarding,permitlisten="127.0.0.1:${port}" ${report.centralPublicKey} code-ai-ubuntu-tunnel-refael-gpu-lab`;
if(existingAccountKeys&&existingAccountKeys!==centralKeyLine+'\n')throw new Error('DEDICATED_ACCOUNT_KEY_CONFLICT');

const fixture=await fs.mkdtemp('/run/code-ai-ubuntu-auth-check-');
const accountProof=await verifyTunnelAccount({directory:fixture,controller,controllerPublicKey,centralHostKey:hostKey});
console.log(JSON.stringify({stage:'isolated-auth-contract',...accountProof}));

await fs.mkdir('/etc/ssh/code-ai-accounts',{recursive:true,mode:0o755});
const accountConfig='/etc/ssh/code-ai-accounts/ubuntu-gpu-lab.conf';
await ownFile(accountConfig,`Match User codeai-ubuntu\n  AuthenticationMethods publickey\n  PubkeyAuthentication yes\n  PubkeyAcceptedAlgorithms ssh-ed25519\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  AuthorizedKeysFile ${auth}\n  AuthorizedKeysCommand none\n  AllowTcpForwarding remote\n  GatewayPorts no\n  PermitListen 127.0.0.1:${port}\n  PermitOpen none\n  MaxSessions 0\n  AllowAgentForwarding no\n  X11Forwarding no\n  PermitTTY no\nMatch all\n`,0o644);
const suffix='\n# CODE-AI Ubuntu gpu-lab: dedicated tunnel account only\nInclude '+accountConfig+'\n';
if(oldSshd.includes(accountConfig)&&!oldSshd.endsWith(suffix))throw new Error('SSHD_INCLUDE_SCOPE_CONFLICT');
const candidate=oldSshd.endsWith(suffix)?oldSshd:oldSshd+suffix;
const candidatePath=state+'/sshd-candidate.conf';await fs.writeFile(candidatePath,candidate,{mode:0o600});
execFileSync('/usr/sbin/sshd',['-t','-f',candidatePath],{stdio:'pipe'});
const actualPolicy=execFileSync('/usr/sbin/sshd',['-T','-f',candidatePath,'-C','user=codeai-ubuntu,host=gpu-lab,addr=127.0.0.1'],{encoding:'utf8'});
for(const line of ['usepam yes','authenticationmethods publickey','passwordauthentication no','kbdinteractiveauthentication no','allowtcpforwarding remote','gatewayports no',`permitlisten 127.0.0.1:${port}`,'permitopen none','maxsessions 0','permittty no','allowagentforwarding no'])if(!actualPolicy.split('\n').includes(line))throw new Error('TUNNEL_EFFECTIVE_POLICY_FAILED');
for(const user of Object.keys(oldPolicies))if(digest(execFileSync('/usr/sbin/sshd',['-T','-f',candidatePath,'-C',`user=${user},host=peer,addr=198.23.160.30`],{encoding:'utf8'}))!==oldPolicies[user])throw new Error('OTHER_ACCOUNT_POLICY_CHANGED');
let reloaded=false;
if(candidate!==oldSshd){
 if(await read('/etc/ssh/sshd_config')!==oldSshd)throw new Error('SSHD_CONFIG_CHANGED_CONCURRENTLY');
 await fs.writeFile(state+'/sshd-before.conf',oldSshd,{mode:0o600});
 await fs.writeFile('/etc/ssh/sshd_config',candidate,{mode:0o644});
 try{execFileSync('/usr/sbin/sshd',['-t'],{stdio:'pipe'});execFileSync('systemctl',['reload','ssh.service'],{stdio:'pipe'});reloaded=true;}
 catch(e){if(await read('/etc/ssh/sshd_config')===candidate)await fs.writeFile('/etc/ssh/sshd_config',oldSshd,{mode:0o644});throw new Error('SSHD_RELOAD_FAILED');}
}
await fs.writeFile(auth,centralKeyLine+'\n',{mode:0o600});await fs.chown(auth,uid,gid);await fs.chmod(auth,0o600);
if(await read(auth)!==centralKeyLine+'\n')throw new Error('CENTRAL_KEY_REGISTRATION_NOT_VERIFIED');
const lib='/usr/local/libexec/code-ai';await fs.mkdir(lib,{recursive:true,mode:0o755});
await ownFile(lib+'/ubuntu-contract.mjs',await fs.readFile(new URL('contract.mjs',root),'utf8'),0o644);
await ownFile(lib+'/pci-ubuntu-relay.mjs',await fs.readFile(new URL('pci-ubuntu-relay.mjs',root),'utf8'),0o755);
const routeLine=`from="198.23.160.30",restrict,command="/usr/bin/node ${lib}/pci-ubuntu-relay.mjs" ${pci.relayPublicKey}`;
const routeMatches=oldRootKeys.split('\n').filter(l=>l.match(/\bssh-ed25519\s+([A-Za-z0-9+/=]+)/)?.[1]===pci.relayPublicKey.split(' ')[1]);
if(routeMatches.length>1||(routeMatches.length===1&&routeMatches[0]!==routeLine))throw new Error('ROOT_RELAY_KEY_POLICY_CONFLICT');
if(routeMatches.length===0){if(await read('/root/.ssh/authorized_keys')!==oldRootKeys)throw new Error('ROOT_KEYS_CHANGED_CONCURRENTLY');await fs.appendFile('/root/.ssh/authorized_keys',(oldRootKeys&&!oldRootKeys.endsWith('\n')?'\n':'')+routeLine+'\n');}
if(!(await read('/root/.ssh/authorized_keys')).startsWith(oldRootKeys))throw new Error('EXISTING_ROOT_KEY_CHANGED');
for(const file of unchangedFiles)if(digest(await fs.readFile(file))!==untouched[file])throw new Error('PROTECTED_WINDOWS_OR_RUNTIME_FILE_CHANGED');
const afterPid=execFileSync('systemctl',['show','ssh.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
if(afterPid!==beforePid)throw new Error('SSHD_PID_CHANGED_UNEXPECTEDLY');
const result=handoff(report,controllerPublicKey,port,true,pci.pciClientRegistered);
const resultPath=new URL('code-ai-ubuntu-server-registration.json',root);await fs.writeFile(resultPath,JSON.stringify(result,null,2)+'\n',{mode:0o644});
await fs.writeFile(new URL('central-verification.json',root),JSON.stringify({centralRegistered:true,port,
 reportFingerprints:fingerprints,controllerFingerprint:validateKey(controllerPublicKey),ubuntuHostFingerprint:validateKey(report.ubuntuHostPublicKey),
 accountProof,accountPasswordLocked:true,accountNoSudoGroups:true,otherAccountPoliciesUnchanged:true,protectedWindowsFilesUnchanged:true,
 existingRootKeysPreserved:true,existingAliasesUnchanged:true,sshdReloaded:reloaded,sshdMainPidUnchanged:true,ubuntuActivationTested:false},null,2)+'\n');
console.log(JSON.stringify({stage:'server-side-registered',port,centralRegistered:true,pciRegistered:true,sshdReloaded:reloaded,
 sshdMainPidUnchanged:true,windowsPreserved:true,handoffFile:resultPath.pathname}));
