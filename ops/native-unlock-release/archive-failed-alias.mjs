/** Archive only this transaction's stopped, unrecorded BEAM endpoint. Never remove native targets. */
import assert from 'node:assert/strict';
import {readFile,lstat,readlink,realpath,rename,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
const [requestFile]=process.argv.slice(2);
const r=JSON.parse(await readFile(requestFile,'utf8'));
assert.equal(r.id,'beam-10g');assert.equal(r.ownerUid,0);assert.equal(process.getuid(),0);
assert.equal(r.previousPartialOwnerBuildId,r.buildId);
const directory='/root/code-ai-native-owner',alias=directory+'/engine.sock';
const run=args=>execFileSync('/usr/bin/systemctl',args,{encoding:'utf8',stdio:'pipe',timeout:10000}).trim();
assert.ok(['inactive','failed'].includes(run(['show','code-ai-native-owner-beam-root.service','-p','ActiveState','--value'])));
assert.equal(run(['show','code-ai-native-owner-beam-root.service','-p','MainPID','--value']),'0');
const pid=Number(run(['show','code-ai-remote-beam-10g.service','-p','MainPID','--value']));assert.ok(pid>1);
const env=(await readFile('/proc/'+pid+'/environ','utf8')).split('\0');
assert.ok(!env.some(s=>s.startsWith('CODE_AI_CODEX_SHARED_OWNER_PROFILES=')&&s!=='CODE_AI_CODEX_SHARED_OWNER_PROFILES='));
for(const f of ['ownership.json','ready.json'])assert.equal(await lstat(directory+'/'+f).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
const dir=await lstat(directory);assert.ok(dir.isDirectory()&&!dir.isSymbolicLink()&&dir.uid===0&&(dir.mode&0o077)===0);
const entry=await lstat(alias);assert.ok(entry.isSymbolicLink()&&entry.uid===0);
const target=path.resolve(directory,await readlink(alias));assert.equal(path.dirname(target),'/tmp/codex-daemon-0');assert.match(path.basename(target),/^[a-f0-9]{64}$/);
const targetEntry=await lstat(target),parent=await lstat(path.dirname(target));
assert.ok(targetEntry.isSocket()&&targetEntry.uid===0&&parent.isDirectory()&&parent.uid===0&&(parent.mode&0o077)===0);
assert.equal(await realpath(path.dirname(target)),path.dirname(target));
const kernel=await readFile('/proc/net/unix','utf8');assert.ok(!kernel.split('\n').some(line=>line.trim().endsWith(' '+target)));
const WebSocket=createRequire(r.candidate+'/package.json')('ws');
const gone=await new Promise(resolve=>{const ws=new WebSocket('ws+unix://'+alias+':/',{handshakeTimeout:1000});let done=false;const finish=v=>{if(done)return;done=true;ws.terminate();resolve(v)};ws.once('open',()=>finish(false));ws.on('error',e=>finish(e.code==='ECONNREFUSED'));});assert.equal(gone,true);
const now=await lstat(alias);assert.equal(now.dev,entry.dev);assert.equal(now.ino,entry.ino);assert.equal(now.uid,entry.uid);assert.equal(await realpath(alias),target);
const archive=directory+'/failed-backend-alias-before-controller-'+r.ownerControllerBuildId;
assert.equal(await lstat(archive).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),false);
await rename(alias,archive);
const preserved=await lstat(target);assert.equal(preserved.dev,targetEntry.dev);assert.equal(preserved.ino,targetEntry.ino);
const receipt={format:'code-ai-failed-owner-alias-archive',version:1,buildId:r.buildId,controllerBuildId:r.ownerControllerBuildId,
  failedOwnerStopped:true,oldCoreSharedFlagOff:true,unrecordedDeadAliasArchived:true,nativeTargetAndLockInodesPreserved:true,
  archive,recoverable:true,credentialRotation:false,observedAt:new Date().toISOString()};
await writeFile(directory+'/failed-alias-archive-receipt-'+r.ownerControllerBuildId+'.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify(receipt));
