/** Durable, bounded same-intent recovery. Never opens BEAM intake or bypasses
 * qualification. All diagnostics are metadata only; native work is preserved. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resumeRelease} from './resume-contract.mjs';
const dir='/root/projects/code-ai/ops/native-large-frames';
const plan=JSON.parse(await fs.readFile(dir+'/automatic-release-plan.json','utf8'));
const stateFile=dir+'/automatic-release-status.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const[f,h]of Object.entries(plan.files))assert.equal(hash(await fs.readFile(dir+'/'+f)),h);
assert.equal(hash(await fs.readFile(dir+'/beam-accepted.json.intent.json')),plan.intentFileSha256);
const sleep=ms=>new Promise(y=>setTimeout(y,ms));let current;
const save=async(phase,extra={})=>{current={format:'code-ai-native-large-frames-automatic-release',version:1,phase,observedAt:new Date().toISOString(),clientKey:plan.clientKey,
 credentialRotation:false,inputsResent:false,...extra};await fs.writeFile(stateFile+'.tmp',JSON.stringify(current,null,2),{mode:0o600});await fs.rename(stateFile+'.tmp',stateFile);};
const read=async f=>JSON.parse(await fs.readFile(dir+'/'+f,'utf8'));
function run(exe,args){return new Promise((resolve,reject)=>{
 const p=spawn(exe,args,{cwd:'/root/projects/code-ai',env:{...process.env,PM2_HOME:'/root/.pm2'},stdio:['ignore','pipe','pipe']});
 let bytes=0;const digest=createHash('sha256');for(const s of[p.stdout,p.stderr])s.on('data',b=>{bytes+=b.length;digest.update(b);});
 const timer=setTimeout(()=>{p.kill('SIGTERM');reject(Error('release_command_timeout'));},35*60*1000);
 p.on('error',()=>{clearTimeout(timer);reject(Error('release_command_unavailable'));});
 p.on('close',code=>{clearTimeout(timer);const proof={phase:current.phase,exitCode:code,outputBytes:bytes,outputSha256:digest.digest('hex')};void fs.appendFile(dir+'/automatic-release-commands.jsonl',JSON.stringify(proof)+'\n',{mode:0o600}).then(()=>code===0?resolve():reject(Error('release_gate_failed')));});
 });}
const health=async()=>{const h=JSON.parse(execFileSync(plan.buildExecutable,['health'],{encoding:'utf8',stdio:'pipe',timeout:20000}));assert.equal(h.ok,true);
 assert.equal(h.profileDigests?.['node-package-v1'],plan.profileDigest);return h;};
try{
 const prior=await read('automatic-release-status.json').catch(e=>{if(e.code==='ENOENT')return{};throw e;});
 for(;;){
  const result=await resumeRelease({prior,health,save,
   build:async()=>{
    await run(plan.buildExecutable,plan.buildArguments);const accepted=await read('beam-accepted.json'),built=await read('beam-result.json');
    assert.equal(accepted.buildId,built.buildId);assert.equal(built.artifact,plan.importRoot+'/'+accepted.buildId+'/artifact');
   },
   stage:async()=>{try{await fs.access(dir+'/staged.json');}catch(e){if(e.code!=='ENOENT')throw e;await run(plan.nodeExecutable,[dir+'/stage.mjs']);}
    assert.equal((await read('staged.json')).buildId,(await read('beam-accepted.json')).buildId);},
   deploy:async()=>{const already=await read('final-receipt.json').catch(e=>{if(e.code==='ENOENT')return{};throw e;});if(already.complete){assert.equal(already.buildId,(await read('staged.json')).buildId);return;}
    assert.ok(!already.startedAt,'An interrupted deployment needs explicit reconciliation');await run(plan.nodeExecutable,[dir+'/deploy.mjs']);assert.equal((await read('final-receipt.json')).complete,true);},
   schedule:async()=>{await run(plan.nodeExecutable,[dir+'/schedule-owner-upgrades.mjs']);},
  });
  if(result.complete)break;await sleep(30000);
 }
}catch{
 await save('failed',{reason:'automatic_release_gate_failed',manualReconciliationRequired:true});process.exitCode=1;
}
