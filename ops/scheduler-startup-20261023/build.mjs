import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
const tests=['codexQueue.recurrenceRecovery.test.ts','codexQueue.retry.test.ts','codexQueue.persistence.test.ts',
 'codexQueue.drafts.test.ts','codexQueue.cancellationRecovery.test.ts','codexQueue.stopSchedule.test.ts','codexAppServer.test.ts'];
if(process.argv[2]==='backend') {
 execFileSync(process.execPath,['--test','server/codexQueueRecurrence.test.mjs','server/codexSharedSubmission.test.mjs'],{stdio:'inherit'});
 await build({entryPoints:tests.map(f=>'server/'+f),bundle:true,platform:'node',format:'esm',packages:'external',outdir:'qualification/tests'});
 execFileSync(process.execPath,['--test','--test-concurrency=1',...tests.map(f=>'qualification/tests/'+f.replace(/\.ts$/,'.js'))],{stdio:'inherit'});
 await build({entryPoints:['server/index.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist/app.mjs',
  external:['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws']});
} else if(process.argv[2]==='ui') {
 execFileSync(process.execPath,['--test','client/src/components/codex/startupLoading.test.mjs','client/src/themes/charcoal.test.mjs'],{stdio:'inherit'});
 const require=createRequire(import.meta.url);
 execFileSync(process.execPath,[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build'],{stdio:'inherit'});
} else throw Error('backend or ui required');
