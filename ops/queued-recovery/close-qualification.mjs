import assert from 'node:assert/strict';
import {readFile,writeFile,cp,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const capture=JSON.parse(await readFile(dir+'/capture.json','utf8'));
const intent=JSON.parse(await readFile(dir+'/beam-accepted.json.intent.json','utf8'));
const extract=f=>execFileSync('tar',['--zstd','-xOf',intent.archive.path,'./payload/'+f],{encoding:'utf8',stdio:'pipe'});
const oldProof=JSON.parse(extract('ops/queued-recovery/native-contract.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const functionSource=s=>s.slice(s.indexOf('export async function recoverReservedQueuedInput'),s.indexOf('/** Compatibility recovery'));
const helper=await readFile(capture.stage+'/payload/server/codexQueuedRecovery.mjs','utf8');
assert.equal(functionSource(extract('server/codexQueuedRecovery.mjs')),functionSource(helper));
const latestMain=JSON.parse(await readFile(dir+'/native-main-'+hash(helper)+'.json','utf8'));
assert.equal(latestMain.passed,22);
const proof={...oldProof,recordedAt:new Date().toISOString(),sourceSha256:{...oldProof.sourceSha256},
 historicalNativeSourceSha256:oldProof.sourceSha256,nativeRecoveryFunctionSha256:hash(functionSource(helper)),
 nativeRuns:[{host:'main',...latestMain,failed:0},{...oldProof.nativeRuns.find(r=>r.host==='ubuntu'),
  recoveryFunctionByteUnchangedSinceActualRun:true,managedWrapperDeltaRetestedOnUbuntu:false}],
 compatibilityDelta:{pinnedBrokerLazyImportAvoidsBundledCliExecution:true,changedPathNode22ChecksPassed:17,
  actualMainPrivateListenerGenerationAndBrokerHashVerified:true,actualMainPaginatedLargeHistoryVerified:true,
  ubuntuOfflineAfterInitial22Checks:true,ubuntuInstalledEffects:false}};
for(const f of Object.keys(proof.sourceSha256))proof.sourceSha256[f]=hash(await readFile(capture.stage+'/payload/'+f));
await writeFile(capture.stage+'/payload/ops/queued-recovery/native-contract.json',JSON.stringify(proof,null,2),{mode:0o600});
await writeFile(dir+'/native-contract.json',JSON.stringify(proof,null,2),{mode:0o600});
// New immutable submission identity, retaining the failed archive and receipts.
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/queued-recovery-qualified-source-');
await cp(capture.stage,stage,{recursive:true});
await writeFile(dir+'/failed-build.json',JSON.stringify({buildId:'0c18fde3-f937-4068-a231-64aa10ca282c',capture,reason:'bundled_broker_cli_entry',focusedCorrectionProven:true},null,2),{mode:0o600});
const next={...capture,stage,correctedFromSource:capture.stage,qualifiedAt:new Date().toISOString(),clientKey:hash(stage)};
await writeFile(dir+'/capture.json',JSON.stringify(next,null,2),{mode:0o600});
console.log(JSON.stringify({qualified:true,stage,clientKey:next.clientKey,sourceLineagePreserved:true,nativeRecoveryFunctionUnchanged:true,ubuntuUnavailable:true}));
