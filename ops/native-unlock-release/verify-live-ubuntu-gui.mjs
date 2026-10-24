/** Evidence-only replacement for a zeroed Electron parent environ gate. */
import assert from 'node:assert/strict';
import {readFile,readlink,readdir,realpath,lstat,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const [requestFile]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=(p,a)=>execFileSync(p,a,{encoding:'utf8',stdio:'pipe',timeout:15000,maxBuffer:16*1024*1024}).trim();
let phase='request',rpcRefusalMetadata=null;
try {
  const r=JSON.parse(await readFile(requestFile,'utf8'));assert.equal(r.id,'ubuntu-gpu-lab');assert.equal(process.getuid(),1000);
  const p=r.ownerProfiles.find(x=>x.id==='ubuntu-refael');assert.ok(p);
  const plan=JSON.parse(await readFile(p.userHome+'/code-ai-native-owner/profile-'+r.ownerControllerBuildId+'.json','utf8'));
  phase='artifact-manifests';
  for(const [root,pin] of [[r.candidate,null],[r.ownerControllerDirectory,r.ownerControllerManifestSha256]]){
    const bytes=await readFile(root+'/release-files.json');if(pin)assert.equal(hash(bytes),pin);
    const manifest=JSON.parse(bytes);for(const [f,sha] of Object.entries(manifest.files)){
      assert.ok(!f.startsWith('/')&&!f.split('/').includes('..'));assert.equal(hash(await readFile(root+'/'+f)),sha);
    }
  }
  assert.equal(hash(await readFile(r.candidate+'/dist/app.mjs')),r.expectedAppSha256);
  assert.equal(hash(await readFile(plan.nativeBinary)),plan.nativeBinarySha256);
  assert.equal(hash(await readFile(plan.brokerModule)),plan.brokerModuleSha256);
  assert.equal(run('/usr/bin/systemctl',['--user','is-active','code-ai-native-owner-ubuntu-refael.service']),'active');
  phase='custody';
  const custody=JSON.parse(await readFile(plan.ownerDirectory+'/ownership.json','utf8'));
  assert.equal(custody.version,2);assert.equal(custody.codexHome,await realpath(p.codexHome));
  const ready=JSON.parse(await readFile(plan.ownerDirectory+'/ready.json','utf8'));
  assert.equal(ready.profileVerified,true);assert.equal(ready.nativePid,custody.nativePid);
  async function ident(pid){
    const status=await readFile('/proc/'+pid+'/status','utf8'),stat=await readFile('/proc/'+pid+'/stat','utf8');
    assert.equal(Number(status.match(/^Uid:\s+(\d+)/m)[1]),1000);assert.ok(!/^State:\s+Z\b/m.test(status));
    return {pid,parent:Number(status.match(/^PPid:\s+(\d+)/m)[1]),startTime:stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19],
      executable:await realpath('/proc/'+pid+'/exe'),cgroupSha256:hash(await readFile('/proc/'+pid+'/cgroup')),
      networkNamespace:await readlink('/proc/'+pid+'/ns/net')};
  }
  phase='gui-process-chain';
  const gui=await ident(494435),dispatcher=await ident(494622),adapter=await ident(494636);
  assert.equal(gui.executable,'/usr/lib/chatgpt/ChatGPT');assert.equal(dispatcher.parent,gui.pid);assert.equal(adapter.parent,dispatcher.pid);
  for(const x of [dispatcher,adapter]){assert.equal(x.executable,await realpath(plan.nodeBinary));assert.equal(x.cgroupSha256,gui.cgroupSha256);}
  const args=async pid=>(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0').filter(Boolean);
  const dispatcherArgs=await args(dispatcher.pid),adapterArgs=await args(adapter.pid);
  assert.equal(dispatcherArgs[1],plan.dispatcherModule);assert.equal(adapterArgs[1],plan.adapterModule);assert.equal(adapterArgs[2],plan.frontendSocket);
  const {parseAppServerArguments}=await import(pathToFileURL(plan.dispatcherModule).href);
  assert.ok(parseAppServerArguments(dispatcherArgs.slice(2)));
  const environment=async pid=>Object.fromEntries((await readFile('/proc/'+pid+'/environ','utf8')).split('\0').filter(Boolean).map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];}));
  phase='managed-child-environment';
  for(const pid of [dispatcher.pid,adapter.pid]){
    const env=await environment(pid);for(const [key,value] of Object.entries({HOME:plan.userHome,CODEX_HOME:plan.codexHome,CODEX_CLI_PATH:plan.dispatcherModule,
      CODE_AI_CODEX_NATIVE_BIN:plan.nativeBinary,CODE_AI_CODEX_SHARED_SOCKET:plan.frontendSocket,CODE_AI_CODEX_SHARED_STDIO:plan.adapterModule}))assert.equal(env[key],value);
  }
  phase='native-process-custody';
  const native=await ident(custody.nativePid),runner=await ident(custody.runnerPid);
  for(const [x,record] of [[native,custody.nativeIdentity],[runner,custody.runnerIdentity]])for(const k of ['startTime','executable','cgroupSha256','networkNamespace'])assert.equal(x[k],record[k]);
  assert.equal(native.executable,await realpath(plan.nativeBinary));assert.equal(native.cgroupSha256,runner.cgroupSha256);
  async function inodes(pid){const out=new Set();for(const f of await readdir('/proc/'+pid+'/fd')){const link=await readlink('/proc/'+pid+'/fd/'+f).catch(()=>null),m=link?.match(/^socket:\[(\d+)\]$/);if(m)out.add(m[1]);}return out;}
  const [guiFDs,adapterFDs,runnerFDs,nativeFDs]=await Promise.all([gui.pid,adapter.pid,runner.pid,native.pid].map(inodes));
  phase='socket-peers';
  const ss=run('/usr/bin/ss',['-xnpH']).split('\n').map(x=>x.trim().split(/\s+/));
  assert.equal(ss.filter(x=>x[1]==='ESTAB'&&x[4]===plan.frontendSocket&&runnerFDs.has(x[5])&&adapterFDs.has(x[7])).length,1);
  for(const fd of ['0','1','2']){
    const link=await readlink('/proc/'+dispatcher.pid+'/fd/'+fd),m=link.match(/^socket:\[(\d+)\]$/);assert.ok(m);
    assert.equal(await readlink('/proc/'+adapter.pid+'/fd/'+fd),link);
    assert.ok(ss.some(x=>x[1]==='ESTAB'&&x[5]===m[1]&&guiFDs.has(x[7])));
  }
  phase='native-listening-fd';
  const target=custody.backend.kind==='native-alias'?custody.backend.target.path:custody.backendSocket;
  const listeners=(await readFile('/proc/net/unix','utf8')).split('\n').map(x=>x.trim().split(/\s+/)).filter(x=>x[7]===target&&x[4]==='0001'&&x[5]==='01'&&(BigInt('0x'+x[3])&0x10000n));
  assert.equal(listeners.length,1);assert.ok(nativeFDs.has(listeners[0][6]));
  phase='gui-native-writer-census';
  const processes=[];for(const n of await readdir('/proc'))if(/^\d+$/.test(n))try{processes.push(await ident(Number(n)));}catch{}
  const children=new Set([gui.pid]);let changed=true;while(changed){changed=false;for(const x of processes)if(children.has(x.parent)&&!children.has(x.pid)){children.add(x.pid);changed=true;}}
  let standalone=0;for(const x of processes)if(children.has(x.pid)&&x.executable===native.executable){if((await args(x.pid)).includes('app-server'))standalone++;}
  assert.equal(standalone,0);
  const require=createRequire(r.candidate+'/package.json'),WebSocket=require('ws');
  const ws=new WebSocket('ws+unix://'+plan.frontendSocket+':/',{handshakeTimeout:5000,maxPayload:32*1024*1024});
  let next=0;const pending=new Map();ws.on('message',b=>{let f;try{f=JSON.parse(b.toString());}catch{return;}const q=pending.get(f.id);if(q){pending.delete(f.id);clearTimeout(q.timer);if(f.error){rpcRefusalMetadata={method:q.method,numericCode:Number.isInteger(f.error.code)?f.error.code:null,admission:['uncertain','notAccepted'].includes(f.error.data?.codeAiAdmission)?f.error.data.codeAiAdmission:null,reason:/^[a-z-]{1,70}$/.test(f.error.data?.reason||'')?f.error.data.reason:null};q.reject(new Error('RPC refused'));}else q.resolve(f.result);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout'));},15000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params}));});
  let existingThreadCount,gpuCwdThreadCount,historyPageTurns,historyPageItems;
  try{
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('Owner unavailable')));});
    const init=await rpc('initialize',{clientInfo:{name:'code-ai-live-shared-gui-acceptance',version:'1.0'},capabilities:{experimentalApi:true}});
    assert.equal(init.codeAiSharedOwner?.version,1);assert.equal(await realpath(init.codexHome),await realpath(plan.codexHome));ws.send(JSON.stringify({method:'initialized',params:{}}));
    phase='existing-gpu-thread-resume';
    const listed=await rpc('thread/list',{limit:100,archived:false});assert.ok(Array.isArray(listed.data));existingThreadCount=listed.data.length;
    const gpu=listed.data.filter(x=>typeof x.cwd==='string'&&/gpu/i.test(x.cwd));gpuCwdThreadCount=gpu.length;assert.ok(gpu.length);
    // Use the installed GUI's paginated-history contract, not a fabricated
    // unpaged 24 MB read that exceeds the qualified bounded frame interface.
    const metadata=await rpc('thread/read',{threadId:gpu[0].id,includeTurns:false});
    assert.equal(metadata.thread?.id,gpu[0].id);assert.equal(metadata.thread?.historyMode,'paginated');
    const resumed=await rpc('thread/resume',{threadId:gpu[0].id,excludeTurns:true});assert.equal(resumed.thread?.id,gpu[0].id);
    const page=await rpc('thread/turns/list',{threadId:gpu[0].id,cursor:null,limit:5,itemsView:'notLoaded',sortDirection:'desc'});
    assert.ok(Array.isArray(page.data)&&page.data.length>0&&page.data.length<=5);historyPageTurns=page.data.length;
    historyPageItems=0;
    for(const turn of page.data){
      const items=await rpc('thread/items/list',{threadId:gpu[0].id,turnId:turn.id,cursor:null,limit:100,sortDirection:'desc'});
      assert.ok(Array.isArray(items.data)&&items.data.length<=100);historyPageItems+=items.data.length;
    }
    assert.ok(historyPageItems>0,'Existing GPU history items required');
  }finally{ws.terminate();}
  phase='stable-generation';
  for(const x of [gui,dispatcher,adapter,native,runner])assert.deepEqual(await ident(x.pid),x);
  const parentEnv=await readFile('/proc/'+gui.pid+'/environ');
  const receipt={format:'code-ai-live-native-gui-migration-readback',version:1,buildId:r.buildId,controllerBuildId:r.ownerControllerBuildId,
    profileId:p.id,guiPid:gui.pid,managedStdioChildPid:dispatcher.pid,adapterPid:adapter.pid,nativePid:native.pid,
    actualChildChainVerified:true,pinnedArtifactsAndNativeVerified:true,managedChildEnvironmentsVerified:true,parentEnvironEntirelyZeroed:parentEnv.length>0&&parentEnv.every(x=>x===0),
    guiStdioSocketPeersVerified:true,adapterToBrokerSocketPeerVerified:true,nativeListeningFdCustodyVerified:true,standaloneGuiNativeAppServers:standalone,
    liveGuiUsesManagedDispatcher:true,managedOwnerAndHomeVerified:true,existingGpuThreadResumedSameIdWithHistory:true,
    existingThreadCount,gpuCwdThreadCount,historyMode:'paginated',installedGuiHistoryQueryShapeVerified:true,historyPageTurns,historyPageItems,
    fullUnpagedHistorySupported:false,qualifiedFrameLimitBytes:8*1024*1024,previousSelectedDesktopThreadIdKnown:false,realModelTurns:0,credentialsPrinted:false,transcriptsPrinted:false,
    unrelatedNativeWritersStopped:false,writerLockInodesDeleted:false,observedAt:new Date().toISOString()};
  await writeFile(r.candidate+'/gui-migration-readback-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(receipt));
}catch(e){const line=e.stack?.match(/(?:eval\d*|verify-live-ubuntu-gui\.mjs)[^\n]*?:(\d+):\d+/)?.[1];console.error(JSON.stringify({verified:false,phase,sourceLine:line?Number(line):null,rpcRefusalMetadata,reason:'live_gui_contract_readback_failed',runtimeChanged:false}));process.exitCode=1;}
