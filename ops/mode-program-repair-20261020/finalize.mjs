import fs from 'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const out='/root/projects/code-ai/ops/mode-program-repair-20261020';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const prepared=await read(out+'/prepared.json'),root=prepared.candidate;
assert.equal(path.dirname(await fs.realpath('/root/projects/code-ai/dist')),root);
const acceptance=await read(out+'/acceptance.json'),external=await read(out+'/external.json'),audit=await read(out+'/final-audit.json');
assert.equal(acceptance.passed,true);assert.equal(external.passed,true);assert.equal(audit.integrity.mismatches.length,0);assert.ok(audit.programs.length===9&&audit.programs.every(p=>p.insideRelease&&!p.error));
const activation=await read(root+'/activation-receipt.json');assert.equal(activation.installed,true);
const pm=JSON.parse(execFileSync('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist'],{encoding:'utf8'})).find(p=>p.name==='code-ai-app');assert.equal(pm.pm2_env.CODE_AI_PM2_TARGET_MODULE,root+'/dist/server.js');assert.equal(pm.pm2_env.status,'online');
const services=[];
for(const unit of ['code-ai-upload-api.service','code-ai-native-owner-developer.service','code-ai-native-owner-developer2.service']){
 const active=execFileSync('systemctl',['is-active',unit],{encoding:'utf8'}).trim();assert.equal(active,'active');
 const pid=Number(execFileSync('systemctl',['show',unit,'-p','MainPID','--value'],{encoding:'utf8'}).trim());const args=await fs.readFile('/proc/'+pid+'/cmdline','utf8');
 const row={unit,active,pid};if(unit==='code-ai-upload-api.service'){row.actualTargetMatches=args.split('\0').includes(root+'/dist/server.js');assert.ok(row.actualTargetMatches);}services.push(row);
}
const owners=[];
for(const p of ['developer','developer2']){
 const custody=await read('/home/'+p+'/code-ai-native-owner/ownership.json');const binary=await fs.realpath('/proc/'+custody.nativePid+'/exe');
 const version=execFileSync(binary,['--version'],{encoding:'utf8',timeout:10000}).trim();const hash=createHash('sha256').update(await fs.readFile(binary)).digest('hex');
 assert.equal(version,'codex-cli 0.163.0');assert.equal(hash,custody.nativeBinarySha256);
 owners.push({profile:p,nativePid:custody.nativePid,binary,version,binarySha256:hash});
}
const queue=await read('/root/projects/code-ai/.code-ai/queue/state.json');const errors=queue.items.filter(i=>String(i.error).includes('MODE_PROGRAM_UNAVAILABLE'));
const newErrors=errors.filter(i=>Date.parse(i.updatedAt)>=Date.parse(activation.finishedAt));assert.equal(newErrors.length,0);
const report={format:'code-ai-mode-runtime-repair',scope:'Germany main only',completedAt:new Date().toISOString(),passed:true,
 release:path.basename(root),root,buildId:activation.buildId,sourceSha256:prepared.sourceSha256,
 identityScheme:'Runtime repack identity: preceding qualified application identity plus build copier/verifier SHA256 and preflight version; unchanged application and frontend bundles retained',
 rootCause:'The scheduled work-modes release omitted dist/codex-shared-stdio.mjs. The shared transport resolves this required program before submitting native input; runtime program presence was not checked by its activation preflight.',
 scheduledRelease:{release:path.basename(prepared.baseline),activationReceipt:prepared.baseline+'/handoff-receipt.json',newFeaturesRetained:true},
 fixes:['Normal npm build bundles and ships the canonical stdio adapter with its source dependencies','Runtime sibling modules are included by the normal build copier','Normal build and release activation preflight verify all 9 runtime programs and all 5 tool catalogs','Existing memory, authentication, work modes, focused execution and incident decision features retained'],
 qualification:{...await read(root+'/qualification/mode-runtime.json'),artifactFilesVerified:audit.integrity.files,artifactMismatches:0,unitRegressionTests:{passed:14,failed:0,scope:['canonical stdio isolation and ownership','runtime selection','bounded conversation reads and retained memory']},negativeMissingAdapterRegression:await read(out+'/missing-adapter-regression.json')},
 activation,app:{pid:pm.pid,status:pm.pm2_env.status,target:pm.pm2_env.CODE_AI_PM2_TARGET_MODULE},services,owners,
 acceptance,external,postActivationModeProgramErrors:0,
 previousFailedRequests:{count:errors.length,ids:errors.map(i=>i.id),preserved:true,automaticallyReplayed:false},
 preservation:{noCredentialRotation:true,permissionsNotChanged:true,windowsUntouched:true,gpuDataAndOtherProjectsUntouched:true,conversationsAndScheduledWorkPreserved:true,nativeOwnersNotRestarted:true,noRunningWorkInterruptedByThisDeployment:activation.queueBefore.running===0&&activation.queueBefore.cancelling===0},
 limitations:['No visual browser acceptance on the live deployment; public HTTPS, real session reads, actual native queue and command execution verified','Physical phone notifications and external mode devices were not exercised','Historical failed requests remain recorded; their project work was not automatically replayed','This runtime repack reuses the qualified preceding application bundle; no new all-repository TypeScript pass or signed remote build is claimed']};
await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2),{mode:0o600});await fs.writeFile(out+'/state.json',JSON.stringify({phase:'complete',completedAt:report.completedAt,release:root,report:out+'/report.json',passed:true},null,2),{mode:0o600});
console.log(JSON.stringify({passed:true,release:report.release,completedAt:report.completedAt,actualNativeVersion:owners[0].version,artifactFiles:audit.integrity.files,realNativeRuns:acceptance.runs.length,publicHttpsPassed:external.passed,postActivationModeProgramErrors:0,previousFailedRequests:errors.length,services}));
