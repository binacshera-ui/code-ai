/** Bounded probes of the actual canonical owner; never read credential files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import WebSocket from 'ws';
const exec = promisify(execFile);
export async function probeCanonicalOwner(home,{timeoutMs=8000,socketPath=path.join(home,'code-ai-shared-owner/owner.sock')}={}) {
 const started=Date.now();const ws=new WebSocket('ws+unix://'+socketPath+':/',{handshakeTimeout:timeoutMs,perMessageDeflate:false,maxPayload:1024*1024});
 let next=0;const pending=new Map();let timer;
 const result={transportReady:false,authenticated:false,accountType:null,reason:null,elapsedMs:0};
 ws.on('error',()=>{});
 ws.on('message',b=>{let f;try{f=JSON.parse(b.toString())}catch{return}const p=pending.get(f.id);if(p){pending.delete(f.id);if(f.error)p.reject(Error('native-rejected'));else p.resolve(f.result)}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const work=async()=>{
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(Error('owner-unavailable')));ws.once('close',()=>reject(Error('owner-disconnected')))});
  const init=await call('initialize',{clientInfo:{name:'code-ai-health',version:'2'},capabilities:{experimentalApi:true}});
  const remoteHome=typeof init?.codexHome==='string'?await fs.realpath(init.codexHome).catch(()=>null):null;
  if(remoteHome!==await fs.realpath(home))throw Error('owner-home-mismatch');
  ws.send(JSON.stringify({method:'initialized',params:{}}));
  await call('configRequirements/read',null);
  const account=await call('account/read',{refreshToken:false});
  result.transportReady=true;result.accountType=account.account?.type||null;result.authenticated=!!result.accountType;
  result.reason=result.authenticated?null:'authentication-required';
 };
 try{await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owner-timeout')),timeoutMs)})]);}
 catch(e){result.reason=['native-rejected','owner-home-mismatch','owner-timeout','owner-unavailable','owner-disconnected'].includes(e.message)?e.message:'owner-unavailable';}
 finally{clearTimeout(timer);ws.terminate();for(const p of pending.values())p.reject(Error('probe-finished'));pending.clear();result.elapsedMs=Date.now()-started}
 return result;
}
async function versionOf(binary,env){
 try{const r=await exec(binary,['--version'],{timeout:5000,maxBuffer:64*1024,env});return r.stdout.trim().match(/codex-cli ([0-9A-Za-z.+-]+)/)?.[1]||null}catch{return null}
}
const healthReads=new Map();
export function invalidateCanonicalOwnerHealth(home){healthReads.delete(home)}
export async function cachedCanonicalOwnerHealth(home, options={}) {
 const prior=healthReads.get(home);if(prior)return prior;
 const pending=probeCanonicalOwner(home,options);healthReads.set(home,pending);
 try{return await pending}finally{if(healthReads.get(home)===pending)healthReads.delete(home)}
}
export async function getCodeAiRuntimeHealth(profiles,{environment=process.env,appRoot=fileURLToPath(new URL('..',import.meta.url))}={}){
 const managed=new Set((environment.CODE_AI_CODEX_SHARED_OWNER_PROFILES||'').split(',').map(x=>x.trim()).filter(Boolean));
 const primary=new Map(profiles.filter(p=>!p.sourceProfileId).map(p=>[p.id,p]));
 let release={version:'development',expectedCodexVersion:null};
 try{release=JSON.parse(await fs.readFile(path.join(appRoot,'release.json'),'utf8'))}catch{}
 const baseRows=await Promise.all(profiles.filter(p=>!p.sourceProfileId).map(async p=>{
  if(p.provider!=='codex')return{id:p.id,label:p.label,provider:p.provider,mode:p.mode,authenticated:true,transportReady:true,reason:null};
  let probe,binary=environment.CODEX_BIN?.trim()||'codex',nativePid=null;
  if(managed.has(p.id)){
   probe={...await cachedCanonicalOwnerHealth(p.codexHome)};
   try{const owner=JSON.parse(await fs.readFile(path.join(path.dirname(p.codexHome),'code-ai-native-owner/ownership.json'),'utf8'));nativePid=owner.nativePid;
    if(!Number.isSafeInteger(nativePid)||nativePid<2)throw Error();binary='/proc/'+nativePid+'/exe';
   }catch{probe.transportReady=false;probe.reason='owner-custody-unavailable'}
  }else{
   try{const r=await exec(binary,['login','status'],{timeout:5000,maxBuffer:64*1024,env:{...environment,CODEX_HOME:p.codexHome}});
    probe={transportReady:true,authenticated:(r.stdout+' '+r.stderr).includes('Logged in'),accountType:null,reason:null};if(!probe.authenticated)probe.reason='authentication-required';
   }catch{probe={transportReady:true,authenticated:false,accountType:null,reason:'authentication-required'}}
  }
  const nativeVersion=await versionOf(binary,{...environment,CODEX_HOME:p.codexHome});
  const expectedVersion=release.expectedCodexVersion||environment.CODE_AI_EXPECTED_CODEX_VERSION||null;
  const versionMatched=!!nativeVersion&&(!expectedVersion||nativeVersion===expectedVersion);
  return{id:p.id,label:p.label,provider:p.provider,mode:p.mode,...probe,nativePid,codexVersion:nativeVersion,expectedCodexVersion:expectedVersion,versionMatched,
   reason:!versionMatched?'version-mismatch':probe.reason};
 }));
 const byId=new Map(baseRows.map(p=>[p.id,p]));
 const decorated=profiles.map(p=>{
  if(!p.sourceProfileId)return byId.get(p.id);
  const source=byId.get(p.sourceProfileId);
  return source?{...source,id:p.id,label:p.label,mode:p.mode,sourceProfileId:p.sourceProfileId}:{id:p.id,label:p.label,provider:p.provider,mode:p.mode,authenticated:false,transportReady:false,reason:'source-profile-unavailable'};
 });
 const versions=[...new Set(baseRows.filter(p=>p.provider==='codex').map(p=>p.codexVersion).filter(Boolean))];
 return {ok:baseRows.every(p=>p.transportReady&&p.versionMatched!==false),ready:baseRows.every(p=>p.transportReady&&p.authenticated&&p.versionMatched!==false),
  version:release.version,codexVersion:versions.length===1?'codex-cli '+versions[0]:versions.length?'mixed':null,checkedAt:new Date().toISOString(),profiles:decorated};
}
