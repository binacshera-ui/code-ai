import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawnSync, execFileSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {CENTRAL_PIN, validateKey} from '../ubuntu-connectivity/contract.mjs';

const project = '/root/projects/code-ai';
const id = 'ubuntu-gpu-lab', label = 'Ubuntu — gpu-lab';
const serviceRoot = '/home/refael/.code-ai/remote-agent/' + id;
const release = serviceRoot + '/releases/20261008-v1';
const node = '/home/refael/.local/lib/node-v24.21.0-linux-x64/bin/node';
const privateFile = project + '/.code-ai/pairings/' + id + '.json';
const registryFile = project + '/.code-ai/remote-hosts.json';
const apiAccount = 'codeai-ubuntu-api';
const apiAccountHome = '/var/lib/code-ai-ubuntu-api';
const remotePrelude = `
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const serviceRoot=${JSON.stringify(serviceRoot)},release=${JSON.stringify(release)};
if(os.hostname()!=='gpu-lab'||os.userInfo().username!=='refael')throw new Error('WRONG_UBUNTU_IDENTITY');
const run=(file,args,input)=>execFileSync(file,args,{input,encoding:'utf8',timeout:25000,stdio:['pipe','pipe','pipe'],env:{...process.env,PATH:'/home/refael/.local/bin:/home/refael/.local/npm/bin:/usr/local/bin:/usr/bin:/bin',XDG_RUNTIME_DIR:'/run/user/1000',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'}}).trim();
const read=async p=>fs.readFile(p,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
async function own(p,value,mode=0o600){const old=await read(p);if(old&&old!==value)throw new Error('REMOTE_FILE_CONFLICT');if(!old)await fs.writeFile(p,value,{flag:'wx',mode});}
`;
const remote = (source, timeout=60000) => {
  const result = spawnSync('/usr/bin/ssh', ['-T','-o','ConnectTimeout=10','personal-ubuntu-ssh', node + ' --input-type=module'],
    {input:remotePrelude+source,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
  if(result.error||result.status!==0) throw new Error('REMOTE_STEP_FAILED_' + (result.status??result.error?.code));
  try{return JSON.parse(result.stdout.trim());}catch{throw new Error('REMOTE_METADATA_INVALID');}
};
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const read=async file=>fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const pairing=()=>read(privateFile).then(JSON.parse);

async function preparePairing() {
  const prior=await read(privateFile);
  if(prior){const p=JSON.parse(prior);if(p.id!==id)throw new Error('PAIRING_ID_CONFLICT');return p;}
  const registry=JSON.parse(await read(registryFile));
  if(registry.hosts.some(h=>h.id===id))throw new Error('REGISTRY_ALREADY_EXISTS_WITHOUT_PAIRING');
  const reserved=new Set([44022,44023,...registry.hosts.map(h=>h.localPort).filter(Boolean)]);
  let port=44024;
  const available=port=>new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});
  for(;port<44123;port++)if(!reserved.has(port)&&await available(port))break;
  if(port>=44123)throw new Error('NO_SEPARATE_LOOPBACK_PORT');
  const env=parseEnv(await read(project+'/.env'));
  const notifications=Object.fromEntries(['CODEX_NTFY_URL','CODEX_NTFY_ENABLED','CODEX_NTFY_DEFAULT_ENABLED','CODEX_NTFY_ACCESS_TOKEN','CODEX_PUBLIC_ORIGIN'].filter(k=>env[k]).map(k=>[k,env[k]]));
  const p={id,label,centralApiPort:port,token:crypto.randomBytes(32).toString('hex'),sessionSecret:crypto.randomBytes(32).toString('hex'),devicePassword:crypto.randomBytes(32).toString('hex'),notifications};
  await fs.mkdir(project+'/.code-ai/pairings',{recursive:true,mode:0o700});
  await fs.writeFile(privateFile,JSON.stringify(p),{flag:'wx',mode:0o600});
  return p;
}

async function registerTunnel() {
  const p=await preparePairing();
  const mainKey=(await read('/etc/ssh/ssh_host_ed25519_key.pub')).trim().split(/\s+/).slice(0,2).join(' ');
  if(validateKey(mainKey)!==CENTRAL_PIN)throw new Error('MAIN_HOST_KEY_MISMATCH');
  const client=remote(`
const key='/home/refael/.ssh/code-ai-agent-tunnel_ed25519';
try{const s=await fs.lstat(key);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw new Error('KEY_POLICY_CONFLICT');}
catch(e){if(e.code!=='ENOENT')throw e;run('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',key,'-C','code-ai-ubuntu-api-gpu-lab']);}
const publicKey=run('/usr/bin/ssh-keygen',['-y','-f',key]).split(/\\s+/).slice(0,2).join(' ');
await own('/home/refael/.ssh/code-ai-agent-tunnel_known_hosts',${JSON.stringify('162.55.2.222 '+mainKey+'\n')});
console.log(JSON.stringify({publicKey}));`);
  const fingerprint=validateKey(client.publicKey);
  const initialConfig=await read('/etc/ssh/sshd_config');
  const pid=run('systemctl',['show','ssh.service','-p','MainPID','--value']);
  const protectedFiles=['/var/lib/code-ai-ubuntu-link/.ssh/authorized_keys','/etc/ssh/code-ai-accounts/ubuntu-gpu-lab.conf','/root/.ssh/personal-windows-new_config'];
  const initialHashes=Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[f,digest(await fs.readFile(f))])));
  const policy=(user,config)=>run('/usr/sbin/sshd',['-T',...(config?['-f',config]:[]),'-C',`user=${user},host=gpu-lab,addr=127.0.0.1`]);
  const users=['root','developer','codeai-windows','codeai-pci','codeai-ubuntu','codeai-ubuntu-access'];
  const oldPolicies=Object.fromEntries(users.map(user=>[user,digest(policy(user))]));
  let record;try{record=run('getent',['passwd',apiAccount]);}catch(e){if(e.status!==2)throw e;}
  if(!record){run('/usr/sbin/useradd',['--system','--create-home','--home-dir',apiAccountHome,'--shell','/usr/sbin/nologin','--user-group',apiAccount]);record=run('getent',['passwd',apiAccount]);}
  const fields=record.split(':');
  if(Number(fields[2])===0||fields[5]!==apiAccountHome||fields[6]!=='/usr/sbin/nologin'||run('id',['-Gn',apiAccount])!==apiAccount)throw new Error('API_ACCOUNT_POLICY_CONFLICT');
  const shadow=run('getent',['shadow',apiAccount]).split(':');
  if(!/^[!*]/.test(shadow[1])||shadow[7])throw new Error('ACCOUNT_AUTH_POLICY_CONFLICT');
  const sudo=spawnSync('/usr/bin/sudo',['-n','-l','-U',apiAccount],{encoding:'utf8',env:{...process.env,LANG:'C',LC_ALL:'C'}});
  if(!new RegExp('^User '+apiAccount+' is not allowed to run sudo on [^\\r\\n]+\\.?\\s*$').test((String(sudo.stdout||'')+String(sudo.stderr||'')).trim()))throw new Error('API_ACCOUNT_HAS_SUDO');
  const keys=apiAccountHome+'/.ssh/authorized_keys';
  await fs.mkdir(apiAccountHome+'/.ssh',{recursive:true,mode:0o700});
  await fs.chown(apiAccountHome+'/.ssh',Number(fields[2]),Number(fields[3]));
  const keyLine=`restrict,port-forwarding,permitlisten="127.0.0.1:${p.centralApiPort}" ${client.publicKey} code-ai-ubuntu-api\n`;
  async function own(file,value,mode){const prior=await read(file);if(prior&&prior!==value)throw new Error('CENTRAL_FILE_CONFLICT: '+file);if(!prior)await fs.writeFile(file,value,{flag:'wx',mode});}
  const config='/etc/ssh/code-ai-accounts/ubuntu-api.conf';
  await own(config,`Match User ${apiAccount}
  AuthenticationMethods publickey
  PubkeyAuthentication yes
  PubkeyAcceptedAlgorithms ssh-ed25519
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  AuthorizedKeysFile ${keys}
  AuthorizedKeysCommand none
  AllowTcpForwarding remote
  AllowStreamLocalForwarding no
  GatewayPorts no
  PermitListen 127.0.0.1:${p.centralApiPort}
  PermitOpen none
  MaxSessions 0
  AllowAgentForwarding no
  X11Forwarding no
  PermitTTY no
Match all
`,0o644);
  const suffix='\n# CODE-AI: Ubuntu API loopback-only tunnel\nInclude '+config+'\n';
  if(initialConfig.includes(config)&&!initialConfig.endsWith(suffix))throw new Error('SSHD_INCLUDE_SCOPE_CONFLICT');
  const candidate=initialConfig.endsWith(suffix)?initialConfig:initialConfig+suffix;
  const state='/var/lib/code-ai-ubuntu-gpu-lab';
  const candidatePath=state+'/api-sshd-candidate.conf';
  await fs.writeFile(candidatePath,candidate,{mode:0o600});run('/usr/sbin/sshd',['-t','-f',candidatePath]);
  for(const user of users)if(digest(policy(user,candidatePath))!==oldPolicies[user])throw new Error('EXISTING_ACCOUNT_POLICY_CHANGED');
  const effective=policy(apiAccount,candidatePath).split('\n');
  for(const setting of ['usepam yes','maxsessions 0','gatewayports no','allowtcpforwarding remote','passwordauthentication no','authenticationmethods publickey',`permitlisten 127.0.0.1:${p.centralApiPort}`])if(!effective.includes(setting))throw new Error('API_POLICY_NOT_EFFECTIVE');
  if(candidate!==initialConfig){
    if(await read('/etc/ssh/sshd_config')!==initialConfig)throw new Error('CONCURRENT_SSHD_EDIT');
    await own(state+'/api-sshd-before.conf',initialConfig,0o600);
    await fs.writeFile('/etc/ssh/sshd_config',candidate,{mode:0o644});
    try{run('/usr/sbin/sshd',['-t']);run('systemctl',['reload','ssh.service']);}
    catch{if(await read('/etc/ssh/sshd_config')===candidate){await fs.writeFile('/etc/ssh/sshd_config',initialConfig);run('/usr/sbin/sshd',['-t']);run('systemctl',['reload','ssh.service']);}throw new Error('SSHD_RELOAD_FAILED');}
  }
  await own(keys,keyLine,0o600);await fs.chown(keys,Number(fields[2]),Number(fields[3]));
  if(run('systemctl',['show','ssh.service','-p','MainPID','--value'])!==pid)throw new Error('SSHD_MAIN_PID_CHANGED');
  for(const file of protectedFiles)if(digest(await fs.readFile(file))!==initialHashes[file])throw new Error('PROTECTED_FILE_CHANGED');
  console.log(JSON.stringify({registered:true,account:apiAccount,centralApiPort:p.centralApiPort,keyFingerprint:fingerprint,existingTunnelPreserved:true}));
}

async function install() {
  const p=await pairing();
  const packet=JSON.parse(await read(project+'/ops/ubuntu-agent-add/package-receipt.json'));
  if(digest(await fs.readFile(packet.archive))!==packet.sha256)throw new Error('PACKAGE_HASH_MISMATCH');
  remote(`await fs.mkdir(serviceRoot+'/releases',{recursive:true,mode:0o700});try{await fs.access(release);throw new Error('RELEASE_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}console.log(JSON.stringify({ready:true}));`);
  execFileSync('/usr/bin/scp',['-q',packet.archive,'personal-ubuntu-ssh:'+serviceRoot+'/package-20261008-v1.tar.gz'],{timeout:180000,stdio:'pipe'});
  const installed=remote(`
const archive=serviceRoot+'/package-20261008-v1.tar.gz';
if(crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex')!==${JSON.stringify(packet.sha256)})throw new Error('ARCHIVE_HASH_MISMATCH');
await fs.mkdir(release,{mode:0o700});run('/usr/bin/tar',['-xzf',archive,'-C',release]);
if(crypto.createHash('sha256').update(await fs.readFile(release+'/dist/server.js')).digest('hex')!==${JSON.stringify(packet.serverSha256)})throw new Error('SERVER_HASH_MISMATCH');
await own(serviceRoot+'/pairing.json',${JSON.stringify(JSON.stringify(p))});
run(${JSON.stringify(node)},['-e',"const pty=require('"+release+"/node_modules/node-pty');const p=pty.spawn('/bin/sh',['-c','printf CODE_AI_PTY_OK'],{cols:80,rows:24,cwd:'/home/refael',env:{PATH:'/usr/bin:/bin'}});let out='';p.onData(s=>out+=s);p.onExit(e=>process.exit(e.exitCode===0&&out.includes('CODE_AI_PTY_OK')?0:1));"]);
const codexVersion=run('/home/refael/.local/npm/bin/codex',['--version']);
await fs.access('/home/refael/.codex/auth.json');
console.log(JSON.stringify({installed:true,release,nativeTerminalPassed:true,codexVersion,existingAuthenticationFile:true}));`);
  console.log(JSON.stringify(installed));
}

async function start() {
  const p=await pairing();
  const service=`[Unit]
Description=Code AI Ubuntu gpu-lab runtime
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${release}
ExecStart=${node} ${release}/runner.mjs
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=default.target
`;
  const tunnel=`[Unit]
Description=Code AI Ubuntu private API tunnel
After=network-online.target code-ai-ubuntu-agent.service
Wants=code-ai-ubuntu-agent.service

[Service]
Type=simple
ExecStart=/usr/bin/ssh -F /dev/null -N -T -i /home/refael/.ssh/code-ai-agent-tunnel_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UserKnownHostsFile=/home/refael/.ssh/code-ai-agent-tunnel_known_hosts -o ForwardAgent=no -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R 127.0.0.1:${p.centralApiPort}:127.0.0.1:4010 ${apiAccount}@162.55.2.222
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
  console.log(JSON.stringify(remote(`
const dir='/home/refael/.config/systemd/user';await fs.mkdir(dir,{recursive:true,mode:0o700});
await own(dir+'/code-ai-ubuntu-agent.service',${JSON.stringify(service)});
await own(dir+'/code-ai-ubuntu-agent-tunnel.service',${JSON.stringify(tunnel)});
run('/usr/bin/systemd-analyze',['--user','verify',dir+'/code-ai-ubuntu-agent.service',dir+'/code-ai-ubuntu-agent-tunnel.service']);
run('/usr/bin/systemctl',['--user','daemon-reload']);
run('/usr/bin/systemctl',['--user','enable','--now','code-ai-ubuntu-agent.service','code-ai-ubuntu-agent-tunnel.service']);
const status=run('/usr/bin/systemctl',['--user','show','code-ai-ubuntu-agent.service','code-ai-ubuntu-agent-tunnel.service','-p','Id','-p','MainPID','-p','ActiveState','-p','UnitFileState']);
console.log(JSON.stringify({started:true,status,linger:run('/usr/bin/loginctl',['show-user','refael','-p','Linger','--value'])}));`)));
}

async function health() {
  const p=await pairing();
  const url=`http://127.0.0.1:${p.centralApiPort}/api/codex/remote-agent/health`;
  const r=await fetch(url,{headers:{'x-code-ai-remote-token':p.token},signal:AbortSignal.timeout(20000)});
  if(r.status!==200)throw new Error('HEALTH_HTTP_'+r.status);
  const data=await r.json();
  const denied=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!data.ok||data.hostname!=='gpu-lab'||!data.profiles.some(x=>x.id==='ubuntu-refael'&&x.authenticated)||denied.status!==401)throw new Error('HEALTH_CONTRACT_FAILED');
  return {ok:data.ok,hostname:data.hostname,codexVersion:data.codexVersion,profiles:data.profiles,unauthenticatedStatus:denied.status};
}

async function register() {
  const checked=await health(),p=await pairing();
  const raw=await read(registryFile),registry=JSON.parse(raw);
  if(registry.version!==1||!Array.isArray(registry.hosts))throw new Error('REGISTRY_FORMAT_INVALID');
  const next={id,label,transport:'reverse-tunnel',enabled:true,localHost:'127.0.0.1',localPort:p.centralApiPort,token:p.token,
    description:'Ubuntu gpu-lab · refael · Codex הקיים · חיבור פרטי לשרת הראשי'};
  const prior=registry.hosts.find(h=>h.id===id);
  if(prior){if(JSON.stringify(prior)!==JSON.stringify(next))throw new Error('EXISTING_REGISTRATION_CONFLICT');console.log(JSON.stringify({alreadyRegistered:true,...checked}));return;}
  const originalHosts=JSON.stringify(registry.hosts);
  registry.hosts.push(next);
  if(JSON.stringify(registry.hosts.slice(0,-1))!==originalHosts)throw new Error('EXISTING_HOST_CHANGED');
  if(await read(registryFile)!==raw)throw new Error('REGISTRY_CHANGED_CONCURRENTLY');
  await fs.writeFile(project+'/.code-ai/pairings/remote-hosts-before-ubuntu-gpu-lab.json',raw,{flag:'wx',mode:0o600});
  const temp=registryFile+'.ubuntu-gpu-lab.tmp';
  await fs.writeFile(temp,JSON.stringify(registry,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,registryFile);
  console.log(JSON.stringify({registered:true,id,label,centralApiPort:p.centralApiPort,existingHostsPreserved:true,...checked}));
}

try {
  const action=process.argv[2];
  if(action==='prepare-tunnel')await registerTunnel();
  else if(action==='install')await install();
  else if(action==='start')await start();
  else if(action==='health')console.log(JSON.stringify(await health()));
  else if(action==='register')await register();
  else throw new Error('EXPECTED_PREPARE_TUNNEL_INSTALL_START_HEALTH_REGISTER');
} catch(error) {
  // Never serialize child-process input, output, or environment on failure.
  console.error(JSON.stringify({failed:true,message:String(error.message||'FAILED').split('\n')[0].slice(0,180)}));
  process.exitCode=1;
}
