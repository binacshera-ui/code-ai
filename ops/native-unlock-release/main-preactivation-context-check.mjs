/** Exact independent-unit preactivation context; only sanitized metadata is saved. */
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root='/root/projects/code-ai/ops/native-unlock-release';
const stage=JSON.parse(await readFile(root+'/staged-b6196953-8f40-4acb-a040-1b31a912bea6-aff5bbc8-e0a0-4d34-8bd1-a04f42a95036.json','utf8'));
const r=stage.targets.find(x=>x.id==='main');
const result={readOnly:true,installedEffects:false,interpreter:process.execPath,uid:process.getuid(),passed:false};
let phase='pm2-jlist';
try {
  const run=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:'pipe',timeout:240000}).trim();
  const raw=run('/root/.nvm/versions/node/v24.12.0/bin/pm2',['jlist']);result.pm2OutputStartsJson=raw.startsWith('[');result.pm2OutputBytes=Buffer.byteLength(raw);
  result.pm2Diagnostic={errorPrefix:raw.includes('[PM2][ERROR]'),warnPrefix:raw.includes('[PM2][WARN]'),permissionDenied:/permission|EACCES|EPERM/i.test(raw),
    daemonIssue:/daemon|rpc.sock|connect|ECONN/i.test(raw),interpreterVersion:/node|version|unsupported/i.test(raw),commandRefused:/not allowed|refused|guard|denied|blocked|maintenance|deployment/i.test(raw),
    rpcDiscoveryDenied:/RPC|discover/i.test(raw),commandMissing:/not found|unknown command/i.test(raw)};
  const m=JSON.parse(raw).find(x=>x.name==='code-ai-app');assert.ok(m?.pid>1&&m.pm2_env.status==='online');result.mainPid=m.pid;
  phase='authentication-preservation';
  const {parseRuntimeEnvironment,preserveRuntimeAuthentication}=await import(pathToFileURL(r.candidate+'/runtime-auth.mjs').href);
  const env={...m.pm2_env.env,...parseRuntimeEnvironment(await readFile('/proc/'+m.pid+'/environ')),
    CODE_AI_AUTH_BASELINE_MODULE:r.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:r.authenticationBaselineSha256};
  const preserved=await preserveRuntimeAuthentication(env);result.authenticationPreserved=preserved.preserved;
  phase='qualified-installer-preflight';
  const pre=JSON.parse(run(r.nodeExecutable,[r.candidate+'/install.mjs','preflight',r.requestFile]));assert.equal(pre.prepared,true);
  result.passed=true;
}catch(e){result.failure={phase,reason:/^[a-z_]{1,100}$/.test(e.reason||'')?e.reason:null,code:/^[A-Z_0-9]{1,40}$/.test(e.code||'')?e.code:null,
  childStatus:Number.isInteger(e.status)?e.status:null,errorClass:['SyntaxError','AssertionError','Error'].includes(e.name)?e.name:null,
  errno:Number.isInteger(e.errno)?e.errno:null};
  // Child output is inspected privately for fixed categories; no raw payload is saved.
  const err=e.stderr?.toString()||'';result.childDiagnostic={nodeUnavailable:/env:.*node.*No such file/.test(err),fileMissing:/ENOENT/.test(err),permissionDenied:/EACCES|Permission denied/.test(err),
    interpreterSyntaxFailure:/SyntaxError|Cannot find module|ERR_REQUIRE_ESM/.test(err)};
}
await writeFile(root+'/main-preactivation-context-check.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
