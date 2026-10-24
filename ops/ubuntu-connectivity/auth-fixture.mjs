import fs from 'node:fs/promises';import net from 'node:net';import {spawn,execFileSync} from 'node:child_process';

export function sudoExplicitlyDenied(output){
 return typeof output==='string'&&/^User codeai-ubuntu is not allowed to run sudo on [^\r\n]+\.?\s*$/.test(output.trim());
}

async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function ready(port,child){for(let i=0;i<60;i++){if(child.exitCode!==null)throw new Error('FIXTURE_PROCESS_EXITED');const ok=await new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port});const done=x=>{s.destroy();resolve(x);};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(150,()=>done(false));});if(ok)return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('FIXTURE_READINESS_FAILED');}
function rejected(args){try{execFileSync('/usr/bin/ssh',args,{stdio:['ignore','pipe','pipe'],timeout:8000});return false;}catch(error){if(error.signal)throw new Error('FIXTURE_CLIENT_TIMEOUT');return error.status!==0;}}
export async function verifyTunnelAccount({directory,controller,controllerPublicKey,centralHostKey}){
 await fs.chmod(directory,0o755);
 const port=await freePort(),forward=await freePort(),deniedPort=await freePort();
 const keys=directory+'/fixture_authorized_keys';
 await fs.writeFile(keys,`restrict,port-forwarding,permitlisten="127.0.0.1:${forward}" ${controllerPublicKey}\n`,{mode:0o644});
 const config=directory+'/fixture_sshd.conf';
 await fs.writeFile(config,`Port ${port}\nListenAddress 127.0.0.1\nHostKey /etc/ssh/ssh_host_ed25519_key\nPidFile ${directory}/fixture.pid\nUsePAM yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nAuthorizedKeysFile ${keys}\nAuthorizedKeysCommand none\nStrictModes yes\nAllowUsers codeai-ubuntu\nMaxSessions 0\nAllowTcpForwarding remote\nGatewayPorts no\nPermitListen 127.0.0.1:${forward}\nPermitOpen none\nAllowAgentForwarding no\nX11Forwarding no\nPermitTTY no\nLogLevel ERROR\n`,{mode:0o600});
 const known=directory+'/fixture_known_hosts';await fs.writeFile(known,`[127.0.0.1]:${port} ${centralHostKey.split(' ').slice(0,2).join(' ')}\n`,{mode:0o600});
 execFileSync('/usr/sbin/sshd',['-t','-f',config],{stdio:'pipe'});
 const server=spawn('/usr/sbin/sshd',['-D','-e','-f',config],{stdio:'ignore'});let tunnel;
 try{
  await ready(port,server);
  const args=['-T','-p',String(port),'-i',controller,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
   '-o','HostKeyAlgorithms=ssh-ed25519','-o','UserKnownHostsFile='+known,'-o','ConnectTimeout=3','-o','ExitOnForwardFailure=yes'];
  tunnel=spawn('/usr/bin/ssh',[...args,'-N','-R',`127.0.0.1:${forward}:127.0.0.1:44222`,'codeai-ubuntu@127.0.0.1'],{stdio:'ignore'});
  await ready(forward,tunnel);
  const sessionDenied=rejected([...args,'codeai-ubuntu@127.0.0.1','hostname']);
  const wrongRemoteListenDenied=rejected([...args,'-N','-R',`127.0.0.1:${deniedPort}:127.0.0.1:44222`,'codeai-ubuntu@127.0.0.1']);
  const localForwardDenied=rejected([...args,'-W','127.0.0.1:22','codeai-ubuntu@127.0.0.1']);
  if(!sessionDenied||!wrongRemoteListenDenied||!localForwardDenied)throw new Error('FIXTURE_BOUNDARY_NOT_ENFORCED');
  return {isolated:true,realAccountKeyAuthenticated:true,sshNRemoteForwardAllowed:true,sessionChannelsDenied:true,
   wrongRemoteListenDenied:true,localForwardDenied:true,passwordLockedAccountSupportedByPam:true,
   liveUbuntuKeyUsed:false,livePortUsed:false};
 }finally{
  for(const process of [tunnel,server])if(process&&process.exitCode===null){const exited=new Promise(resolve=>process.once('exit',resolve));process.kill('SIGTERM');await exited;}
 }
}
