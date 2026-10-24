import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {CENTRAL_PIN, validateKey} from './contract.mjs';

// A separate login, explicitly requested after the tunnel-only handoff.
// This program never reads or transports private key contents.
const base = new URL('./', import.meta.url);
const account = 'codeai-ubuntu-access';
const accountHome = '/home/' + account;
const state = '/var/lib/code-ai-ubuntu-gpu-lab';
const mainPublic = (await fs.readFile('/etc/ssh/ssh_host_ed25519_key.pub', 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
if (validateKey(mainPublic) !== CENTRAL_PIN) throw new Error('CENTRAL_HOST_KEY_MISMATCH');
const run = (file, args) => execFileSync(file, args, {encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']}).trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = async file => fs.readFile(file, 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw error;});
const protections = [
  '/etc/ssh/code-ai-accounts/ubuntu-gpu-lab.conf',
  '/var/lib/code-ai-ubuntu-link/.ssh/authorized_keys',
  '/root/.ssh/personal-windows-new_config',
  '/usr/local/libexec/code-ai/pci-windows-relay.mjs',
  '/root/projects/code-ai/.code-ai/remote-hosts.json',
];
const beforeFiles = Object.fromEntries(await Promise.all(protections.map(async file => [file, hash(await fs.readFile(file))])));
const policy = (user, config) => run('/usr/sbin/sshd', ['-T', ...(config ? ['-f', config] : []), '-C', `user=${user},host=gpu-lab,addr=127.0.0.1`]);
const preservedUsers = ['root', 'codeai-ubuntu', 'codeai-windows', 'codeai-pci', 'developer'];
const beforePolicies = Object.fromEntries(preservedUsers.map(user => [user, hash(policy(user))]));
const daemonPid = run('systemctl', ['show', 'ssh.service', '-p', 'MainPID', '--value']);

const remote = source => execFileSync('/usr/bin/ssh', [
  '-T', '-o', 'ConnectTimeout=10', 'personal-ubuntu-ssh', '/usr/bin/node --input-type=module',
], {input: source, encoding: 'utf8', timeout: 45000, stdio: ['pipe', 'pipe', 'pipe']}).trim();
const remotePrelude = `
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}).trim();
if(run('/usr/bin/id',['-un'])!=='refael'||run('/usr/bin/hostname',[])!=='gpu-lab')throw new Error('UBUNTU_IDENTITY_MISMATCH');
const dir='/home/refael/.ssh';
await fs.mkdir(dir,{recursive:true,mode:0o700});
const key=dir+'/code-ai-main-access_ed25519';
`;
const client = JSON.parse(remote(remotePrelude + `
try { const st=await fs.lstat(key); if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o777)!==0o600)throw new Error('EXISTING_KEY_POLICY_CONFLICT'); }
catch(e){if(e.code!=='ENOENT')throw e;run('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',key,'-C','refael@gpu-lab-code-ai-main-access']);}
const publicKey=run('/usr/bin/ssh-keygen',['-y','-f',key]).split(/\\s+/).slice(0,2).join(' ');
console.log(JSON.stringify({publicKey,privateMode:'0600',privateKeyStaysOnUbuntu:true}));
`));
const clientFingerprint = validateKey(client.publicKey);
const originalReport = JSON.parse(await read(new URL('code-ai-ubuntu-public.json', base)));
for (const field of ['centralPublicKey', 'pciPublicKey', 'ubuntuHostPublicKey']) {
  if (clientFingerprint === validateKey(originalReport[field])) throw new Error('LOGIN_KEY_NOT_DISTINCT');
}

let record;
try { record = run('getent', ['passwd', account]); }
catch(error) {if(error.status !== 2) throw error;}
if (!record) {
  run('/usr/sbin/useradd', ['--create-home', '--home-dir', accountHome, '--shell', '/bin/bash', '--user-group', '--comment', 'Code AI access from refael@gpu-lab', account]);
  record = run('getent', ['passwd', account]);
}
const fields = record.split(':');
const uid = Number(fields[2]), gid = Number(fields[3]);
if (uid === 0 || fields[5] !== accountHome || fields[6] !== '/bin/bash' || run('id', ['-Gn', account]) !== account) throw new Error('LOGIN_ACCOUNT_POLICY_CONFLICT');
const shadow = run('getent', ['shadow', account]).split(':');
if (!/^[!*]/.test(shadow[1]) || shadow[7]) throw new Error('PASSWORD_OR_EXPIRY_POLICY_CONFLICT');
let sudoOutput;
try { sudoOutput = execFileSync('/usr/bin/sudo', ['-n', '-l', '-U', account], {encoding: 'utf8', env: {...process.env, LANG: 'C', LC_ALL: 'C'}, stdio: ['ignore','pipe','pipe']}); }
catch(error) { sudoOutput = String(error.stdout || '') + String(error.stderr || ''); }
if (!new RegExp('^User ' + account + ' is not allowed to run sudo on [^\\r\\n]+\\.?\\s*$').test(sudoOutput.trim())) throw new Error('LOGIN_ACCOUNT_HAS_SUDO');
await fs.mkdir(accountHome + '/workspace', {mode: 0o700, recursive: true});
await fs.chown(accountHome + '/workspace', uid, gid);

const accountConfig = '/etc/ssh/code-ai-accounts/ubuntu-main-access.conf';
const keysFile = '/etc/ssh/code-ai-accounts/ubuntu-main-access.authorized_keys';
async function ownedFile(file, value, mode) {
  const prior = await read(file);
  if (prior && prior !== value) throw new Error('EXISTING_FILE_CONFLICT: ' + file);
  if (!prior) await fs.writeFile(file, value, {flag: 'wx', mode});
}
await ownedFile(accountConfig, `Match User ${account}
  AuthenticationMethods publickey
  PubkeyAuthentication yes
  PubkeyAcceptedAlgorithms ssh-ed25519
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  AuthorizedKeysFile ${keysFile}
  AuthorizedKeysCommand none
  DisableForwarding yes
  AllowTcpForwarding no
  AllowStreamLocalForwarding no
  AllowAgentForwarding no
  X11Forwarding no
  PermitTunnel no
  PermitUserRC no
  PermitTTY yes
  MaxSessions 4
Match all
`, 0o644);
const sshdFile = '/etc/ssh/sshd_config';
const original = await read(sshdFile);
const suffix = '\n# CODE-AI: separate Ubuntu-to-main non-sudo login\nInclude ' + accountConfig + '\n';
if (original.includes(accountConfig) && !original.endsWith(suffix)) throw new Error('INCLUDE_SCOPE_CONFLICT');
const candidate = original.endsWith(suffix) ? original : original + suffix;
const candidateFile = state + '/main-access-sshd-candidate.conf';
await fs.writeFile(candidateFile, candidate, {mode: 0o600});
run('/usr/sbin/sshd', ['-t', '-f', candidateFile]);
for (const user of preservedUsers) if (hash(policy(user, candidateFile)) !== beforePolicies[user]) throw new Error('EXISTING_ACCOUNT_POLICY_CHANGED: ' + user);
const effective = policy(account, candidateFile).split('\n');
for (const line of ['usepam yes', 'authenticationmethods publickey', 'passwordauthentication no', 'kbdinteractiveauthentication no', 'disableforwarding yes', 'allowagentforwarding no', 'permittty yes', 'maxsessions 4', 'forcecommand none', 'authorizedkeysfile ' + keysFile]) {
  if (!effective.includes(line)) throw new Error('NEW_POLICY_NOT_EFFECTIVE: ' + line);
}
if (candidate !== original) {
  if (await read(sshdFile) !== original) throw new Error('SSHD_CHANGED_CONCURRENTLY');
  await ownedFile(state + '/main-access-sshd-before.conf', original, 0o600);
  await fs.writeFile(sshdFile, candidate, {mode: 0o644});
  try {run('/usr/sbin/sshd', ['-t']); run('systemctl', ['reload', 'ssh.service']);}
  catch(error) {if (await read(sshdFile) === candidate) {await fs.writeFile(sshdFile, original, {mode:0o644}); run('/usr/sbin/sshd',['-t']); run('systemctl',['reload','ssh.service']);} throw new Error('SSH_RELOAD_FAILED');}
}
if (run('systemctl', ['show', 'ssh.service', '-p', 'MainPID', '--value']) !== daemonPid) throw new Error('SSHD_MAIN_PID_CHANGED');
await ownedFile(keysFile, 'restrict,pty ' + client.publicKey + ' refael@gpu-lab-main-access\n', 0o644);
console.log(JSON.stringify({stage:'main-login-registered',account,clientFingerprint,privateKeyStaysOnUbuntu:true,sshdPidUnchanged:true}));

const remoteAlias = `Host code-ai-main code-ai-main-ssh
  HostName 162.55.2.222
  Port 22
  User ${account}
  IdentityFile /home/refael/.ssh/code-ai-main-access_ed25519
  UserKnownHostsFile /home/refael/.ssh/code-ai-main-access_known_hosts
  StrictHostKeyChecking yes
  HostKeyAlgorithms ssh-ed25519
  IdentitiesOnly yes
  BatchMode yes
  ForwardAgent no
  ClearAllForwardings yes
  ConnectTimeout 10
Host *
`;
const ubuntuInstall = JSON.parse(remote(remotePrelude + `
const values=${JSON.stringify({alias:remoteAlias,known:'162.55.2.222 '+mainPublic+'\n'})};
async function read(p){try{return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
async function owned(p,value){const old=await read(p);if(old&&old!==value)throw new Error('EXISTING_UBUNTU_CONFIG_CONFLICT');if(!old)await fs.writeFile(p,value,{flag:'wx',mode:0o600});}
await owned(dir+'/code-ai-main-access_known_hosts',values.known);
await owned(dir+'/code-ai-main-access_config',values.alias);
const config=dir+'/config',old=await read(config),include='Include '+dir+'/code-ai-main-access_config\\n';
if(!old.startsWith(include)){if(old.includes(dir+'/code-ai-main-access_config'))throw new Error('SSH_INCLUDE_CONFLICT');if(await read(config)!==old)throw new Error('SSH_CONFIG_CHANGED_CONCURRENTLY');await fs.writeFile(config,include+old,{mode:0o600});}
const identity=run('/usr/bin/ssh',['code-ai-main','hostname; id -un']).split('\\n');
if(identity.length!==2||identity[1]!==${JSON.stringify(account)})throw new Error('MAIN_LOGIN_IDENTITY_MISMATCH');
console.log(JSON.stringify({hostname:identity[0],username:identity[1],alias:'code-ai-main',strictHostKeyChecking:true}));
`));
if (ubuntuInstall.hostname !== run('hostname', [])) throw new Error('MAIN_HOSTNAME_MISMATCH');
for (const file of protections) if (hash(await fs.readFile(file)) !== beforeFiles[file]) throw new Error('PROTECTED_FILE_CHANGED: ' + file);
const evidence = {
  checkedAt: new Date().toISOString(),
  mainToUbuntu: {hostname: 'gpu-lab', username: 'refael', alias: 'personal-ubuntu-ssh', verified: true},
  ubuntuToMain: {...ubuntuInstall, verified: true, clientFingerprint, noSudo: true, forwardingDisabled: true},
  originalTunnelAccountUnchanged: true, windowsAndExistingRegistryUnchanged: true,
  sshdMainPidUnchanged: true, rebootVerified: false,
};
await fs.writeFile(new URL('bidirectional-verification.json', base), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
