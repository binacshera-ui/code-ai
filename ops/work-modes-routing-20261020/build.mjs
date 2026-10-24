import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const external=['express','multer','cors','express-session','connect-pg-simple','pg','node-pty','ws'];
const tests=['server/codexWorkModeRoutes.test.ts','server/incidentRemoteGateway.test.ts','server/incidentRemoteWake.test.ts',
 'server/incidentDecisionCenter.test.ts','server/codexRationalMode.test.ts'];
if(process.argv[2]==='test'){
 await build({entryPoints:tests,bundle:true,platform:'node',format:'esm',packages:'external',outdir:'.qualification-tests'});
 for(const test of tests){execFileSync(process.execPath,['--test','.qualification-tests/'+path.basename(test).replace(/\.ts$/,'.js')],
  {stdio:'inherit',env:{...process.env,CODEX_QUEUE_DISABLE_EXECUTION:'1',CODEX_STORAGE_ROOT:path.resolve('.test-state')}});}
 execFileSync(process.execPath,['--test','server/codexRuntimePrograms.test.mjs'],{stdio:'inherit'});
}else if(process.argv[2]==='build'){
 await fs.mkdir('dist',{recursive:true});
 await build({entryPoints:['server/index.ts'],bundle:true,platform:'node',format:'esm',outfile:'dist/app.mjs',external});
 await import('./scripts/copy-personal-chrome-runtime.mjs');
}else throw Error('Expected test or build');
