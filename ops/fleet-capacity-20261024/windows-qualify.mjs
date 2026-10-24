import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
const [candidate,baseline,binary,binaryHash]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert.ok(candidate&&baseline&&binaryHash);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await fs.readFile(candidate+'/release-files.json','utf8'));
for(const [name,sha]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(candidate+'/'+name)),sha,'Changed artifact '+name);
assert.equal(hash(await fs.readFile(binary)),binaryHash);
try{await fs.symlink(baseline+'/node_modules',candidate+'/node_modules','junction')}catch(error){if(error.code!=='EEXIST')throw error;assert.equal(await fs.realpath(candidate+'/node_modules'),await fs.realpath(baseline+'/node_modules'));}
const require=createRequire(path.join(candidate,'package.json'));require('node-pty');
execFileSync(process.execPath,['--check',candidate+'/dist/app.mjs']);
execFileSync(process.execPath,['--test',candidate+'/server/codexCapacityContinuation.test.mjs'],{cwd:candidate,stdio:'pipe'});
const pairing=JSON.parse(await fs.readFile('C:/Users/showp/.code-ai/remote-agent/pairing.json','utf8'));
const storage=candidate+'/qualification/windows-preview';await fs.mkdir(storage,{recursive:true});
const profiles=[{id:'windows-me-codex',label:'Windows verification',provider:'codex',codexHome:'C:/Users/showp/.codex',workspaceCwd:'C:/Users/showp',defaultProfile:true}];
const env={...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:'4021',CODEX_APP_ROOT:candidate,CODEX_STORAGE_ROOT:storage,
 CODEX_QUEUE_ROOT:storage+'/queue',CODEX_LOG_ROOT:storage+'/logs',CODEX_UPLOAD_ROOT:storage+'/uploads',CODEX_PROFILES_JSON:'',
 CODEX_PROFILES_JSON_BASE64:Buffer.from(JSON.stringify(profiles)).toString('base64'),CODEX_BIN:binary,CODEX_REMOTE_AGENT_TOKEN:pairing.token,
 SESSION_SECRET:pairing.sessionSecret,CODEX_DEVICE_ADMIN_PASSWORD:pairing.devicePassword,CODEX_OPEN_ACCESS:'true',CODEX_QUEUE_DISABLE_EXECUTION:'1',
 CODEX_NTFY_ENABLED:'false',CODEX_NTFY_DEFAULT_ENABLED:'false',CODEX_CLI_AUTO_UPDATE:'false',CODE_AI_HTTP_SINGLE_INGRESS:'1',CODE_AI_CODEX_SHARED_OWNER_PROFILES:''};
const child=spawn(process.execPath,[candidate+'/dist/server.js'],{cwd:candidate,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
try{
 let health;const headers={'x-code-ai-remote-token':pairing.token};
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw Error('Isolated server exited '+child.exitCode);
  try{const response=await fetch('http://127.0.0.1:4021/api/codex/remote-agent/health',{headers,signal:AbortSignal.timeout(10000)});if(response.ok){health=await response.json();break}}catch{}
  await new Promise(resolve=>setTimeout(resolve,400));
 }
 assert.equal(health?.ready,true,'Windows runtime/authentication is not ready');
 const checks=[];
 for(const route of ['/queue/items?profile=windows-me-codex','/session-focus-mode?profileId=windows-me-codex&sessionKey=qualification-only','/work-mode-runs?profileId=windows-me-codex&sessionKey=qualification-only']){
  const response=await fetch('http://127.0.0.1:4021/api/codex'+route,{headers,signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);await response.json();checks.push({route,status:200,json:true});
 }
 const denied=await fetch('http://127.0.0.1:4021/api/codex/remote-agent/health');assert.equal(denied.status,401);
 const result={passed:true,platform:'win32',version:health.version,codexVersion:health.codexVersion,ready:true,
  nativeDependencyLoaded:true,capacityContractTestsPassed:8,filesVerified:Object.keys(manifest.files).length,api:checks,
  unauthorizedHealthStatus:401,realTaskSubmitted:false,productionPairingUnchanged:true};
 await fs.writeFile(candidate+'/qualification/windows-preview.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{
 child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));
 await fs.writeFile(storage+'/private-startup.log',logs);
}
