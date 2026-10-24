import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';
const release=path.dirname(await fs.realpath('/root/projects/code-ai/dist'));
const req=JSON.parse(await fs.readFile(release+'/fleet-request.json','utf8'));
const{preserveRuntimeAuthentication}=await import(release+'/runtime-auth.mjs');
const env={CODE_AI_AUTH_BASELINE_MODULE:req.authenticationBaselineModule,CODE_AI_AUTH_BASELINE_SHA256:req.authenticationBaselineSha256};await preserveRuntimeAuthentication(env);
const r=await fetch('https://app-codex.bina-cshera.co.il/api/codex/device-unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:env.CODEX_DEVICE_ADMIN_PASSWORD})});assert.equal(r.status,200);
const artifactRoot='/root/projects/code-ai/.code-ai/reports/work-modes-live-20261020';await fs.mkdir(artifactRoot,{recursive:true,mode:0o700});
const output=execFileSync('/root/projects/code-ai/.venv/bin/python',['ops/focus-notifications-20261020/live-modes-browser.py'],{input:JSON.stringify({origin:'https://app-codex.bina-cshera.co.il',cookies:r.headers.getSetCookie().map(v=>v.split(';')[0]),artifactRoot}),encoding:'utf8',timeout:75000});
const result=JSON.parse(output);assert.equal(result.ok,true);await fs.writeFile(artifactRoot+'/browser-receipt.json',JSON.stringify({...result,release:path.basename(release),checkedAt:new Date().toISOString()},null,2),{mode:0o600});console.log(output);
