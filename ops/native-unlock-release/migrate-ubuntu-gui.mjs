/** Normal-close only the identified desktop; never delete lock files or stop unrelated writers. */
import assert from 'node:assert/strict';
import {readFile,readlink,readdir,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const [requestFile]=process.argv.slice(2);
const r=JSON.parse(await readFile(requestFile,'utf8'));assert.equal(r.id,'ubuntu-gpu-lab');
const p=r.ownerProfiles.find(p=>p.id==='ubuntu-refael');assert.ok(p);assert.equal(process.getuid(),1000);
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function identity(pid){
  const status=await readFile('/proc/'+pid+'/status','utf8');
  const stat=await readFile('/proc/'+pid+'/stat','utf8');
  return{pid,exe:await readlink('/proc/'+pid+'/exe'),uid:Number(status.match(/^Uid:\s+(\d+)/m)[1]),
    parent:Number(status.match(/^PPid:\s+(\d+)/m)[1]),start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],
    zombie:/^State:\s+Z\b/m.test(status)};
}
async function same(x){try{const now=await identity(x.pid);return now.exe===x.exe&&now.uid===x.uid&&now.start===x.start&&!now.zombie;}catch(e){if(['ENOENT','ESRCH'].includes(e.code))return false;throw e;}}
const gui=await identity(267640),child=await identity(267950);
assert.equal(gui.exe,'/usr/lib/chatgpt/ChatGPT');assert.equal(gui.uid,1000);
assert.equal(await realpath(child.exe),await realpath(p.nativeBinary));assert.equal(child.uid,1000);assert.equal(child.parent,gui.pid);
const originalEnv=Object.fromEntries((await readFile('/proc/'+child.pid+'/environ','utf8')).split('\0').filter(Boolean).map(s=>{const k=s.indexOf('=');return[s.slice(0,k),s.slice(k+1)];}));
const desktopEnv={...process.env};
for(const field of ['DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','XDG_SESSION_TYPE','XAUTHORITY']) if(originalEnv[field])desktopEnv[field]=originalEnv[field];
assert.ok(desktopEnv.DISPLAY||desktopEnv.WAYLAND_DISPLAY,'Known desktop session required');
const oldIds=new Set(),otherIds=new Set();
for(const [pid,target] of [[child.pid,oldIds],[283604,otherIds],[455818,otherIds]]) {
  for(const fd of await readdir('/proc/'+pid+'/fd').catch(()=>[])){
    const name=await readlink('/proc/'+pid+'/fd/'+fd).catch(()=>null);
    const match=name?.match(/(?:thread-)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\.lock|\.jsonl)$/);
    if(match)target.add(match[1]);
  }
}
assert.ok(await same(gui)&&await same(child));process.kill(gui.pid,'SIGTERM');
const closedDeadline=Date.now()+30000;
while(Date.now()<closedDeadline&&(await same(gui)||await same(child)))await sleep(200);
assert.equal(await same(gui),false,'Identified desktop did not close');
assert.equal(await same(child),false,'Identified desktop native child remains live');
const planPath=p.userHome+'/code-ai-native-owner/profile-'+(r.ownerControllerBuildId||r.buildId)+'.json';
execFileSync(r.nodeExecutable,[r.candidate+'/ops/native-owner/gui-launcher.mjs',planPath],{env:desktopEnv,stdio:'pipe',timeout:15000});
let next,shim;
const deadline=Date.now()+45000;
while(Date.now()<deadline){
  for(const name of await readdir('/proc')) {
    if(!/^\d+$/.test(name))continue;
    try{
      const info=await identity(Number(name));
      if(info.uid!==1000)continue;
      const cmd=await readFile('/proc/'+name+'/cmdline','utf8');
      if(info.exe==='/usr/lib/chatgpt/ChatGPT'&&!cmd.includes('--type=')) {
        const env=await readFile('/proc/'+name+'/environ','utf8');
        if(env.split('\0').includes('CODEX_CLI_PATH='+r.candidate+'/scripts/codex-shared-cli.mjs'))next=info;
      }
      if(next&&info.parent===next.pid&&cmd.includes(r.candidate+'/scripts/codex-shared-cli.mjs')&&cmd.split('\0').includes('app-server'))shim=info;
    }catch{}
  }
  if(next&&shim)break;await sleep(300);
}
assert.ok(next&&shim,'Live desktop did not use managed stdio adapter');
const require=createRequire(r.candidate+'/package.json'),WebSocket=require('ws');
const socket=p.codexHome+'/code-ai-shared-owner/owner.sock';
const ws=new WebSocket('ws+unix://'+socket+':/',{handshakeTimeout:5000});
let id=0;const pending=new Map();
ws.on('message',data=>{let f;try{f=JSON.parse(data.toString());}catch{return;}let q=pending.get(f.id);if(!q)return;pending.delete(f.id);clearTimeout(q.timer);f.error?q.reject(new Error('Native GUI acceptance RPC refused')):q.resolve(f.result);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const request=++id,timer=setTimeout(()=>{pending.delete(request);reject(new Error('Native GUI acceptance timed out'));},15000);pending.set(request,{timer,resolve,reject});ws.send(JSON.stringify({id:request,method,params}));});
let resumed=false;
try {
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('Managed owner unreachable')));});
  const init=await rpc('initialize',{clientInfo:{name:'code-ai-live-desktop-acceptance',version:'1.0'},capabilities:{experimentalApi:true}});
  assert.equal(init.codeAiSharedOwner?.version,1);assert.equal(await realpath(init.codexHome),await realpath(p.codexHome));
  ws.send(JSON.stringify({method:'initialized',params:{}}));
  const target=[...oldIds].find(x=>!otherIds.has(x));
  if(target){const v=await rpc('thread/resume',{threadId:target});assert.equal(v.thread?.id,target);resumed=true;}
}finally{ws.terminate();}
const receipt={format:'code-ai-live-native-gui-migration',version:1,buildId:r.buildId,profileId:p.id,
  previousGuiPid:gui.pid,previousNativeChildPid:child.pid,guiPid:next.pid,managedStdioChildPid:shim.pid,
  oldScopedDesktopAndItsWriterExited:true,liveGuiUsesManagedDispatcher:true,managedOwnerAndHomeVerified:true,
  existingDesktopThreadResumedBySameOwner:resumed,oldDesktopThreadCandidates:oldIds.size,
  unrelatedNativeWritersStopped:false,writerLockInodesDeleted:false,realModelTurns:0,credentialsPrinted:false,observedAt:new Date().toISOString()};
await writeFile(r.candidate+'/gui-migration-receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(receipt));
