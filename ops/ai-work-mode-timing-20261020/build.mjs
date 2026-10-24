import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const tests=['server/codexRationalMode.test.ts','server/codexWorkModeRoutes.test.ts',
 'client/src/components/codex/workModeUi.test.tsx','client/src/components/codex/scopedPreferenceRequests.test.ts',
 'client/src/components/codex/workModeTransport.test.ts'];
if(process.argv[2]==='test'){
 await build({entryPoints:tests,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outbase:'.',outdir:'.timing-tests'});
 for(const test of tests)execFileSync(process.execPath,['--test','.timing-tests/'+test.replace(/\.tsx?$/,'.js')],{stdio:'inherit',env:{...process.env,CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_STORAGE_ROOT:path.resolve('.test-state')}});
 execFileSync(process.execPath,['--test','server/codexRuntimePrograms.test.mjs'],{stdio:'inherit'});
}else if(process.argv[2]==='build'){
 await fs.mkdir('dist',{recursive:true});
 await build({entryPoints:['server/index.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist/app.mjs',external:['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws']});
 await import('./scripts/copy-personal-chrome-runtime.mjs');
 execFileSync('pnpm',['exec','vite','build'],{stdio:'inherit'});
}else throw Error('Expected test or build');
