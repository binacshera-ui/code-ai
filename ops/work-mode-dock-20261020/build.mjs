import {build}from'esbuild';import{execFileSync}from'node:child_process';import{createRequire}from'node:module';import path from'node:path';
if(process.argv[2]==='test'){
 const entries=['workModeUi.test.tsx','scopedPreferenceRequests.test.ts','workModeTransport.test.ts'].map(f=>'client/src/components/codex/'+f);
 await build({entryPoints:entries,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outdir:'.dock-tests'});
 execFileSync(process.execPath,['--test',...entries.map(f=>'.dock-tests/'+path.basename(f).replace(/\.tsx?$/,'.js'))],{stdio:'inherit'});
}else if(process.argv[2]==='build'){
 const require=createRequire(import.meta.url),vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js');
 execFileSync(process.execPath,[vite,'build'],{stdio:'inherit'});
}else throw Error('Expected test or build');
