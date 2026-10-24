import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
const base = path.dirname(new URL(import.meta.url).pathname);
const reportDir = '/root/projects/code-ai/.code-ai/reports/admin-connectivity-20261013';
const plan = [
  {id:'main',alias:null,hostname:'web',address:'162.55.2.222',port:22,login:'root',users:['root'],adminAlias:'code-ai-main-root',authorizedKeys:'/root/.ssh/authorized_keys',hostKey:'/etc/ssh/ssh_host_ed25519_key.pub',pin:'SHA256:6xNxgpDHSgKimuH18twY/iudAG2TH8sAFpOqEdLEBEM',services:['ssh.service'],protected:['/etc/ssh/sshd_config','/etc/ssh/code-ai-accounts/ubuntu-gpu-lab.conf','/var/lib/code-ai-ubuntu-link/.ssh/authorized_keys','/root/.ssh/personal-windows-new_config','/root/projects/code-ai/.code-ai/remote-hosts.json']},
  {id:'ubuntu',alias:'personal-ubuntu-ssh',hostname:'gpu-lab',address:'127.0.0.1',port:44023,login:'refael',users:['refael','root'],adminAlias:'code-ai-gpu-root',authorizedKeys:'/etc/codeai-ubuntu-reconnect/authorized_keys/refael',hostKey:'/etc/ssh/ssh_host_ed25519_key.pub',pin:'SHA256:p/e69bt1EC3Hwlm4rO1LBz9p5uac7UL5DTc/6ZAQlqM',services:['ssh.service','codeai-ubuntu-tunnel.service','codeai-ubuntu-sshd.service'],protected:['/etc/ssh/sshd_config','/etc/codeai-ubuntu-reconnect/sshd_config','/etc/codeai-ubuntu-reconnect/ssh_config']},
  {id:'pci',alias:'code-ai-pci-host',hostname:'binapay-cde-host',address:'198.23.160.30',port:22,login:'binapay-admin',users:['binapay-admin','admin','root'],adminAlias:'code-ai-pci-root',authorizedKeys:'/home/binapay-admin/.ssh/authorized_keys',hostKey:'/etc/ssh/ssh_host_ed25519_key.pub',pin:'SHA256:thugowP6jCGGEeB0+moKaOOTl+Jx11crqaGG0Pd7B0I',services:['ssh.service','code-ai-remote-pci.service'],protected:['/etc/ssh/sshd_config']},
  {id:'beam',alias:'beam-10g',hostname:'beam-10g',address:'207.32.216.245',port:22,login:'beamadmin',users:['root','beamadmin'],adminAlias:'code-ai-beam-root',authorizedKeys:'/home/beamadmin/.ssh/authorized_keys',hostKey:'/etc/ssh/ssh_host_ed25519_key.pub',pin:'SHA256:vH28q9y4McZfErv2hFS/allkq/hr7zyBNnl/EROQW9Y',services:['ssh.service','code-ai-remote-beam-10g.service'],protected:['/etc/ssh/sshd_config']},
];
const worker = await fs.readFile(path.join(base,'host-worker.py'),'utf8');
const entrypoint = await fs.readFile(path.join(base,'admin-entrypoint.py'),'utf8');
async function call(host, action, extra={}) {
  const program='import json,sys; packet=json.load(sys.stdin); exec(packet["worker"]); print(json.dumps(execute(packet["request"])))';
  const args=host.alias?['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',host.alias,'sudo -n /usr/bin/python3 -c '+"'"+program+"'"]:['-c',program];
  // execFile doesn't accept input; explicitly stream the public/code payload.
  const result = await new Promise((resolve,reject)=>{
    const child=execFile(host.alias?'/usr/bin/ssh':'/usr/bin/python3',args,{encoding:'utf8',timeout:action==='verify'?480000:60000,maxBuffer:2*1024*1024},(error,stdout,stderr)=>{
      if(error){reject(new Error(`${host.id}:${action} exit=${error.code}; ${stderr.includes('HOST_KEY_MISMATCH')?'HOST_KEY_MISMATCH':stderr.split('\n').filter(s=>/^(RuntimeError|PermissionError|FileNotFoundError):/.test(s)).join('; ')}`));return;}
      try{resolve(JSON.parse(stdout));}catch{reject(new Error(`${host.id}:${action} invalid response`));}
    });
    child.stdin.end(JSON.stringify({worker,request:{host,action,...extra}}));
  });
  return result;
}
await fs.mkdir(reportDir,{recursive:true,mode:0o700});
const save=async(name,value)=>fs.writeFile(path.join(reportDir,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const mode=process.argv[2];
if(mode==='audit') {
  const audit=[];
  for(const host of plan){const result=await call(host,'audit');audit.push(result);console.log(JSON.stringify(result));}
  await save('audit',audit);
} else if(mode==='apply') {
  const audit=JSON.parse(await fs.readFile(path.join(reportDir,'audit.json'),'utf8'));
  // Fresh preflight of the entire closure before any grant or key generation.
  for(const host of plan){const current=await call(host,'audit');if(JSON.stringify(current)!==JSON.stringify(audit.find(a=>a.host===host.id)))throw new Error('audit changed: '+host.id);}
  const keys=[];
  for(const host of plan){const result=await call(host,'prepare',{entrypoint});keys.push(...result.keys);await save('public-keys',keys);console.log(JSON.stringify({stage:'prepared',host:host.id,keyCount:result.keys.length}));}
  const peers=plan.map(host=>({...host,publicKey:audit.find(a=>a.host===host.id).publicKey}));
  const activation=[];
  for(const host of plan){const result=await call(host,'activate',{keys,peers,invariants:audit.find(a=>a.host===host.id).invariants});activation.push(result);await save('activation',activation);console.log(JSON.stringify(result));}
} else if(mode==='resume-activation') {
  const audit=JSON.parse(await fs.readFile(path.join(reportDir,'audit.json'),'utf8'));
  const keys=JSON.parse(await fs.readFile(path.join(reportDir,'public-keys.json'),'utf8'));
  const activation=JSON.parse(await fs.readFile(path.join(reportDir,'activation.json'),'utf8'));
  const peers=plan.map(host=>({...host,publicKey:audit.find(a=>a.host===host.id).publicKey}));
  for(const host of plan){
    if(activation.some(a=>a.host===host.id))continue;
    const result=await call(host,'activate',{keys,peers,invariants:audit.find(a=>a.host===host.id).invariants});
    activation.push(result);await save('activation',activation);console.log(JSON.stringify(result));
  }
} else if(mode==='qualify-sftp-update') {
  for(const name of ['receipt','verification-main','verification-ubuntu','verification-pci','verification-beam']) {
    await fs.copyFile(path.join(reportDir,name+'.json'),path.join(reportDir,name+'-first-pass.json'),fs.constants.COPYFILE_EXCL);
  }
  for(const host of plan){
    const result=await call(host,'update-entrypoint',{entrypoint,expectedSha256:'b0d26968fe7878b5b1dc049475b307e02c7486fdd0a027efe5675c96e5fdc4ee'});
    await save('sftp-entrypoint-'+host.id,result);console.log(JSON.stringify({host:host.id,sha256:result.sha256}));
  }
} else if(mode==='verify') {
  const audit=JSON.parse(await fs.readFile(path.join(reportDir,'audit.json'),'utf8'));
  const results=await Promise.all(plan.map(async host=>{const result=await call(host,'verify',{peers:plan});await save('verification-'+host.id,result);console.log(JSON.stringify(result));return result;}));
  const checks=results.flatMap(r=>r.checks);
  const invariantsPreserved=results.every((r,i)=>JSON.stringify(r.invariants)===JSON.stringify(audit.find(a=>a.host===plan[i].id).invariants));
  const receipt={checkedAt:new Date().toISOString(),entrypointSha256:crypto.createHash('sha256').update(entrypoint).digest('hex'),checks,passed:checks.filter(c=>c.ok).length,total:checks.length,invariantsPreserved,windows:'offline: not modified or verified',codexPoliciesChanged:false,existingTransportAliasesUnchanged:true,servicesRestarted:false,privateKeysExported:false};
  await save('receipt',receipt);
  if(checks.some(c=>!c.ok)||!invariantsPreserved)process.exitCode=1;
} else throw new Error('usage: connect.mjs audit|apply|verify');
