import {spawn,execFileSync} from 'node:child_process';
export const targets={
 pci:{id:'pci',ssh:'code-ai-pci-host',node:'/srv/beam254/code-ai-native/releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/bin/node',root:'/srv/beam254/code-ai-native/releases',service:'code-ai-remote-pci.service',queue:'/var/lib/code-ai-pci/queue/state.json'},
 'beam-10g':{id:'beam-10g',ssh:'beam-10g',node:'/opt/node-v24.18.0-linux-x64/bin/node',root:'/opt/code-ai-releases',service:'code-ai-remote-beam-10g.service',queue:'/var/lib/code-ai-remote/beam-10g/queue/state.json'},
};
export const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export const sshArgs=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8'];
export function command(binary,args,{input,timeout=120000,...options}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],...options});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Bounded command timeout'));},timeout);
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',error=>{clearTimeout(timer);reject(error)});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(Object.assign(Error('Remote command exited '+code),{stderr:stderr.slice(-3500),stdout:stdout.slice(-1500)}))});
  child.stdin.end(input||'');
 });
}
export async function linux(target,script,options={}){
 execFileSync(process.execPath,['--input-type=module','--check'],{input:script,stdio:['pipe','pipe','pipe']});
 return JSON.parse((await command('ssh',[...sshArgs,target.ssh,'sudo -n '+quote(target.node)+' --input-type=module -'],{input:script,...options})).trim());
}
export async function windows(script,options={}){
 const header="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;if($env:COMPUTERNAME -ne 'ME' -or $env:USERNAME -ne 'showp'){throw 'Windows identity mismatch'};";
 return JSON.parse((await command('ssh',[...sshArgs,'personal-windows-ssh','powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(header+script,'utf16le').toString('base64')],options)).replace(/^\uFEFF/,'').trim());
}
