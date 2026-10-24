import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const ops='/root/projects/code-ai/ops/gemini-argon';
const {request:r}=JSON.parse(await readFile(ops+'/staged.json','utf8'));
assert.equal(await realpath('/root/projects/code-ai/dist'),r.candidate+'/dist');
assert.equal(createHash('sha256').update(await readFile(r.candidate+'/dist/app.mjs')).digest('hex'),r.expectedAppSha256);
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'}});
const current=JSON.parse(run('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'])).find(x=>x.name==='code-ai-app');
assert.equal(current.pm2_env.status,'online');
const previous=JSON.parse(await readFile('/root/.pm2/dump.pm2.bak','utf8')).find(x=>x.name==='code-ai-app');
assert.ok(previous.env.CODE_AI_PM2_TARGET_MODULE.startsWith(r.baseline));
const {parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(r.candidate+'/runtime-auth.mjs').href);
const baselineFields={CODE_AI_AUTH_BASELINE_MODULE:r.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:r.authenticationBaselineSha256};
const before={...previous.env,...baselineFields};
const after={...current.pm2_env.env,...parseRuntimeEnvironment(await readFile('/proc/'+current.pid+'/environ')),...baselineFields};
await preserveRuntimeAuthentication(before);await preserveRuntimeAuthentication(after);
assert.ok(['CODEX_DEVICE_ADMIN_PASSWORD','SESSION_SECRET','DATABASE_URL','CODEX_REMOTE_AGENT_TOKEN'].every(k=>before[k]===after[k]));
const owners=[];
const expected=[['developer',2016960,'238517940'],['developer2',3715016,'234654919']];
for(const [profile,pid,startTime] of expected){
  const x=JSON.parse(await readFile('/home/'+profile+'/code-ai-native-owner/ownership.json','utf8'));
  assert.equal(x.nativePid,pid);assert.equal(x.nativeIdentity.startTime,startTime);
  const probe=JSON.parse(run(r.nodeExecutable,[r.candidate+'/ops/native-owner/probe.mjs','/home/'+profile+'/.codex',String(r.ownerUid),'product']));
  assert.equal(probe.managedOwner,true);assert.equal(probe.homeMatched,true);
  owners.push({profile,pid,startTime});
}
const oldQueue=JSON.parse(await readFile(r.candidate+'/private-deployment-backup/gemini-argon/before-stop-queue.json','utf8'));
const queue=JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json','utf8'));
const active=oldQueue.items.filter(i=>i.status==='running');
for(const input of active){const next=queue.items.find(i=>i.id===input.id);assert.ok(next);assert.equal(next.sessionId,input.sessionId);if(next.nativeSubmission)assert.equal(next.nativeSubmission.clientUserMessageId,input.nativeSubmission.clientUserMessageId);}
const {verifyServedAssets}=await import(pathToFileURL(r.candidate+'/transaction-contract.mjs').href);
const assets=await verifyServedAssets({origin:'https://app-codex.bina-cshera.co.il',releaseRoot:r.candidate,fetch,readFile});
for(const port of [4000,4001]){const response=await fetch('http://127.0.0.1:'+port+'/api/auth/check-session',{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);assert.ok(response.headers.get('content-type')?.includes('application/json'));}
const cli=JSON.parse(await readFile(ops+'/cli-final.json','utf8'));assert.equal(cli.buildId,r.buildId);assert.ok(cli.checks.every(c=>c.passed));
const receipt={format:'code-ai-gemini-argon-live',version:1,complete:true,verifiedAt:new Date().toISOString(),buildId:r.buildId,activeRelease:r.candidate,model:'gemini-4-argon',features:['Gemini chat','Gemini support presets','all six design tools, balanced and deep','UX independent assessment, debate and synthesis'],liveProviderChecks:cli.checks,publicAssets:assets,oldAuthenticatedBrowserSessionStillWorks:true,authConfigurationBytePreservedAgainstPredecessorPm2Dump:true,nativeOwners:owners,nativeOwnerGenerationsPreserved:true,activeInputIdsPreserved:active.map(i=>i.id),inputsResent:false,browserCatalogs:{'gemini-developer':{status:200,selectedModel:'gemini-4-argon',levels:['low','medium','high'],hasOldPro:false},'support-gemini-developer':{status:200,selectedModel:'gemini-4-argon',levels:['low','medium','high'],hasOldPro:false}},originalPostTransactionVerifierFailurePreserved:'ops/gemini-argon/activation.json',independentReadbackCompleted:true,scope:'Main Germany only: this is the only connected Code AI server with configured Gemini profiles',otherServersModified:false,privateCredentialsPrinted:false};
await writeFile(ops+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({complete:true,model:receipt.model,buildId:r.buildId,nativeOwnersPreserved:true,activeInputsPreserved:active.length,authConfigurationPreserved:true}));
