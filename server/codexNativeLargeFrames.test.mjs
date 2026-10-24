import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket, {WebSocketServer} from 'ws';
import {startCodexSharedOwnerBroker, CodexSharedOwnerBroker} from './codexSharedOwnerBroker.mjs';
import {NATIVE_FRAME_BYTES, NATIVE_BUFFER_BYTES, assertNativeHistoryRead} from './codexNativeTransport.mjs';

test('21MB native user item crosses broker and stdio before ACK without detaching or duplicating input', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'code-ai-large-item-'));
  const home = path.join(dir, 'home'); await mkdir(home,{mode:0o700});
  const socket = path.join(dir, 'native.sock'), front = path.join(dir, 'front.sock');
  const server = createServer(), native = new WebSocketServer({server,maxPayload:NATIVE_FRAME_BYTES});
  const images = Array.from({length:10},()=>({type:'image',url:'data:image/png;base64,'+'A'.repeat(2_100_000)}));
  const item = {type:'userMessage',id:'user',clientId:'own',content:images};
  let submissions = 0, state = {model:'mock',reasoningEffort:'medium',cwd:dir,approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
  native.on('connection', w => w.on('message', raw => {
    const f=JSON.parse(raw.toString()), send=result=>w.send(JSON.stringify({id:f.id,result}));
    if(f.method==='initialize')send({codexHome:home});
    else if(f.method==='thread/start'||f.method==='thread/resume')send({...state,thread:{id:'thread'}});
    else if(f.method==='thread/queue/list')send({data:[],nextCursor:null});
    else if(f.method==='thread/settings/update'){
      state={model:f.params.model,reasoningEffort:f.params.effort,cwd:f.params.cwd,approvalPolicy:f.params.approvalPolicy,sandbox:f.params.sandboxPolicy};
      send({});w.send(JSON.stringify({method:'thread/settings/updated',params:{threadId:'thread',threadSettings:{...f.params,collaborationMode:{mode:'default'}}}}));
    }else if(f.method==='thread/queue/add'){
      submissions++;w.send(JSON.stringify({method:'item/started',params:{threadId:'thread',turnId:'turn',item}}));
      send({queuedSubmission:{id:'queued',clientUserMessageId:'own'}});
    }else if(f.method==='thread/items/list')send({data:[{turnId:'turn',item}],nextCursor:null});
  }));
  server.listen(socket);await once(server,'listening');
  const broker = await startCodexSharedOwnerBroker({socketPath:front,backendSocket:socket,codexHome:home,journalPath:path.join(dir,'journal.json')});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/codex-shared-stdio.mjs',import.meta.url)),front],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  let output='', n=0, notifications=0;const pending=new Map();child.stdout.setEncoding('utf8');child.stderr.resume();
  child.stdout.on('data',chunk=>{output+=chunk;let e;while((e=output.indexOf('\n'))>=0){const f=JSON.parse(output.slice(0,e));output=output.slice(e+1);if(f.method==='item/started'){assert.equal(f.params.item.content.length,10);notifications++;}else if(pending.has(f.id)){const p=pending.get(f.id);pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(Error('fixture RPC refused')):p.resolve(f.result);}}});
  child.on('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('fixture adapter closed'));}pending.clear();});
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('fixture timed out'));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  t.after(async()=>{child.stdin.end();if(child.exitCode===null)child.kill('SIGTERM');await broker.close();for(const w of native.clients)w.terminate();await new Promise(y=>native.close(y));await new Promise(y=>server.close(y));await rm(dir,{recursive:true,force:true});});
  await call('initialize',{clientInfo:{name:'code-ai'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  await call('thread/start',{});
  const ack=await call('thread/queue/add',{threadId:'thread',clientUserMessageId:'own',input:[{type:'text',text:'synthetic'}],codeAiTurnSettings:{model:'mock',effort:'medium',cwd:dir,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}});
  assert.equal(ack.queuedSubmission.id,'queued');assert.equal(notifications,1);assert.equal(submissions,1);
  const page=await call('thread/items/list',{threadId:'thread',turnId:'turn',limit:1});
  assert.equal(page.data[0].item.content[9].url,images[9].url);
  assert.ok(Buffer.byteLength(JSON.stringify(page))>8*1024*1024);
  assert.ok(NATIVE_BUFFER_BYTES>=2*NATIVE_FRAME_BYTES);
  assert.equal(broker.broker.records.get('thread').turnId,'turn');
});

test('paginated broker restart recovers an uncertain exact input without queue/add or foreign adoption',async()=>{
  const settings={model:'mock',effort:'medium',cwd:'/fixture',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}};
  const record={threadId:'t',clientId:'own',queuedId:null,turnId:null,phase:'uncertain',previous:settings,requested:settings,createdAt:1,turnComplete:false,collaborationMode:'default'};
  const broker=new CodexSharedOwnerBroker({records:[record]});const calls=[];
  await broker.recover({call:async(m,p)=>{calls.push(m);if(m==='thread/resume')return{model:'mock',reasoningEffort:'medium',cwd:'/fixture',approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};if(m==='thread/read'){assert.equal(p.includeTurns,false);return{thread:{id:'t',historyMode:'paginated'}};}if(m==='thread/turns/list')return{data:[{id:'turn',status:'completed'}],nextCursor:null};if(m==='thread/items/list')return{data:[{turnId:'turn',item:{type:'userMessage',clientId:'own'}}],nextCursor:null};return{};}});
  assert.equal(record.turnId,'turn');assert.equal(record.phase,'released');assert.equal(record.turnComplete,true);
  assert.equal(calls.includes('thread/queue/add'),false);
});

test('private compatibility reads reject every mutation and malformed target before connecting',()=>{
  for(const m of ['thread/queue/add','thread/queue/start','turn/steer','thread/settings/update','initialize'])assert.throws(()=>assertNativeHistoryRead(m,{threadId:'t'}));
  for(const p of [null,{}, {threadId:'../other'}, {threadId:''}])assert.throws(()=>assertNativeHistoryRead('thread/read',p));
  assert.doesNotThrow(()=>assertNativeHistoryRead('thread/items/list',{threadId:'exact',turnId:'turn'}));
});
