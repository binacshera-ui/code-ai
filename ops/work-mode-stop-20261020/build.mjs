import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
if (process.argv[2] === 'test') {
  const entries = ['workModeOwnerActions.test.ts', 'workModeUi.test.tsx', 'scopedPreferenceRequests.test.ts', 'workModeTransport.test.ts']
    .map(f => 'client/src/components/codex/' + f);
  await build({entryPoints:entries,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outdir:'.owner-stop-tests'});
  execFileSync(process.execPath,['--test',...entries.map(f => '.owner-stop-tests/' + path.basename(f).replace(/\.tsx?$/,'.js'))],{stdio:'inherit'});
} else if (process.argv[2] === 'build') {
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath,[path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js'),'build'],{stdio:'inherit'});
} else throw Error('Expected test or build');
