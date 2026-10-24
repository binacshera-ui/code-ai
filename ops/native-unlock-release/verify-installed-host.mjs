/** Read-only active-generation verification; no runtime environment is serialized. */
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [requestFile]=process.argv.slice(2);
let phase='request';
try {
  const r=JSON.parse(await readFile(requestFile,'utf8'));
  const run=(p,a)=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:30000}).trim();
  const ctl=a=>run('/usr/bin/systemctl',[...(r.id==='ubuntu-gpu-lab'?['--user']:[]),...a]);
  const services={'beam-10g':'code-ai-remote-beam-10g.service',pci:'code-ai-remote-pci.service','ubuntu-gpu-lab':'code-ai-ubuntu-agent.service'};
  const receipt=JSON.parse(await readFile(r.candidate+'/verified-activation-receipt.json','utf8'));
  assert.equal(receipt.buildId,r.buildId);assert.equal(receipt.sharedOwnerEnabled,true);
  assert.equal(receipt.credentialConfigurationBytePreserved,true);assert.equal(receipt.originalPairingAndEnvironmentFilesBytePreserved,true);
  phase='active-core-generation';let pid;
  if(r.id==='main'){
    const pm=JSON.parse(run('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'])).find(x=>x.name==='code-ai-app');
    assert.equal(pm.pm2_env.status,'online');pid=pm.pid;assert.equal(await realpath('/root/projects/code-ai/dist'),r.candidate+'/dist');
  }else{
    assert.equal(ctl(['is-active',services[r.id]]),'active');pid=Number(ctl(['show',services[r.id],'-p','MainPID','--value']));
    assert.equal(await realpath(ctl(['show',services[r.id],'-p','WorkingDirectory','--value'])),await realpath(r.candidate));
  }
  assert.equal(pid,receipt.mainPidAfter);
  const env=Object.fromEntries((await readFile('/proc/'+pid+'/environ','utf8')).split('\0').filter(Boolean).map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];}));
  assert.equal(env.CODE_AI_CODEX_SHARED_OWNER_PROFILES,r.sharedProfiles);
  assert.equal(createHash('sha256').update(await readFile(r.candidate+'/dist/app.mjs')).digest('hex'),r.expectedAppSha256);
  phase='managed-native-owners';const nativeOwners=[];
  for(const p of r.ownerProfiles){
    const unit='code-ai-native-owner-'+p.id+'.service';assert.equal(ctl(['is-active',unit]),'active');
    const probe=JSON.parse(run(r.nodeExecutable,[r.candidate+'/ops/native-owner/probe.mjs',p.codexHome,String(r.ownerUid),'product']));
    assert.equal(probe.managedOwner,true);assert.equal(probe.homeMatched,true);nativeOwners.push({profileId:p.id,loadedThreadCount:probe.loadedThreadCount,statusCounts:probe.statusCounts});
  }
  phase='public-assets-and-upload';
  if(r.id==='main'){
    const {verifyServedAssets}=await import(pathToFileURL(r.candidate+'/transaction-contract.mjs').href);
    await verifyServedAssets({origin:'https://app-codex.bina-cshera.co.il',releaseRoot:r.candidate,fetch,readFile});
    assert.equal(ctl(['is-active','code-ai-upload-api.service']),'active');
    const response=await fetch('http://127.0.0.1:4001/api/auth/check-session',{signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);assert.ok(response.headers.get('content-type')?.includes('application/json'));
  }
  console.log(JSON.stringify({id:r.id,buildId:r.buildId,controllerBuildId:r.ownerControllerBuildId,live:true,pid,sharedOwnerEnabled:true,
    profiles:r.sharedProfiles.split(','),nativeOwners,installedAuthenticationPreservedByTransaction:true,appHashMatched:true,
    publicAssetsAndUploadVerified:r.id==='main',credentialsPrinted:false,observedAt:new Date().toISOString()}));
}catch{console.error(JSON.stringify({verified:false,phase,reason:'installed_generation_readback_failed',installedEffects:false}));process.exitCode=1;}
