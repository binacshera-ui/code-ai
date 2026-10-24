import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
process.env.CODEX_DEVICE_ADMIN_PASSWORD='argon-isolated-test-device';
process.env.SESSION_SECRET='argon-isolated-test-signing';
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:'payload',stdio:'inherit'});
const require=createRequire(path.resolve('payload/package.json'));
const {build}=require('esbuild');
await mkdir('payload/.qualification',{recursive:true});
const modules=['server/geminiModelPolicy.test.ts','server/geminiProcessEnv.test.ts','server/geminiDesignModelSelection.test.ts','server/codexUxMode.test.ts'];
const checks=[];
for(const file of modules){
  const outfile=path.resolve('payload/.qualification',file.replaceAll('/','-').replace(/\.ts$/,'.mjs'));
  await build({absWorkingDir:path.resolve('payload'),entryPoints:[file],outfile,bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});
  const testRoot=path.resolve('payload/.qualification/state-'+checks.length);
  execFileSync(process.execPath,['--test',outfile],{cwd:'payload',stdio:'inherit',timeout:120000,env:{...process.env,CODEX_APP_ROOT:path.resolve('payload'),CODEX_STORAGE_ROOT:testRoot}});
  checks.push({module:file,passed:true});
}
await writeFile('gemini-argon-tests.json',JSON.stringify({checks,installedEffects:false,realProviderCalls:0},null,2)+'\n');
