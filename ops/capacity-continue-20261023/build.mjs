import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const tests=['codexQueue.capacityContinuation.test.ts','codexQueue.recurrenceRecovery.test.ts','codexQueue.retry.test.ts',
 'codexQueue.persistence.test.ts','codexQueue.drafts.test.ts','codexQueue.cancellationRecovery.test.ts','codexQueue.stopSchedule.test.ts','codexQueueNotifications.test.ts'];
execFileSync(process.execPath,['--test','server/codexCapacityContinuation.test.mjs','server/codexQueueRecurrence.test.mjs',
 'server/codexSharedSubmission.test.mjs','server/codexNativeTurnOutcome.test.mjs'],{stdio:'inherit'});
await build({entryPoints:[...tests.map(f=>'server/'+f),'server/codexQueue.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outbase:'server',outdir:'qualification/tests'});
await build({entryPoints:['server/codexQueue.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:'qualification/queue-core.mjs'});
for(const file of tests) {
 const storage=await mkdtemp(path.join(os.tmpdir(),'code-ai-queue-stop-test-'));
 execFileSync(process.execPath,['--test','qualification/tests/'+file.replace(/\.ts$/,'.js')],{stdio:'inherit',
  env:{...process.env,CODEX_STORAGE_ROOT:storage,CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_NTFY_STATE_FILE:path.join(storage,'notifications.json')}});
}
await build({entryPoints:['server/index.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist/app.mjs',
 external:['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws']});
