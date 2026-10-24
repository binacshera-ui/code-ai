import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';import {spawn,execFileSync} from 'node:child_process';
const root='/root/projects/code-ai',ops=root+'/ops/capacity-continue-20261023';
const json=async p=>JSON.parse(await fs.readFile(p,'utf8')),hash=b=>createHash('sha256').update(b).digest('hex'),digest=async p=>hash(await fs.readFile(p));
const save=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const changed=['server/codexQueue.ts','server/codexCapacityContinuation.mjs','server/codexCapacityContinuation.test.mjs','server/codexQueue.capacityContinuation.test.ts'];
async function tree(dir,rel=''){const out={};for(const e of await fs.readdir(dir+'/'+rel,{withFileTypes:true})){const n=path.join(rel,e.name);if(e.isDirectory())Object.assign(out,await tree(dir,n));else{assert.ok(e.isFile());out[n]=await digest(dir+'/'+n);}}return out;}
async function own(dir){await fs.chown(dir,65534,65534);await fs.chmod(dir,0o755);for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await own(p);else{assert.ok(e.isFile());await fs.chown(p,65534,65534);await fs.chmod(p,0o644);}}}
const baseline=path.dirname(await fs.realpath(root+'/dist')),uiPointer=await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf');
const previous=await json(baseline+'/release-files.json');
const resume=process.argv[2]==='resume';if(!resume&&process.argv[2]!=='build')throw Error('build or resume required');
const prior=resume?await json(ops+'/staged.json'):null;
if(prior){assert.equal(prior.passed,false);assert.equal(prior.baseline,baseline);assert.equal(prior.uiPointer,uiPointer);}
const candidate=resume?prior.candidate:await fs.mkdtemp('/mnt/hdd/code-ai-builds/capacity-api-20261023-');
const buildId=prior?.buildId||randomUUID();await save(ops+'/staged.json',{passed:false,buildId,baseline,candidate,uiPointer,changed,startedAt:new Date().toISOString()});
if(!resume){
const entries=Object.entries(previous.files);
for(let n=0;n<entries.length;n+=8)await Promise.all(entries.slice(n,n+8).map(async([f,d])=>{
 assert.equal(await digest(baseline+'/'+f),d,'Accepted source changed');await fs.mkdir(path.dirname(candidate+'/'+f),{recursive:true});await fs.copyFile(baseline+'/'+f,candidate+'/'+f);
}));
for(const f of changed){await fs.mkdir(path.dirname(candidate+'/'+f),{recursive:true});await fs.copyFile(root+'/'+f,candidate+'/'+f);}
for(const f of ['server/codexQueueNotifications.test.ts','server/codexNativeTurnOutcome.test.mjs']){
 if(await fs.access(candidate+'/'+f).then(()=>false,()=>true))await fs.copyFile(root+'/'+f,candidate+'/'+f);
}
await fs.copyFile(ops+'/build.mjs',candidate+'/build-capacity.mjs');
await own(candidate);await fs.mkdir(candidate+'/node_modules');await fs.chown(candidate+'/node_modules',65534,65534);
for(const n of await fs.readdir(root+'/node_modules'))if(!['.vite','.vite-temp','.cache','systeminformation'].includes(n))await fs.symlink(root+'/node_modules/'+n,candidate+'/node_modules/'+n);
await fs.symlink(candidate+'/.deps/systeminformation',candidate+'/node_modules/systeminformation');
}else{
 for(const f of changed)assert.equal(await digest(root+'/'+f),await digest(candidate+'/'+f),'Product source changed during fixture correction');
 await fs.copyFile(ops+'/build.mjs',candidate+'/build-capacity.mjs');await fs.chown(candidate+'/build-capacity.mjs',65534,65534);
}
await fs.chown(candidate+'/qualification',65534,65534);
const log=await fs.open(candidate+'/qualification/'+(resume?'capacity-resume':'capacity-build')+'.log','wx',0o600);
const child=spawn('/usr/sbin/runuser',['-u','nobody','--',process.execPath,'build-capacity.mjs'],{cwd:candidate,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',TMPDIR:candidate+'/qualification',NODE_OPTIONS:'--max-old-space-size=4096'},stdio:['ignore',log.fd,log.fd]});
const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});await log.close();assert.equal(code,0,'Qualification failed: '+candidate+'/qualification/capacity-build.log');
const release=await json(candidate+'/release.json');Object.assign(release,{version:path.basename(candidate),buildId,builtAt:new Date().toISOString(),builder:'user-server',beamAttested:false});await save(candidate+'/release.json',release);
const extra=['build-capacity.mjs',...changed,'server/codexQueueNotifications.test.ts','server/codexNativeTurnOutcome.test.mjs',...Object.keys(await tree(candidate+'/qualification')).map(f=>'qualification/'+f)];
const files=Object.fromEntries(await Promise.all([...new Set([...Object.keys(previous.files),...extra])].map(async f=>[f,await digest(candidate+'/'+f)])));
await save(candidate+'/release-files.json',{format:'code-ai-release-files',version:1,files});
const request=await json(baseline+'/fleet-request.json');Object.assign(request,{candidate,baseline,buildId,releaseOrder:String(Date.now()),attemptId:'capacity-'+randomUUID(),ownerAuthorizedInterruption:true,
 expectedBaselineSha256:await digest(baseline+'/dist/server.js'),expectedServerSha256:files['dist/server.js'],expectedAppSha256:files['dist/app.mjs'],uploadBaselineModule:baseline+'/dist/server.js',uploadBaselineSha256:await digest(baseline+'/dist/server.js')});
delete request.featureEnvironmentFile;await save(candidate+'/fleet-request.json',request);
const preflight=JSON.parse(execFileSync(request.nodeExecutable,[candidate+'/install.mjs','preflight',candidate+'/fleet-request.json'],{cwd:candidate,encoding:'utf8',timeout:120000}));assert.equal(preflight.prepared,true);
assert.equal(await fs.realpath(root+'/dist'),baseline+'/dist');assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'),uiPointer);
await save(ops+'/staged.json',{passed:true,baseline,candidate,uiPointer,changed,buildId,request,preflight,builtAt:new Date().toISOString()});
console.log(JSON.stringify({passed:true,frontendUnchanged:true,candidate,buildId}));
