import fs from'node:fs/promises';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{createHash}from'node:crypto';
const ops=process.argv[3]||'/root/projects/code-ai/ops/work-modes-ui-20261020',release=process.argv[2]||'/var/www/code-ai-ui/releases/e7723dc9dd48';
const manifest=JSON.parse(await fs.readFile(release+'/manifest.json','utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
const scratch=await fs.mkdtemp('/mnt/hdd/code-ai-builds/code-ai-ui-static-check-');
await fs.chmod(scratch,0o755);
const configuration=`user www-data;\npid ${scratch}/nginx.pid;\nerror_log ${scratch}/error.log;\nevents {}\nhttp { include /etc/nginx/mime.types; access_log off; server { listen 127.0.0.1:47983; include ${release}/locations.conf; location / { proxy_pass http://127.0.0.1:4000; } } }\n`;
await fs.writeFile(scratch+'/nginx.conf',configuration,{mode:0o644});
const proc=spawn('nginx',['-p',scratch,'-c',scratch+'/nginx.conf','-g','daemon off;'],{stdio:'ignore'});
const exited=new Promise(resolve=>proc.once('exit',resolve));let finished=false;proc.once('exit',()=>{finished=true;});
const checks=[];
try{
 const origin='http://127.0.0.1:47983';let ready=false;
 for(let i=0;i<30;i++){if(finished)throw Error('Isolated static worker exited');try{const r=await fetch(origin+'/');ready=r.status===200;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Isolated worker readiness');
 for(const route of['/','/index.html','/session/developer/test?server=local','/chat','/workbench']){const r=await fetch(origin+route);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),manifest.files['index.html']);assert.ok(r.headers.get('cache-control').includes('no-store'));checks.push({route,status:200,hash:true});}
 for(const [file,digest]of Object.entries(manifest.files).filter(([file])=>file.startsWith('assets/'))){const r=await fetch(origin+'/'+file);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),digest);if(file.endsWith('.js'))assert.ok(r.headers.get('content-type').includes('javascript'));if(file.endsWith('.css'))assert.ok(r.headers.get('content-type').includes('text/css'));}
 const missing=await fetch(origin+'/assets/does-not-exist.js');assert.equal(missing.status,404);assert.notEqual(hash(Buffer.from(await missing.arrayBuffer())),manifest.files['index.html']);
 const api=await fetch(origin+'/api/auth/check-session');assert.equal(api.status,200);assert.ok(api.headers.get('content-type').includes('application/json'));await api.json();
 const worker=await fetch(origin+'/sw.js');assert.equal(worker.headers.get('service-worker-allowed'),'/');assert.ok(worker.headers.get('cache-control').includes('no-store'));
 const result={passed:true,sourceSha256:manifest.sourceSha256,locationsSha256:hash(await fs.readFile(release+'/locations.conf')),isolatedLoopbackOnly:true,workerUser:'www-data',allPublicAssetHashesVerified:true,shellRoutes:checks,missingAssets404:true,apiProxyJson:true,workerScopePreserved:true,scratch,at:new Date().toISOString()};
 await fs.writeFile(ops+'/static-preflight.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}finally{if(!finished){proc.kill('SIGQUIT');await exited;}}
