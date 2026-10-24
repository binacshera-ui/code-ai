/** Read-only protocol/custody proof on every intended owner before scheduling.
 * The paginated reader is inlined only into this diagnostic process. */
import fs from 'node:fs/promises';import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir='/root/projects/code-ai/ops/native-large-frames';
const old=JSON.parse(await fs.readFile('/root/projects/code-ai/ops/queued-recovery/staged.json','utf8'));
const ubuntu=JSON.parse(await fs.readFile('/root/projects/code-ai/ops/ubuntu-native-admission/staged.json','utf8')).target;
const reader=await fs.readFile('/root/projects/code-ai/server/codexSharedHistory.mjs','utf8');
const script=(await fs.readFile(dir+'/owner-census.mjs','utf8')).replace("pathToFileURL(candidate+'/server/codexSharedHistory.mjs')",JSON.stringify('data:text/javascript;base64,'+Buffer.from(reader).toString('base64')));
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'},proofs=[];
const run=(exe,args,input)=>{try{return execFileSync(exe,args,{input,encoding:'utf8',stdio:'pipe',timeout:120000}).trim();}catch(e){console.error(JSON.stringify({gate:'owner_protocol_preflight',exitCode:e.status,diagnosticBytes:e.stderr?.length||0}));process.exit(1);}};
for(const entry of old.targets){const r=entry.id==='ubuntu-gpu-lab'?ubuntu:entry;
 for(const p of r.ownerProfiles){
  const launcher=`import fs from'node:fs/promises';import{execFileSync}from'node:child_process';const r=${JSON.stringify({id:r.id,nodeExecutable:r.nodeExecutable,candidate:r.candidate})},p=${JSON.stringify({home:p.codexHome,userHome:p.userHome})};
   const o=JSON.parse(await fs.readFile(p.userHome+'/code-ai-native-owner/ownership.json','utf8')),s=await fs.readFile('/proc/'+o.nativePid+'/status','utf8'),uid=Number(/^Uid:\\s+(\\d+)/m.exec(s)?.[1]);
   const user=execFileSync('getent',['passwd',String(uid)],{encoding:'utf8'}).split(':')[0],args=[r.nodeExecutable,'--input-type=module','-',r.candidate,p.home];
   const output=process.getuid()===uid?execFileSync(args[0],args.slice(1),{input:${JSON.stringify(script)},encoding:'utf8',stdio:'pipe'}):execFileSync('/usr/sbin/runuser',['-u',user,'--',...args],{input:${JSON.stringify(script)},encoding:'utf8',stdio:'pipe'});
   const x=JSON.parse(output);console.log(JSON.stringify({id:r.id,home:x.home,protocolVerified:true,activeThreads:x.threads.filter(t=>t.status!=='idle').length,backgroundTerminals:x.threads.reduce((n,t)=>n+t.backgroundTerminals,0),unresolvedJournal:x.journal.filter(j=>!j.terminalProved).length,installedEffects:false}));`;
  const output=hosts[r.id]?run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',hosts[r.id],(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' --input-type=module -'],launcher):run(r.nodeExecutable,['--input-type=module','-'],launcher);
  proofs.push(JSON.parse(output));
 }
}
await fs.writeFile(dir+'/owner-preflight.json',JSON.stringify({format:'code-ai-native-image-owner-preflight',version:1,observedAt:new Date().toISOString(),installedEffects:false,profiles:proofs},null,2),{mode:0o600});
console.log(JSON.stringify({profilesVerified:proofs.length,installedEffects:false,hosts:[...new Set(proofs.map(p=>p.id))]}));
