import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
process.env.CODEX_DEVICE_ADMIN_PASSWORD='isolated-rpc-repair-test-device';process.env.SESSION_SECRET='isolated-rpc-repair-test-signing';
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:'payload',stdio:'inherit'});
const {build}=createRequire(path.resolve('payload/package.json'))('esbuild');
await mkdir('payload/.qualification',{recursive:true});const checks=[];
const mjs=['server/codexRpcDiagnostic.test.mjs','server/codexSharedOwnerBroker.test.mjs','server/codexRecoveryBroker.test.mjs','ops/native-owner/profile-runner.test.mjs'];
execFileSync(process.execPath,['--test',...mjs],{cwd:'payload',stdio:'inherit',timeout:120000});for(const file of mjs)checks.push({module:file,passed:true});
for(const file of ['server/codexAppServer.test.ts','server/codexSharedHistory.test.ts','server/codexUserInput.test.ts']){
  const outfile=path.resolve('payload/.qualification/'+file.replaceAll('/','-').replace(/\.ts$/,'.mjs'));
  await build({absWorkingDir:path.resolve('payload'),entryPoints:[file],outfile,bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',logLevel:'warning'});
  execFileSync(process.execPath,['--test',outfile],{cwd:'payload',stdio:'inherit',timeout:120000,env:{...process.env,CODEX_APP_ROOT:path.resolve('payload'),CODEX_STORAGE_ROOT:path.resolve('payload/.qualification/state')}});
  checks.push({module:file,passed:true});
}
await writeFile('rpc-repair-tests.json',JSON.stringify({checks,installedEffects:false,realProviderCalls:0},null,2));
