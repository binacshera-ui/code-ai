import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import express from 'express';
import {createWorkModeControlHandler, createWorkModeRouter} from './codexWorkModeRoutes.js';

test('a scoped local run works before sidecar authentication, without granting host access', async t => {
  const calls: unknown[] = [];
  const app = express();
  app.use(express.json({limit:'1mb'}));
  app.post('/api/codex/work-mode-control', createWorkModeControlHandler(async (runId, token, action) => {
    assert.equal(token, 'run-capability');
    calls.push({runId, action});
    return {run:{runId}} as any;
  }));
  app.use('/api/codex', (_req, res) => {res.status(401).json({error:'Remote agent token is invalid'});});
  app.use('/api/codex', createWorkModeRouter((_req,_res,next)=>next(), async key=>key));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}/api/codex`;
  const body={runId:'run-1',action:'plan',tasks:[{title:'Verify',estimatedMinutes:1}]};
  const request=(route:string, method='POST', payload:any=body, token='run-capability')=>fetch(origin+route,{
    method,headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-code-ai-server-id':'other-host'},
    ...(method==='POST'?{body:JSON.stringify(payload)}:{})});
  const ok=await request('/work-mode-control');assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{run:{runId:'run-1'}});assert.equal(calls.length,1);
  for(const route of ['/work-mode-runs','/work-mode-control/extra','/work-mode-runs/run-1/release']){
    const response=await request(route);assert.equal(response.status,401);
  }
  assert.equal((await request('/work-mode-control','GET')).status,401);
  assert.equal((await request('/work-mode-control','POST',body,'')).status,403);
  assert.equal((await request('/work-mode-control','POST',[])).status,403);
  assert.equal((await request('/work-mode-control','POST',{...body,evidence:'x'.repeat(100_001)})).status,413);
  assert.equal(calls.length,1);
});

test('the handler requires the actual loopback peer, not forwarded headers', async()=>{
  let called=false;
  const handler=createWorkModeControlHandler(async()=>{called=true;return{} as any;});
  let status=0;
  const res:any={setHeader(){},status(value:number){status=value;return this;},json(){return this;}};
  await handler({socket:{remoteAddress:'192.0.2.10'},headers:{authorization:'Bearer run-capability','x-forwarded-for':'127.0.0.1'},body:{runId:'run-1'}} as any,res,()=>{});
  assert.equal(status,403);assert.equal(called,false);
});

test('wrong run capabilities are rejected without needing or exposing a host token', async()=>{
  const handler=createWorkModeControlHandler(async()=>{throw Object.assign(Error('Forbidden'),{code:'FORBIDDEN'});});
  let status=0,payload:any;
  const res:any={setHeader(){},status(value:number){status=value;return this;},json(value:any){payload=value;return this;}};
  await handler({socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'Bearer wrong-capability'},body:{runId:'run-1'}} as any,res,()=>{});
  assert.equal(status,403);assert.deepEqual(payload,{error:'Forbidden'});
});
