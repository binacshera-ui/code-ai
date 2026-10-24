import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdir,symlink,chmod,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [buildId,artifact]=process.argv.slice(2);
assert.match(buildId,/^[a-f0-9-]{36}$/);
assert.equal(artifact,'/mnt/hdd/code-ai-builds/native-unlock-imports/'+buildId+'/artifact/dist');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(artifact+'/release-files.json','utf8'));
for(const [file,sha] of Object.entries(manifest.files)) {assert.ok(!path.isAbsolute(file)&&!file.split('/').includes('..'));assert.equal(hash(await readFile(artifact+'/'+file)),sha);}
const installed=JSON.parse(await readFile('ops/immediate-release/staged-06247301-58b8-4ec4-82cc-2c96f0b22a4d.json','utf8'));
const census=JSON.parse(await readFile('ops/native-owner/native-program-inventory-20261010.json','utf8'));
const common={buildId,ownerAuthorizedInterruption:true,expectedServerSha256:manifest.files['dist/server.js'],expectedAppSha256:manifest.files['dist/app.mjs']};
const targets=[];
for(const old of installed.targets) {
  const native=census.hosts.find(h=>h.id===old.id); assert.ok(native,'Qualified native census missing');
  const baseline=old.candidate;
  const candidate=old.id==='main'?'/mnt/hdd/code-ai-builds/native-unlock-live-'+buildId
    : old.id==='pci'?'/opt/code-ai-releases/pci-8a7d514b-4731-4b06-959c-f2d6cd3ed031/app-native-unlock-'+buildId
    : old.id==='ubuntu-gpu-lab'?'/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-unlock-'+buildId
    :'/opt/code-ai-releases/native-unlock-'+buildId;
  const target={...common,id:old.id,baseline,candidate,expectedBaselineSha256:old.expectedServerSha256,
    authenticationBaselineModule:old.baseline+'/dist/server.js',authenticationBaselineSha256:old.expectedBaselineSha256,
    nodeExecutable:native.nodeBinary,ownerProfiles:native.profiles,ownerUid:native.runtimeUid,ownerGid:native.runtimeGid,
    ownerUsername:native.runtimeUsername,ownerGroup:native.runtimeGroup,sharedProfiles:native.profiles.map(p=>p.id).join(','),
    ...(old.environmentFile?{environmentFile:old.environmentFile}:{}),...(old.pairingFile?{pairingFile:old.pairingFile}:{})};
  if(old.id==='main') Object.assign(target,{uploadBaselineModule:baseline+'/dist/server.js',uploadBaselineSha256:old.expectedServerSha256,
    uploadAuthenticationBaselineModule:old.uploadBaselineModule,uploadAuthenticationBaselineSha256:old.uploadBaselineSha256});
  if(old.id==='pci') {
    const qualified = native.profiles[0].qualifiedCandidate;
    assert.equal(qualified?.sharedWriterContractPassed,true,'PCI native candidate not qualified');
    assert.equal(qualified?.nativeBaselineChecksPassed,9);
    assert.equal(qualified?.sharedModeDispatcherChecksPassed,11);
    target.publicNativeTransfer={source:census.hosts.find(h=>h.id==='main').profiles[0].nativeBinary,
      sha256:qualified.nativeBinarySha256};
    target.ownerProfiles=target.ownerProfiles.map(p=>({...p,nativeBinary:candidate+'/native/codex',
      nativeVersion:qualified.nativeVersion,nativeBinarySha256:qualified.nativeBinarySha256}));
  }
  targets.push(target);
}
const archive=path.dirname(path.dirname(artifact))+'/public-release.tar';execFileSync('tar',['-cf',archive,'-C',artifact,'.'],{stdio:'pipe'});
const archiveSha=hash(await readFile(archive));
const hosts={'beam-10g':'beam-10g',pci:'code-ai-pci-host','ubuntu-gpu-lab':'personal-ubuntu-ssh'};
for(const r of targets) {
  const host=hosts[r.id];
  if(host) {
    const remote='/var/tmp/code-ai-native-unlock-'+buildId+'.tar';
    execFileSync('scp',['-q','-o','BatchMode=yes','-o','ConnectTimeout=10',archive,host+':'+remote],{stdio:'pipe',timeout:90000});
    const nativeRemote='/var/tmp/code-ai-native-program-'+buildId;
    if(r.publicNativeTransfer) {
      assert.equal(hash(await readFile(r.publicNativeTransfer.source)),r.publicNativeTransfer.sha256);
      execFileSync('scp',['-q','-o','BatchMode=yes','-o','ConnectTimeout=10',r.publicNativeTransfer.source,host+':'+nativeRemote],{stdio:'pipe',timeout:90000});
    }
    const code=`const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');const r=${JSON.stringify(r)},a=${JSON.stringify(remote)};
      if(crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex')!==${JSON.stringify(archiveSha)})throw Error('public_archive_changed');
      if(!fs.existsSync(r.candidate)){fs.mkdirSync(r.candidate,{mode:0o755});cp.execFileSync('tar',['-xf',a,'-C',r.candidate],{stdio:'pipe'});}
      const manifest=JSON.parse(fs.readFileSync(r.candidate+'/release-files.json','utf8'));
      for(const [name,sha]of Object.entries(manifest.files))if(crypto.createHash('sha256').update(fs.readFileSync(r.candidate+'/'+name)).digest('hex')!==sha)throw Error('staged_artifact_changed');
      if(manifest.files['dist/server.js']!==r.expectedServerSha256)throw Error('staged_release_identity_changed');
      fs.chmodSync(r.candidate,0o755);
      const deps=r.candidate+'/node_modules';
      if(fs.existsSync(deps)){if(!fs.lstatSync(deps).isSymbolicLink()||fs.realpathSync(deps)!==fs.realpathSync(r.baseline+'/node_modules'))throw Error('staged_dependencies_changed');}
      else fs.symlinkSync(fs.realpathSync(r.baseline+'/node_modules'),deps);
      if(r.publicNativeTransfer){const b=fs.readFileSync(${JSON.stringify(nativeRemote)});if(crypto.createHash('sha256').update(b).digest('hex')!==r.publicNativeTransfer.sha256)throw Error('native_program_changed');
        if(!fs.existsSync(r.candidate+'/native'))fs.mkdirSync(r.candidate+'/native',{mode:0o755});
        if(!fs.existsSync(r.candidate+'/native/codex'))fs.copyFileSync(${JSON.stringify(nativeRemote)},r.candidate+'/native/codex');
        if(crypto.createHash('sha256').update(fs.readFileSync(r.candidate+'/native/codex')).digest('hex')!==r.publicNativeTransfer.sha256)throw Error('staged_native_changed');fs.chmodSync(r.candidate+'/native/codex',0o755);}
      if(r.id==='ubuntu-gpu-lab'&&!fs.existsSync(r.candidate+'/runner.mjs'))fs.copyFileSync(r.baseline+'/runner.mjs',r.candidate+'/runner.mjs');
      if(r.id==='beam-10g'&&!fs.existsSync(r.candidate+'/.remote-agent.env'))fs.symlinkSync(r.environmentFile,r.candidate+'/.remote-agent.env');
      const requestFile=r.candidate+'/deployment-request.json';
      if(fs.existsSync(requestFile)){if(JSON.stringify(JSON.parse(fs.readFileSync(requestFile,'utf8')))!==JSON.stringify(r))throw Error('staged_request_changed');}
      else fs.writeFileSync(requestFile,JSON.stringify(r,null,2)+'\\n',{mode:0o600,flag:'wx'});
      process.stdout.write(cp.execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.candidate+'/deployment-request.json'],{cwd:r.candidate,stdio:'pipe',encoding:'utf8',timeout:90000}));`;
    const output=execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',host,(r.id==='pci'?'sudo -n ':'')+r.nodeExecutable+' -'],{input:code,encoding:'utf8',stdio:'pipe',timeout:120000});
    console.log(output.trim());
  } else {
    await mkdir(r.candidate,{mode:0o755});await cp(artifact,r.candidate,{recursive:true});await chmod(r.candidate,0o755);
    await symlink(await realpath('/root/projects/code-ai/node_modules'),r.candidate+'/node_modules');
    await writeFile(r.candidate+'/deployment-request.json',JSON.stringify(r,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(execFileSync(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.candidate+'/deployment-request.json'],{cwd:r.candidate,encoding:'utf8',stdio:'pipe',timeout:90000}).trim());
  }
}
await writeFile('ops/native-unlock-release/staged-'+buildId+'.json',JSON.stringify({buildId,archiveSha256:archiveSha,targets},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({allFourTargetsStaged:true,productionServicesChanged:false,buildId}));
