// Operates only on the named Code AI service and VM. Never emits private inputs.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename, symlink, chmod, copyFile, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
const chunks=[];
for await(const chunk of process.stdin)chunks.push(chunk);
const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const base='/srv/beam254/code-ai-native';
const uuid='72010c9e-2012-4d7f-aa64-61b1760563f6';
const service='code-ai-remote-pci.service';
const cde=['binapay-edge','binapay-gateway','binapay-db','binapay-keys'];
const run=(cmd,args)=>execFileSync(cmd,args,{stdio:'pipe',encoding:'utf8',timeout:90000}).trim();
const exists=p=>lstat(p).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e));
const digest=text=>createHash('sha256').update(text).digest('hex');
async function moveOwnedFile(from,to) {
  if(!await exists(from)) {assert.ok(await exists(to));return;}
  assert.ok((await lstat(from)).isFile());
  assert.equal(await exists(to),false);
  try {await rename(from,to);}
  catch(error) {
    if(error.code!=='EXDEV')throw error;
    await copyFile(from,to,constants.COPYFILE_EXCL);
    await chmod(to,(await lstat(from)).mode&0o777);
    assert.equal(digest(await readFile(from)),digest(await readFile(to)));
    await unlink(from);
  }
}
async function baseline() {
  const domains={};
  for(const name of cde) domains[name]={state:run('virsh',['domstate',name]),definition:digest(run('virsh',['dumpxml','--inactive',name]))};
  const rules=JSON.parse(run('nft',['-j','list','chain','inet','host_filter','forward'])).nftables.filter(x=>x.rule).map(x=>x.rule).filter(x=>!String(x.comment||'').startsWith('code-ai-pci-outbound-')).map(({handle,...rule})=>{for(const x of rule.expr||[])if(x.counter)x.counter={};return rule;});
  return {domains,rulesDigest:digest(JSON.stringify(rules))};
}
async function sshPolicy(removeGuest=false) {
  const file='/etc/ssh/sshd_config.d/zz-binapay-cde-bastion.conf';
  const prior=await readFile(file,'utf8');
  const lines=prior.split('\n');
  const indices=lines.map((x,i)=>/^\s*PermitOpen\s/.test(x)?i:-1).filter(i=>i>=0);
  assert.equal(indices.length,1);
  const i=indices[0];
  const values=lines[i].trim().split(/\s+/).slice(1);
  for(const ip of [2,3,4,5])assert.ok(values.includes(`10.77.50.${ip}:22`));
  assert.ok(values.every(v=>/^10\.77\.50\.[2345]:22$/.test(v)||['192.168.241.2:22','127.0.0.1:4010'].includes(v)));
  let next=values.filter(v=>!removeGuest||v!=='192.168.241.2:22');
  if(!next.includes('127.0.0.1:4010'))next.push('127.0.0.1:4010');
  lines[i]=(lines[i].match(/^\s*/)||[''])[0]+'PermitOpen '+next.join(' ');
  await writeFile(file+'.code-ai-native.tmp',lines.join('\n'),{mode:0o644,flag:'wx'});
  await rename(file+'.code-ai-native.tmp',file);
  try {run('/usr/sbin/sshd',['-t']);run('systemctl',['reload','ssh']);}
  catch(e){await writeFile(file,prior,{mode:0o644});run('/usr/sbin/sshd',['-t']);throw e;}
}
try {
  assert.equal(process.getuid(),0);
  assert.match(request.buildId,/^[a-f0-9-]{36}$/);
  const release=base+'/releases/pci-'+request.buildId;
  const legacy='/opt/code-ai-releases/pci-'+request.buildId;
  if(request.phase==='prepare') {
    for(const p of ['/home/admin','/srv/projects','/var/lib/code-ai-pci',legacy,'/etc/systemd/system/'+service])assert.equal(await exists(p),false);
    assert.equal(run('virsh',['domuuid','code-ai-pci']),uuid);
    assert.equal(run('virsh',['domstate','code-ai-pci']),'running');
    const space=await statfs(base);
    const available=space.bavail*space.bsize,total=space.blocks*space.bsize;
    assert.ok(available>Math.max(total*.15,100_000_000_000)+4_000_000_000);
    const identity=JSON.parse(await readFile(release+'/runtime-identity.json','utf8'));
    assert.equal(identity.codexVersion,'0.160.1');
    assert.equal(run(release+'/codex-vendor/bin/codex',['--version']),'codex-cli 0.160.1');
    run(release+'/bin/node',['-e',`require(${JSON.stringify(release+'/app/node_modules/node-pty')})`]);
    const before=await baseline();
    assert.ok(Object.values(before.domains).every(d=>d.state==='running'));
    await mkdir(base+'/recovery',{mode:0o700});
    await writeFile(base+'/recovery/cde-baseline.json',JSON.stringify(before),{mode:0o600,flag:'wx'});
    await copyFile('/etc/ssh/sshd_config.d/zz-binapay-cde-bastion.conf',base+'/recovery/sshd-before.conf');
    await chmod(base+'/recovery/sshd-before.conf',0o600);
    await sshPolicy();
    console.log(JSON.stringify({prepared:true,nativeRuntimeCompatible:true,otherVmCount:cde.length,storageAvailable:available}));
  } else if(request.phase==='install') {
    assert.match(request.snapshot,/^\/var\/tmp\/code-ai-native\.[A-Za-z0-9]+\/snapshot\.tar\.gz$/);
    for(const p of ['/home/admin','/srv/projects','/var/lib/code-ai-pci',legacy,'/etc/systemd/system/'+service])assert.equal(await exists(p),false);
    // Validate all archive entries privately before extracting into an empty staging tree.
    const validation=`import tarfile,posixpath,sys,os\np=sys.argv[1]; legacy=sys.argv[2]; roots=('home/admin','srv/projects','var/lib/code-ai-pci')\nwith tarfile.open(p,'r:gz') as t:\n for m in t.getmembers():\n  n=posixpath.normpath(m.name)\n  assert not n.startswith('/') and not n.startswith('../')\n  assert any(n==r or n.startswith(r+'/') for r in roots)\n  assert m.isdir() or m.isfile() or m.issym() or m.islnk()\n  if m.issym():\n   dest=posixpath.normpath(m.linkname if m.linkname.startswith('/') else posixpath.join('/'+posixpath.dirname(n),m.linkname))\n   assert any(dest=='/'+r or dest.startswith('/'+r+'/') for r in roots) or dest==legacy or dest.startswith(legacy+'/')\n  if m.islnk():\n   dest=posixpath.normpath(m.linkname)\n   assert not dest.startswith('/') and any(dest==r or dest.startswith(r+'/') for r in roots)\nprint('validated')`;
    assert.equal(run('/usr/bin/python3',['-c',validation,request.snapshot,legacy]),'validated');
    const restore=base+'/restore';
    assert.equal(await exists(restore),false);
    await mkdir(restore,{mode:0o700});
    run('tar',['-xzf',request.snapshot,'-C',restore,'--no-same-owner']);
    for(const [from,to] of [['home/admin','home'],['srv/projects','projects'],['var/lib/code-ai-pci','state']])await rename(restore+'/'+from,base+'/'+to);
    try {run('getent',['passwd','admin']);throw new Error('Existing admin account needs reconciliation');}
    catch(error){if(error.status!==2)throw error;}
    run('/usr/sbin/useradd',['--no-create-home','--home-dir','/home/admin','--shell','/bin/bash','--user-group','admin']);
    for(const dir of ['home','projects','state'])run('chown',['-R','--no-dereference','admin:admin',base+'/'+dir]);
    await mkdir('/opt/code-ai-releases',{recursive:true,mode:0o755});
    for(const [target,link] of [[release,legacy],[base+'/home','/home/admin'],[base+'/projects','/srv/projects'],[base+'/state','/var/lib/code-ai-pci']])await symlink(target,link);
    const env=parseEnv(await readFile('/var/lib/code-ai-pci/runtime.env','utf8'));
    assert.equal(env.CODEX_REMOTE_AGENT_TOKEN,request.token);
    assert.equal(env.HOST,'127.0.0.1');assert.equal(env.PORT,'4010');
    await writeFile('/etc/systemd/system/'+service,`[Unit]\nDescription=Code AI PCI native remote agent\nAfter=network-online.target\nWants=network-online.target\nRequiresMountsFor=${base}\n\n[Service]\nType=simple\nUser=admin\nGroup=admin\nWorkingDirectory=${legacy}/app\nExecStart=${legacy}/bin/node --env-file=/var/lib/code-ai-pci/runtime.env ${legacy}/app/dist/server.js\nEnvironment=PATH=${legacy}/bin:/usr/local/bin:/usr/bin:/bin\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGTERM\nTimeoutStopSec=60\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`,{mode:0o644,flag:'wx'});
    // Permit the service account to execute the metadata-only verifier, not read private archives.
    await chmod(request.snapshot,0o600);
    await chmod(request.snapshot.slice(0,request.snapshot.lastIndexOf('/')),0o711);
    run('systemd-analyze',['verify','/etc/systemd/system/'+service]);
    run('systemctl',['daemon-reload']);run('systemctl',['enable','--now',service]);
    assert.equal(run('systemctl',['is-active',service]),'active');
    assert.deepEqual(await baseline(),JSON.parse(await readFile(base+'/recovery/cde-baseline.json','utf8')));
    console.log(JSON.stringify({installed:true,native:true,runAs:'admin',otherVmsUnchanged:true}));
  } else if(request.phase==='remove-vm') {
    assert.equal(run('systemctl',['is-active',service]),'active');
    const before=JSON.parse(await readFile(base+'/recovery/cde-baseline.json','utf8'));
    assert.deepEqual(await baseline(),before);
    const domains=run('virsh',['list','--all','--name']).split('\n').filter(Boolean);
    for(const name of domains.filter(x=>x!=='code-ai-pci'))assert.ok(!run('virsh',['dumpxml','--inactive',name]).includes("network='code-ai-pci-net'"));
    if(domains.includes('code-ai-pci')) {
      assert.equal(run('virsh',['domuuid','code-ai-pci']),uuid);
      const xml=run('virsh',['dumpxml','--inactive','code-ai-pci']);
      assert.ok(xml.includes('/srv/beam254/code-ai-vms/pci/root.qcow2'));
      assert.ok(xml.includes('/srv/beam254/code-ai-vms/pci/seed.iso'));
      for(const [file,data] of [['code-ai-pci.xml',xml],['code-ai-pci-net.xml',run('virsh',['net-dumpxml','code-ai-pci-net'])]]) {
        if(await exists(base+'/recovery/'+file))assert.equal(digest(await readFile(base+'/recovery/'+file,'utf8')),digest(data));
        else await writeFile(base+'/recovery/'+file,data,{mode:0o600,flag:'wx'});
      }
      if(run('virsh',['domstate','code-ai-pci'])!=='shut off')run('virsh',['shutdown','code-ai-pci']);
      let stopped=false;
      for(let i=0;i<45;i++) {
        if(run('virsh',['domstate','code-ai-pci'])==='shut off'){stopped=true;break;}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      assert.ok(stopped,'VM did not shut down; keep definition and recovery material');
      run('virsh',['undefine','code-ai-pci','--keep-nvram']);
    } else {
      const xml=await readFile(base+'/recovery/code-ai-pci.xml','utf8');
      assert.ok(xml.includes('<uuid>'+uuid+'</uuid>'));
      assert.ok(xml.includes('/srv/beam254/code-ai-vms/pci/root.qcow2'));
    }
    if(await exists('/srv/beam254/code-ai-vms/pci')) {
      assert.equal(await exists(base+'/recovery/vm-files'),false);
      await rename('/srv/beam254/code-ai-vms/pci',base+'/recovery/vm-files');
    } else assert.ok(await exists(base+'/recovery/vm-files/root.qcow2'));
    await chmod(base+'/recovery/vm-files',0o700);
    await moveOwnedFile('/var/lib/libvirt/qemu/nvram/code-ai-pci_VARS.fd',base+'/recovery/code-ai-pci_VARS.fd');
    if(await exists('/etc/systemd/system/code-ai-pci-network-guard.service'))run('systemctl',['disable','--now','code-ai-pci-network-guard.service']);
    const nft=JSON.parse(run('nft',['-j','list','chain','inet','host_filter','forward']));
    const owned=nft.nftables.filter(x=>x.rule).map(x=>x.rule).filter(x=>['code-ai-pci-outbound-tcp-v1','code-ai-pci-outbound-udp-v1'].includes(x.comment));
    assert.ok(owned.length===2||owned.length===0);
    for(const rule of owned)run('nft',['delete','rule','inet','host_filter','forward','handle',String(rule.handle)]);
    if(run('virsh',['net-list','--name']).split('\n').includes('code-ai-pci-net'))run('virsh',['net-destroy','code-ai-pci-net']);
    if(run('virsh',['net-list','--all','--name']).split('\n').includes('code-ai-pci-net'))run('virsh',['net-undefine','code-ai-pci-net']);
    await moveOwnedFile('/etc/systemd/system/code-ai-pci-network-guard.service',base+'/recovery/code-ai-pci-network-guard.service');
    await moveOwnedFile('/usr/local/lib/code-ai-pci/network-guard.sh',base+'/recovery/network-guard.sh');
    run('systemctl',['daemon-reload']);
    await sshPolicy(true);
    assert.deepEqual(await baseline(),before);
    assert.ok(!run('virsh',['list','--all','--name']).split('\n').includes('code-ai-pci'));
    console.log(JSON.stringify({vmRemoved:true,uuid,vmRecoveryPath:base+'/recovery',sharedBaseImageUntouched:true,otherVmsUnchanged:true}));
  } else throw new Error('Unknown phase');
} catch(error) {
  console.error(JSON.stringify({ok:false,phase:request.phase,errorType:error.code||error.name,status:error.status??null,location:error.stack?.match(/migration-host\.mjs:\d+:\d+/)?.[0]}));
  process.exit(1);
}
