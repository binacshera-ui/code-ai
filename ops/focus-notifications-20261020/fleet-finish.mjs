import fs from'node:fs/promises';import assert from'node:assert/strict';import path from'node:path';
import{fleetClient}from'./fleet-live.mjs';
const root='ops/focus-notifications-20261020',read=async name=>JSON.parse(await fs.readFile(root+'/'+name,'utf8'));
const api=await fleetClient(),release=path.dirname(await fs.realpath('/root/projects/code-ai/dist'));
assert.equal(path.basename(release),'mode-runtime-20261020-f448c9677666');
const report={format:'code-ai-fleet-deployment-receipt',version:1,requestedScope:'all enabled Code AI targets',release:path.basename(release),
 startedAt:(await read('fleet-before.json')).checkedAt,checkedAt:new Date().toISOString(),allTargetsUpdated:false,credentialRotation:false,nativeOwnersRestarted:false,
 provenance:'Reused latest main-server runtime repair; no rebuild and no rollback of owner repair',targets:[],contracts:[]};
for(const [id,profile,sessionKey]of[['local','developer','01a05cd0-8a16-7752-9558-1dbe4f9ebd3f'],['pci','pci-admin','01a158c1-9792-76f0-9a7c-2787dd4bd3ac']]){
 const health=await api(id,'/remote-agent/health');assert.equal(health.version,report.release);assert.equal(health.ready,true);
 for(const [route,field]of[['/session-focus-mode','focusMode'],['/work-mode-runs','runs'],['/session-final-notification','notification']]){
  const value=await api(id,route+'?profileId='+profile+'&sessionKey='+sessionKey);assert.ok(Object.hasOwn(value,field));
  report.contracts.push({id,route,jsonContract:true});
 }
 report.targets.push({id,status:id==='local'?'already-current-verified':'updated-verified',version:health.version,ready:health.ready,
   owners:health.profiles.filter(p=>p.provider==='codex'&&p.mode==='standard').map(p=>({id:p.id,nativePid:p.nativePid,version:p.codexVersion,authenticated:p.authenticated,transportReady:p.transportReady,versionMatched:p.versionMatched}))});
}
const pci=await read('pci-acceptance.json');assert.equal(pci.passed,true);report.pciAcceptance=pci;
report.targets.push({id:'beam-10g',status:'rolled-back-after-acceptance-failure',...await read('beam-10g-rollback.json'),
 failedItemId:'e40a3e59-4b21-45c5-9135-f72a2dda3d7e',nativeError:'Codex app-server request failed (-32603) [thread/start: native-write-timeout]',
 causeProven:false,followUp:'Audit existing beam-admin native-owner responsiveness before any further activation; no blind owner restart'});
report.targets.push({id:'ubuntu-gpu-lab',status:'not-updated-storage-gate',version:'fleet-20261014-9215c438021c',
 controlPlaneReachable:true,sshConnection:'closed',freeBytes:108891910144,totalBytes:982240026624,
 requiredReserveBytes:147336003993.6,requiredAdditionalFreeBytes:38444093849.6,
 externalUserVolumesNotUsed:true,userDataDeleted:false,inspectionTerminalClosed:true});
report.targets.push({id:'personal-windows-me',status:'not-updated-unreachable',controlPlaneHealthHttpStatus:502,sshConnection:'refused'});
const {verifyServedAssets}=await import(release+'/transaction-contract.mjs');
report.publicUi=await verifyServedAssets({origin:'https://app-codex.bina-cshera.co.il',releaseRoot:release,fetch,readFile:fs.readFile});
report.rollbackReleasesPreserved=true;report.finishedAt=new Date().toISOString();
await fs.writeFile(root+'/fleet-deployment-receipt.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({release:report.release,allTargetsUpdated:report.allTargetsUpdated,targets:report.targets.map(t=>({id:t.id,status:t.status,version:t.version})),contractsVerified:report.contracts.length,publicUi:report.publicUi}));
