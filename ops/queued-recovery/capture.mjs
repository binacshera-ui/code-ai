import assert from 'node:assert/strict';
import {cp,readFile,writeFile,mkdtemp,realpath,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='/root/projects/code-ai',dir=root+'/ops/queued-recovery';
const predecessor='/mnt/hdd/code-ai-builds/terminal-ux-source-ffYbFJ';
const baseline=await realpath(root+'/dist');
assert.equal(baseline,'/mnt/hdd/code-ai-builds/terminal-ux-live-5cdfa175-024d-4267-983b-59b3b8dedb5a/dist');
const stage=await mkdtemp('/mnt/hdd/code-ai-builds/queued-recovery-source-');
await cp(predecessor,stage,{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|dist|\.git|\.qualification|\.browser-tools|beam-[^/]*)(?:\/|$)/.test(p)});
const changed=['server/codexAppServer.ts','server/codexAppServer.test.ts','server/codexService.ts','server/codexQueuedRecovery.mjs','server/codexQueuedRecovery.test.mjs','server/codexSharedHistory.ts','server/codexSharedHistory.test.ts','shared/queueExecutionStatus.ts','shared/queueExecutionStatus.test.ts','client/src/components/codex/CodexMobileApp.tsx','client/src/components/codex/activeTasks.ts','client/src/components/codex/activeTasks.test.ts'];
for(const f of changed)await cp(root+'/'+f,stage+'/payload/'+f);
// codexService.ts has unrelated worktree edits: apply only this repair onto
// the accepted cumulative predecessor, preserving those edits in the worktree.
let service=await readFile(predecessor+'/payload/server/codexService.ts','utf8');
assert.ok(service.includes("import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';"));
service=service.replace("import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';", "import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';\nimport { recoverManagedQueuedSubmission } from './codexQueuedRecovery.mjs';");
assert.ok(service.includes('          onSubmissionChanged: options.onNativeSubmissionChanged,'));
service=service.replace('          onSubmissionChanged: options.onNativeSubmissionChanged,',`          onSubmissionChanged: options.onNativeSubmissionChanged,\n          recoverQueuedInput: async (threadId, queuedSubmissionId, clientUserMessageId) => recoverManagedQueuedSubmission({\n            codexHome: profile.codexHome, threadId, queuedSubmissionId, clientUserMessageId,\n            brokerModule: path.join(await fs.realpath(path.join(CODEX_APP_CONFIG.appRoot, 'dist')), '..', 'server', 'codexSharedOwnerBroker.mjs'),\n          }),`);
await writeFile(stage+'/payload/server/codexService.ts',service);
// Keep historical protocol qualification bound to its unchanged fixture.
// Qualify the new interrupted-input scenario under a distinct script identity.
await cp(root+'/scripts/codex-native-submit-contract.mjs',stage+'/payload/scripts/codex-native-queued-recovery-contract.mjs');
changed.push('scripts/codex-native-queued-recovery-contract.mjs');
await mkdir(stage+'/payload/ops/queued-recovery',{recursive:true});
let tests=await readFile(stage+'/test.mjs','utf8');
tests=tests.replace('const checks = [',`const checks = [\n  'server/codexSharedHistory.test.ts',\n  'shared/queueExecutionStatus.test.ts',`);
tests=tests.replace("'server/codexDeploymentDrain.test.mjs',", "'server/codexQueuedRecovery.test.mjs', 'server/codexDeploymentDrain.test.mjs',");
await writeFile(stage+'/test.mjs',tests);
let build=await readFile(stage+'/build.mjs','utf8');
build=build.replace("['codexSharedSocket.mjs','codexSharedOwnerBroker.mjs']", "['codexSharedSocket.mjs','codexSharedOwnerBroker.mjs','codexQueuedRecovery.mjs']");
build=build.replace("const files={};",`const recovery=JSON.parse(await readFile('payload/ops/queued-recovery/native-contract.json','utf8'));\nassert.equal(recovery.installedEffects,false);\nassert.ok(recovery.nativeRuns.length===2&&recovery.nativeRuns.every(r=>r.passed===22&&r.failed===0));\nfor(const [f,h]of Object.entries(recovery.sourceSha256))assert.equal(createHash('sha256').update(await readFile('payload/'+f)).digest('hex'),h);\nawait writeFile('dist/qualification/queued-recovery.json',JSON.stringify(recovery,null,2));\nconst files={};`);
await writeFile(stage+'/build.mjs',build);
const source={stage,predecessor,baseline:baseline.slice(0,-5),baselineBuildId:'5cdfa175-024d-4267-983b-59b3b8dedb5a',changed,capturedAt:new Date().toISOString(),clientKey:createHash('sha256').update(stage).digest('hex')};
await writeFile(dir+'/capture.json',JSON.stringify(source,null,2),{mode:0o600});
console.log(JSON.stringify(source));
