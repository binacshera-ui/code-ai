import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {targets,linux,windows} from './remote.mjs';
const ops='/root/projects/code-ai/ops/fleet-capacity-20261024';
const results=[];
for(const target of Object.values(targets)){
 const users=target.id==='pci'?['admin','binapay-admin']:['root','beamadmin'];
 const alias=target.id==='pci'?'code-ai-control':'code-ai-control-from-beam';
 const result=await linux(target,`
  import os from'node:os';import{execFileSync}from'node:child_process';
  const users=${JSON.stringify(users)},alias=${JSON.stringify(alias)},results=[];
  for(const user of users){
   try{const result=execFileSync('runuser',['-u',user,'--','ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','-o','ConnectTimeout=8',alias,'hostname && id'],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});results.push({user,alias,passed:result.startsWith('web'),identity:result.trim()})}
   catch(error){results.push({user,alias,passed:false,error:String(error.stderr||error.message).slice(0,350)})}
  }
  let publicApi;try{const response=await fetch('https://app-codex.bina-cshera.co.il/api/auth/check-session',{signal:AbortSignal.timeout(15000)});await response.json();publicApi={status:response.status,json:true,passed:response.status===200}}catch{publicApi={passed:false}}
  let windowsRelay=null;
  if(${JSON.stringify(target.id)}==='pci')try{windowsRelay={passed:true,identity:execFileSync('runuser',['-u','admin','--','ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','personal-windows-ssh','hostname && whoami'],{encoding:'utf8',timeout:25000,stdio:['ignore','pipe','pipe']}).trim()}}catch(error){windowsRelay={passed:false,error:String(error.stderr||error.message).slice(0,350)}}
  console.log(JSON.stringify({hostname:os.hostname(),sshUser:process.env.SUDO_USER,mainToPeerSsh:true,peerToMainSsh:results,peerToMainPublicApi:publicApi,pciToWindowsRelay:windowsRelay}));
 `,{timeout:90000});
 results.push({id:target.id,...result});console.log(JSON.stringify(results.at(-1)));
}
const win=await windows("$identity=(& hostname|Out-String).Trim();$user=(& whoami|Out-String).Trim();$r=Invoke-WebRequest -UseBasicParsing -Uri 'https://app-codex.bina-cshera.co.il/api/auth/check-session' -TimeoutSec 15;$json=$r.Content|ConvertFrom-Json;$tunnel=@(Get-NetTCPConnection -State Established|Where-Object{$_.RemoteAddress -eq '162.55.2.222' -and $_.RemotePort -eq 22});$listen=@(Get-NetTCPConnection -State Listen|Where-Object{$_.LocalPort -eq 44222}|Select-Object LocalAddress,LocalPort);[pscustomobject]@{hostname=$identity;identity=$user;mainToWindowsSsh=$true;windowsToMainPublicApi=[pscustomobject]@{status=[int]$r.StatusCode;json=$true};windowsToMainEstablishedSshTunnel=($tunnel.Count -gt 0);windowsSshListen=$listen;windowsToMainInteractiveShellTested=$false}|ConvertTo-Json -Depth 6 -Compress",{timeout:40000});
results.push({id:'personal-windows-me',...win});
await fs.writeFile(ops+'/connectivity.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(results.at(-1)));
assert.ok(results.filter(result=>result.id!=='personal-windows-me').every(result=>result.peerToMainSsh.every(route=>route.passed)&&result.peerToMainPublicApi.passed));
assert.equal(win.windowsToMainPublicApi.status,200);assert.equal(win.windowsToMainEstablishedSshTunnel,true);
