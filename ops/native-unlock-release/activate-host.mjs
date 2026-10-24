/** Exact host transaction; credentials are compared privately, never serialized. */
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [requestFile]=process.argv.slice(2);
const request=JSON.parse(await readFile(requestFile,'utf8'));
const {parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(request.candidate+'/runtime-auth.mjs').href);
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:240000,...opts}).trim();
const hash=b=>createHash('sha256').update(b).digest('hex');
const services={'beam-10g':'code-ai-remote-beam-10g.service',pci:'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'};
const ctl=args=>run('/usr/bin/systemctl',[...(request.id==='ubuntu-gpu-lab'?['--user']:[]),...args]);
const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
function processRecord(){
  if(request.id==='main') {const r=JSON.parse(run(pm2,['jlist'])).find(x=>x.name==='code-ai-app');assert.ok(r?.pid>1&&r.pm2_env.status==='online');return{pid:r.pid,env:r.pm2_env.env};}
  assert.equal(ctl(['is-active',services[request.id]]),'active');
  return{pid:Number(ctl(['show',services[request.id],'-p','MainPID','--value'])),env:{}};
}
async function environment(r){
  const e={...r.env,...parseRuntimeEnvironment(await readFile('/proc/'+r.pid+'/environ'))};
  e.CODE_AI_AUTH_BASELINE_MODULE=request.authenticationBaselineModule;
  e.CODE_AI_AUTH_BASELINE_SHA256=request.authenticationBaselineSha256;
  await preserveRuntimeAuthentication(e);return e;
}
const before=processRecord(),previous=await environment(before);
const fixedFiles=[request.environmentFile,request.pairingFile].filter(Boolean);
const fixedBytes=await Promise.all(fixedFiles.map(f=>readFile(f)));
try {
  run(request.nodeExecutable,[request.candidate+'/install.mjs','activate',requestFile],{cwd:request.candidate});
  const receipt=JSON.parse(await readFile(request.candidate+'/activation-receipt.json','utf8'));
  assert.equal(receipt.installed,true);assert.equal(receipt.buildId,request.buildId);
  const after=processRecord(),next=await environment(after);
  assert.notEqual(after.pid,before.pid);
  assert.equal(next.CODE_AI_CODEX_SHARED_OWNER_PROFILES,request.sharedProfiles);
  assert.ok(['CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET','DATABASE_URL','CODEX_REMOTE_AGENT_TOKEN'].every(k=>previous[k]===next[k]));
  for(let i=0;i<fixedFiles.length;i++) assert.ok(fixedBytes[i].equals(await readFile(fixedFiles[i])));
  if(request.id==='main') assert.equal(await realpath('/root/projects/code-ai/dist'),request.candidate+'/dist');
  else assert.equal(await realpath(ctl(['show',services[request.id],'-p','WorkingDirectory','--value'])),await realpath(request.candidate));
  assert.equal(hash(await readFile(request.candidate+'/dist/app.mjs')),request.expectedAppSha256);
  const owners=[];
  for(const p of request.ownerProfiles){
    const unit='code-ai-native-owner-'+p.id+'.service';assert.equal(ctl(['is-active',unit]),'active');
    const probe=JSON.parse(run(request.nodeExecutable,[request.candidate+'/ops/native-owner/probe.mjs',p.codexHome,String(request.ownerUid),'product']));
    assert.equal(probe.managedOwner,true);assert.equal(probe.homeMatched,true);owners.push({profileId:p.id,unit,probe});
  }
  let publicHttpsNewAssetHashesVerified=null;
  if(request.id==='main'){
    const {verifyServedAssets}=await import(pathToFileURL(request.candidate+'/transaction-contract.mjs').href);
    await verifyServedAssets({origin:'https://app-codex.bina-cshera.co.il',releaseRoot:request.candidate,fetch,readFile});
    publicHttpsNewAssetHashesVerified=true;
  }
  Object.assign(receipt,{mainPidBefore:before.pid,mainPidAfter:after.pid,credentialConfigurationBytePreserved:true,
    originalPairingAndEnvironmentFilesBytePreserved:true,sharedOwnerEnabled:true,sharedProfiles:request.sharedProfiles.split(','),
    liveApplicationSha256:request.expectedAppSha256,nativeOwners:owners,verifiedAt:new Date().toISOString(),
    publicHttpsNewAssetHashesVerified,
    nativeGuiMigrationVerified:false,unrelatedNativeProcessesStopped:false,oldWriterLockInodesDeleted:false});
  await writeFile(request.candidate+'/verified-activation-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(receipt));
}catch(e){
  let failure;try{failure=JSON.parse(await readFile(request.candidate+'/activation-failure.json','utf8'));}catch{failure={id:request.id,installedVerificationFailed:true,reason:'host_readback_failed',code:/^[A-Z_0-9]+$/.test(e.code||'')?e.code:'UNCLASSIFIED'};}
  console.error(JSON.stringify(failure));process.exitCode=1;
}
