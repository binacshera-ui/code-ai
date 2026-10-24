/** Reuse the EXACT qualified predecessor's dead-socket recovery under its flock.
 * Does not start native, remove locks/history or weaken custody checks.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const [mode,planFile,runnerHash,artifactsHash,planHash]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
try {
  for(const h of [runnerHash,artifactsHash,planHash])if(!/^[a-f0-9]{64}$/.test(h))throw Error('cleanup_pin_missing');
  const bytes=await fs.readFile(planFile);if(hash(bytes)!==planHash)throw Error('cleanup_plan_drift');
  const plan=JSON.parse(bytes),runner=await fs.readFile(plan.runnerModule,'utf8');
  if(hash(runner)!==runnerHash)throw Error('cleanup_runner_drift');
  const artifactFile=path.join(path.dirname(plan.runnerModule),'profile-artifacts.mjs'),artifacts=await fs.readFile(artifactFile,'utf8');
  if(hash(artifacts)!==artifactsHash)throw Error('cleanup_artifacts_drift');
  if(mode==='lock') {
    const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork',path.join(plan.ownerDirectory,'owner.lock'),process.execPath,new URL(import.meta.url).pathname,'locked',planFile,runnerHash,artifactsHash,planHash],{stdio:['ignore','pipe','pipe'],env:process.env});
    child.stdout.resume();child.stderr.resume();const code=await new Promise((y,x)=>{child.once('error',x);child.once('exit',y);});
    if(code!==0)throw Error('cleanup_lock_or_custody_refused');
  } else if(mode==='locked') {
    const boundary='\nconst lockHeld = process.argv[2]';if(runner.split(boundary).length!==2)throw Error('cleanup_runner_contract');
    let prefix=runner.slice(0,runner.indexOf(boundary));
    const wsImport="import WebSocket from 'ws';",artifactImport="import { nativeOwnerArguments, validateProfilePlan } from './profile-artifacts.mjs';";
    if(prefix.split(wsImport).length!==2||prefix.split(artifactImport).length!==2)throw Error('cleanup_import_contract');
    prefix=prefix.replace(wsImport,"import { createRequire } from 'node:module';\nconst WebSocket=createRequire("+JSON.stringify(pathToFileURL(plan.runnerModule).href)+")('ws');")
      .replace(artifactImport,'import {nativeOwnerArguments,validateProfilePlan} from '+JSON.stringify('data:text/javascript;base64,'+Buffer.from(artifacts).toString('base64'))+';');
    prefix+='\nexport async function cleanup(plan){validateProfilePlan(plan);await pinnedProgram(plan.nativeBinary,plan.nativeBinarySha256);await pinnedProgram(plan.brokerModule,plan.brokerModuleSha256);await fileIdentity('+JSON.stringify(planFile)+');await proveHeldLock(path.join(plan.ownerDirectory,"owner.lock"));await recoverRecordedSockets(plan,path.join(plan.ownerDirectory,"engine.sock"));}\n';
    const qualified=await import('data:text/javascript;base64,'+Buffer.from(prefix).toString('base64'));await qualified.cleanup(plan);
  } else throw Error('cleanup_mode');
  console.log(JSON.stringify({predecessorRecoveryVerified:true,nativeStarted:false,lockDeleted:false,historiesChanged:false}));
} catch {process.stderr.write('CODE_AI_PREDECESSOR_CLEANUP_REFUSED\n');process.exitCode=1;}
