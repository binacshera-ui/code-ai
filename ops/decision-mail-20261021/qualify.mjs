import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
const root=process.argv[2],out=process.argv[3];
const service=root+'/platform/failure-handling';
execFileSync(process.execPath,['--test',service+'/tests/failure-service.test.js'],{cwd:service,stdio:'inherit'});
const {createApp}=await import(pathToFileURL(service+'/src/app.js'));
const tally={reports:0,prepares:0,sends:0,signals:0};
const reports=new Map();
const upstream=http.createServer(async(req,res)=>{
 try{
 let raw='';for await(const chunk of req)raw+=chunk;const payload=raw?JSON.parse(raw):{};
 let body;const match=req.url.match(/^\/v1\/incident-cases\/(internal|support)\/(reports|package)$/);
 if(match){const[,id,action]=match;
  if(action==='reports'){tally.reports++;reports.set(id,payload);body={created:true,incident_report:{incident_report_id:'report_'+tally.reports},incident_case:{incident_case_id:id,status:'waiting_operator'}};}
  else body={package:{incident_case:{incident_case_id:id,metadata:id==='internal'?{decision_mode:true,codeAiServerId:'pci'}:{},title:'Synthetic acceptance'},reports:[reports.get(id)]}};
 }else if(req.url==='/v1/deliveries'){tally.prepares++;body={delivery_record:{delivery_record_id:'fake_delivery'}};}
 else if(req.url==='/v1/deliveries/fake_delivery/send'){tally.sends++;body={delivery_record:{delivery_record_id:'fake_delivery',status:'sent'}};}
 else if(/^\/v1\/incidents\/[^/]+\/signal$/.test(req.url)){tally.signals++;body={ok:true};}
 else throw Error('Unexpected synthetic request '+req.url);
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));
 }catch(e){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:e.message}));}
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const baseUrl='http://127.0.0.1:'+upstream.address().port;
const app=await createApp({server:{authToken:''},incidentCenter:{baseUrl:'http://example.invalid/incident-center'},services:Object.fromEntries(['appData','delivery','billing','orchestration'].map(k=>[k,{baseUrl,authToken:''}]))});
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 const url='http://127.0.0.1:'+server.address().port;
 const verification=await promisify(execFile)(process.execPath,[root+'/verify-release-candidate.mjs',
  '--candidate',root,'--active','/root/projects/bina-cshera-root/bina-cshera-2.0/platform/failure-handling',
  '--require','platform/failure-handling/src/index.js','--require','platform/failure-handling/package.json','--health',url+'/healthz','--expect-content-type','application/json']);
 console.log(verification.stdout);
 for(const summary of ['Initial internal report','Later report without a decision-mode payload']){
  const response=await fetch(url+'/v1/incident-cases/internal/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({summary,notify_support:true,send_notifications:true})});
  assert.equal(response.status,201);assert.equal((await response.json()).support_delivery,null);
 }
 assert.deepEqual(tally,{reports:2,prepares:0,sends:0,signals:2});
 const response=await fetch(url+'/v1/incident-cases/support/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({summary:'Ordinary support report'})});
 assert.equal(response.status,201);assert.ok((await response.json()).support_delivery);
 assert.deepEqual(tally,{reports:3,prepares:1,sends:1,signals:3});
 await fs.writeFile(out,JSON.stringify({passed:true,checkedAt:new Date().toISOString(),unitTestsPassed:true,
  actualHttpRoutes:true,internalReports:2,internalMailPrepared:0,internalMailSent:0,ordinarySupportMailPreserved:true,
  workflowSignalsPreserved:true,upstreams:'isolated loopback stubs only',noRealEmailSent:true},null,2)+'\n');
 console.log(JSON.stringify({qualified:true,internalMailPrepared:0,internalMailSent:0,ordinarySupportPreserved:true}));
}finally{server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);}
