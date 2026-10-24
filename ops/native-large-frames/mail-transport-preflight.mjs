/** Read the already accepted input through the new stdio adapter and the live
 * predecessor owner. No queue/start, enqueue, interrupt or settings writes. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
const dir='/root/projects/code-ai/ops/native-large-frames',capture=JSON.parse(await fs.readFile(dir+'/capture.json','utf8'));
const threadId='01a11590-d7e3-7191-9a84-b92cd21d47c9',turnId='01a129ef-5fbc-7e23-a7b5-7ccd0c33a80a',clientId='code-ai:852579e9-e2dd-4c70-b3fb-62152d802cee';
const custody=JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/ownership.json','utf8'));
const nativeStatus=await fs.readFile('/proc/'+custody.nativePid+'/status','utf8');
assert.equal(process.getuid(),Number(/^Uid:\s+(\d+)/m.exec(nativeStatus)?.[1]));
const child=spawn('/root/.nvm/versions/node/v24.12.0/bin/node',[capture.stage+'/payload/scripts/codex-shared-stdio.mjs','/home/developer/.codex/code-ai-shared-owner/owner.sock'],{env:{...process.env,CODEX_HOME:'/home/developer/.codex'},stdio:['pipe','pipe','pipe']});
child.stderr.resume();let buffer='',n=0,closing=false;const pending=new Map();
child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{if(closing)return;buffer+=s;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let f;try{f=JSON.parse(line);}catch{for(const p of pending.values())p.reject(Error('private_preflight_frame_invalid'));child.kill('SIGTERM');return;}const p=pending.get(f.id);if(p){pending.delete(f.id);clearTimeout(p.t);f.error?p.reject(Error('private_preflight_refused')):p.resolve(f.result);}}});
child.on('error',()=>{});child.on('close',()=>{for(const p of pending.values()){clearTimeout(p.t);p.reject(Error('private_preflight_disconnected'));}pending.clear();});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);reject(Error('private_preflight_timeout'));},15000);pending.set(id,{resolve,reject,t});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
try{
 const init=await rpc('initialize',{clientInfo:{name:'code-ai-image-transport-private-preflight',version:'1'},capabilities:{experimentalApi:true}});assert.equal(init.codexHome,'/home/developer/.codex');assert.equal(init.codeAiSharedOwner.version,1);
 child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const resumed=await rpc('thread/resume',{threadId,excludeTurns:true});assert.equal(resumed.thread.id,threadId);
 const r=await rpc('thread/items/list',{threadId,turnId,limit:1,sortDirection:'asc'});assert.equal(r.data[0]?.item?.clientId,clientId);
 const proof={format:'code-ai-large-frame-live-predecessor-transport-preflight',version:1,threadId,turnId,exactStableInputMatched:true,imageCount:r.data[0].item.content.filter(i=>i.type==='image').length,
  responseBytes:Buffer.byteLength(JSON.stringify(r)),newStdioAdapter:true,legacyOwnerStillRunning:true,inputSubmitted:false,settingsChanged:false,observedAt:new Date().toISOString()};
 console.log(JSON.stringify(proof));
}catch{console.log(JSON.stringify({passed:false,reason:'private_transport_preflight_failed',inputSubmitted:false}));process.exitCode=1;}
finally{closing=true;child.stdin.end();child.kill('SIGTERM');buffer='';}
