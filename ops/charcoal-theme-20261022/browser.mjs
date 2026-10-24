import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const root = '/root/projects/code-ai', ops = root + '/ops/charcoal-theme-20261022';
const c = JSON.parse(await fs.readFile(ops + '/capture.json', 'utf8'));
let nginx, exit;
const preview = process.argv[2] === 'preview';
const origin = preview ? 'http://127.0.0.1:47985' : 'https://app-codex.bina-cshera.co.il';
try {
  if (preview) {
    const dir = await fs.mkdtemp('/mnt/hdd/code-ai-builds/charcoal-browser-preview-'); await fs.chmod(dir,0o755);
    const release = c.staticReleaseRoot + '/' + c.sourceSha256.slice(0,12);
    await fs.writeFile(dir + '/nginx.conf', `user www-data;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents {}\nhttp {include /etc/nginx/mime.types;access_log off;server {listen 127.0.0.1:47985;include ${release}/locations.conf;location / {proxy_pass http://127.0.0.1:4000;}}}\n`);
    nginx = spawn('/usr/sbin/nginx',['-p',dir,'-c',dir+'/nginx.conf','-g','daemon off;'],{stdio:'ignore'});
    exit = new Promise(resolve=>nginx.on('exit',resolve));
    let ready=false;for(let i=0;i<30;i++){try{if((await fetch(origin+'/')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  }
  const baseline = path.dirname(await fs.realpath(root + '/dist'));
  const request = JSON.parse(await fs.readFile(baseline + '/fleet-request.json', 'utf8'));
  const { preserveRuntimeAuthentication } = await import(pathToFileURL(baseline + '/runtime-auth.mjs'));
  const env = { CODE_AI_AUTH_BASELINE_MODULE: request.authenticationBaselineModule, CODE_AI_AUTH_BASELINE_SHA256: request.authenticationBaselineSha256 };
  await preserveRuntimeAuthentication(env);
  const response = await fetch(origin + '/api/codex/device-unlock', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ password:env.CODEX_DEVICE_ADMIN_PASSWORD }),signal:AbortSignal.timeout(15000) });
  assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.ok(cookie);
  const child=spawn(root+'/.venv/bin/python',[ops+'/browser.py'],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CODE_AI_THEME_TEST_ORIGIN:origin,CODE_AI_THEME_TEST_COOKIE:cookie},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  if(code!==0){console.error(err.slice(-5000));throw Error('Theme browser qualification failed');}
  const receipt=JSON.parse(out.trim());assert.equal(receipt.passed,true);
  await fs.writeFile(ops+'/'+(preview?'preview-browser':'live-browser')+'.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
} finally {if(nginx){nginx.kill('SIGQUIT');await exit;}}
