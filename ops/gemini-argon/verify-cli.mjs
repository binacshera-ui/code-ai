import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,copyFile,mkdir} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),ops='/root/projects/code-ai/ops/gemini-argon';
const {request}=JSON.parse(await readFile(ops+'/staged.json','utf8'));
const pm2='/root/.nvm/versions/node/v24.12.0/bin/pm2';
const record=JSON.parse(execFileSync(pm2,['jlist'],{encoding:'utf8',stdio:'pipe',env:{...process.env,PM2_HOME:'/root/.pm2'}})).find(v=>v.name==='code-ai-app');
const {parseRuntimeEnvironment}=await import(pathToFileURL(request.candidate+'/runtime-auth.mjs').href);
const environment={...process.env,...record.pm2_env.env,...parseRuntimeEnvironment(await readFile('/proc/'+record.pid+'/environ'))};
for(const key of ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_UNIQUE_ID','NODE_OPTIONS'])delete environment[key];
const storage=await mkdtemp(request.candidate+'/live-gemini-qualification-');
await mkdir(storage+'/uploads',{recursive:true});
await copyFile(ops+'/cli-verification.json',ops+'/cli-verification-previous-'+Date.now()+'.json').catch(e=>{if(e.code!=='ENOENT')throw e;});
Object.assign(environment,{CODEX_STORAGE_ROOT:storage,CODEX_APP_ROOT:'/root/projects/code-ai',
  CODEX_DEVICE_ADMIN_PASSWORD:'argon-isolated-cli-probe-device',SESSION_SECRET:'argon-isolated-cli-probe-signing'});
// Derived support homes follow storageRoot. Explicitly bind the two real
// credential homes while keeping queue/cache writes in the isolated directory.
environment.CODEX_PROFILES_JSON=JSON.stringify([
  {id:'gemini-developer',label:'Gemini probe',provider:'gemini',mode:'standard',codexHome:'/home/developer/.gemini',workspaceCwd:storage,defaultProfile:true},
  {id:'support-gemini-developer',label:'Support probe',provider:'gemini',mode:'support',sourceProfileId:'gemini-developer',codexHome:'/root/projects/code-ai/.code-ai/support/homes/gemini/gemini-developer/.gemini',workspaceCwd:storage,sandboxCwd:storage,defaultProfile:false},
]);
delete environment.CODEX_PROFILES_JSON_BASE64;
const checks=[];
const tasks=[['gemini-developer','argon-cli-smoke.mjs'],['support-gemini-developer','argon-cli-smoke.mjs'],['gemini-developer','argon-design-smoke.mjs'],['gemini-developer','argon-ux-smoke.mjs']];
for(const [profile,script] of tasks.filter(([profile])=>!process.env.CODE_AI_ARGON_ONLY_PROFILE||profile===process.env.CODE_AI_ARGON_ONLY_PROFILE)){
  try{
    const {stdout}=await exec(request.nodeExecutable,[request.candidate+'/qualification/'+script],{
      cwd:request.candidate,env:{...environment,CODE_AI_ARGON_PROFILE:profile,CODE_AI_DESIGN_GEMINI_PROFILE:profile,CODE_AI_UX_GEMINI_PROFILE:profile},timeout:300000,maxBuffer:1024*1024});
    const lines=stdout.trim().split('\n');
    const marker=lines.find(l=>l.includes('GEMINI_SMOKE_OK'));
    let result;
    if(script==='argon-cli-smoke.mjs'){
      result=JSON.parse(lines.find(l=>l.startsWith('{')&&l.includes('selectedModel'))||'{}');
      assert.equal(result.selectedModel,'gemini-4-argon');assert.ok(result.results?.every(v=>v.passed&&v.actualModel==='gemini-4-argon'));
    }else assert.ok(marker?.includes('model=gemini-4-argon'));
    checks.push({profile,script,passed:true,model:'gemini-4-argon',...(result?{reasoningLevels:result.results.map(v=>v.effort)}:{})});
  }catch(error){
    const stderr=String(error.stderr||'');
    const safeCodes=[...new Set(stderr.match(/ERR_[A-Z_]+|ENOENT|EACCES|Dynamic require of|Cannot find package|Cannot find module/g)||[])];
    const safeLocations=stderr.split('\n').filter(l=>/^\s*at .*\.(?:mjs|js|ts):\d+:\d+/.test(l)).slice(0,3);
    const safeMessage=(stderr.match(/(?:Error|AssertionError[^:]*): ([^\n]+)/)?.[1]||'').replace(/[A-Za-z0-9_-]{32,}/g,'[REDACTED]').replace(/https?:\/\/\S+/g,'[REDACTED_URL]');
    checks.push({profile,script,passed:false,errorClass:error.name,errorCode:typeof error.code==='number'?error.code:null,safeCodes,safeLocations,safeMessage});
  }
  await writeFile(ops+'/cli-verification.json',JSON.stringify({checkedAt:new Date().toISOString(),checks},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(checks.at(-1)));
}
if(checks.some(c=>!c.passed))process.exitCode=1;
