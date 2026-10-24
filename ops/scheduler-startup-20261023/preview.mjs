import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const ops='/root/projects/code-ai/ops/scheduler-startup-20261023';
const c=JSON.parse(await fs.readFile(ops+'/capture.json','utf8'));
const dir=await fs.mkdtemp('/mnt/hdd/code-ai-builds/startup-preview-');await fs.chmod(dir,0o755);
const origin='http://127.0.0.1:47985';
await fs.writeFile(dir+'/nginx.conf',`user www-data;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log;\nevents{}\nhttp{include /etc/nginx/mime.types;access_log off;server{listen 127.0.0.1:47985;include ${c.staticReleaseRoot}/${c.sourceSha256.slice(0,12)}/locations.conf;location /{proxy_pass http://127.0.0.1:4000;}}}\n`);
const nginx=spawn('/usr/sbin/nginx',['-p',dir,'-c',dir+'/nginx.conf','-g','daemon off;'],{stdio:'ignore'}),exit=new Promise(resolve=>nginx.once('exit',resolve));
try{
 let ready=false;for(let i=0;i<40;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const child=spawn(process.execPath,[ops+'/measure.mjs','preview'],{env:{...process.env,CODE_AI_PERF_ORIGIN:origin},stdio:'inherit'});
 assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0);
}finally{nginx.kill('SIGQUIT');await exit;}
