import{build}from'esbuild';import{execFileSync}from'node:child_process';
if(process.argv[2]==='test'){
 await build({entryPoints:['client/src/components/codex/workModeUi.test.tsx','client/src/components/codex/scopedPreferenceRequests.test.ts','client/src/components/codex/workModeTransport.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outdir:'.ui-tests'});
 execFileSync(process.execPath,['--test','.ui-tests/workModeUi.test.js','.ui-tests/scopedPreferenceRequests.test.js','.ui-tests/workModeTransport.test.js'],{stdio:'inherit'});
}else if(process.argv[2]==='build')execFileSync('pnpm',['exec','vite','build'],{stdio:'inherit'});
else throw Error('Expected test or build');
