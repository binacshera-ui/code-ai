/** One qualified Codex distribution, including ordinary shell entry points. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';

const exec = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args) {
  const result = await exec(command, args, {timeout:30_000, maxBuffer:1024*1024});
  return result.stdout.trim();
}

export async function inspectEntrypoints(binary, entries) {
  const target = await fs.realpath(binary);
  return Promise.all(entries.map(async entry => {
    try {
      const stat = await fs.lstat(entry);
      assert(stat.isSymbolicLink(), `Refusing non-symlink entry point: ${entry}`);
      return {path:entry, previousTarget:await fs.readlink(entry),
        correct:await fs.realpath(entry).catch(()=>null)===target};
    } catch (error) {
      if (error.code!=='ENOENT') throw error;
      return {path:entry, previousTarget:null, correct:false};
    }
  }));
}

async function replaceLink(entry, target) {
  const temporary = `${entry}.code-ai-${randomUUID()}`;
  await fs.symlink(target, temporary);
  try { await fs.rename(temporary, entry); }
  catch (error) { await fs.unlink(temporary); throw error; }
}

/** Atomic per-path switch; rollback is for failed activation, never a live fallback. */
export async function unifyEntrypoints(binary, entries, expectedSha256) {
  assert.equal(digest(await fs.readFile(binary)), expectedSha256, 'Canonical binary hash changed');
  const before = await inspectEntrypoints(binary, entries);
  const changed = [];
  try {
    for (const entry of before) {
      if (entry.correct) continue;
      await replaceLink(entry.path, binary);
      changed.push(entry);
    }
    assert((await inspectEntrypoints(binary, entries)).every(entry=>entry.correct));
    return before;
  } catch (error) {
    for (const entry of changed.reverse()) {
      if (entry.previousTarget===null) await fs.unlink(entry.path);
      else await replaceLink(entry.path, entry.previousTarget);
    }
    throw error;
  }
}

async function processIdentity(pid) {
  const root = `/proc/${pid}`;
  const stat = (await fs.readFile(`${root}/stat`, 'utf8')).split(') ').at(-1).split(' ');
  return {pid, startTime:stat[19], state:stat[0], executable:await fs.readlink(`${root}/exe`)};
}

async function assertStable(owners) {
  for (const owner of owners) {
    const current = await processIdentity(owner.nativePid);
    assert.equal(current.startTime, owner.identity.startTime, 'Native owner identity changed');
    assert.equal(current.executable, owner.nativeBinary, 'Native owner executable changed');
    const lock = await fs.stat(path.join(owner.directory, 'owner.lock'));
    assert.equal(`${lock.dev}:${lock.ino}`, owner.lockIdentity, 'Owner lock changed');
  }
}

async function readRuntime(corePid) {
  const owners = [];
  for (const profile of ['developer','developer2']) {
    const directory = `/home/${profile}/code-ai-native-owner`;
    const custody = await readJson(path.join(directory,'ownership.json'));
    const ready = await readJson(path.join(directory,'ready.json'));
    assert.equal(custody.profileId,profile);
    assert.equal(ready.nativePid,custody.nativePid);
    assert.equal(ready.profileVerified,true);
    const runnerArgs = (await fs.readFile(`/proc/${custody.runnerPid}/cmdline`,'utf8')).split('\0');
    const planFile = runnerArgs.find(value=>value.startsWith(directory+'/')&&value.endsWith('.json'));
    assert(planFile, 'Active owner plan unavailable');
    const plan = await readJson(planFile);
    const identity = await processIdentity(custody.nativePid);
    assert.equal(identity.executable,plan.nativeBinary);
    assert.equal(custody.nativeBinarySha256,plan.nativeBinarySha256);
    assert.equal(ready.nativeBinarySha256,plan.nativeBinarySha256);
    const lock = await fs.stat(path.join(directory,'owner.lock'));
    owners.push({profileId:profile,directory,planFile,nodeBinary:plan.nodeBinary,runnerModule:plan.runnerModule,
      nativePid:custody.nativePid,identity,
      nativeBinary:plan.nativeBinary,sha256:plan.nativeBinarySha256,lockIdentity:`${lock.dev}:${lock.ino}`});
  }
  assert.equal(owners[0].nativeBinary,owners[1].nativeBinary,'Owners use different installations');
  assert.equal(owners[0].sha256,owners[1].sha256);
  const binary = owners[0].nativeBinary;
  assert(binary.startsWith('/opt/code-ai-tools/codex-')&&binary.endsWith('/bin/codex'));
  assert.equal(digest(await fs.readFile(binary)),owners[0].sha256);
  const distribution = binary.slice(0,binary.indexOf('/package/'));
  const installation = await readJson(path.join(distribution,'installation-receipt.json'));
  assert.equal(installation.nativeBinary,binary);
  assert.equal(installation.officialIntegritySha512Matched,true);
  assert.equal(installation.completePlatformPackage,true);
  const version = await run(binary,['--version']);
  assert.equal(version,`codex-cli ${installation.version}`);
  const environment = new Map((await fs.readFile(`/proc/${corePid}/environ`,'utf8'))
    .split('\0').filter(line=>line.includes('=')).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  for (const name of ['CODEX_BIN','CODEX_TERMINAL_BIN','CODEX_CLI_PATH']) assert.equal(environment.get(name),binary,`${name} drift`);
  return {binary,sha256:owners[0].sha256,version,owners,corePid};
}

/** Remove superseded selections, rather than adding a sixth overriding drop-in. */
export function foldOwnerUnit(base,dropins,{binary,nodeBinary,runnerModule,planFile}) {
  const values=new Map();
  const auxiliaryEnvironment=new Map();
  for(const text of dropins){
    let section='';
    for(const raw of text.split('\n')){
      const line=raw.trim();if(!line||line.startsWith('#'))continue;
      if(line.startsWith('[')){assert.equal(line,'[Service]','Unexpected unit section');section=line;continue;}
      assert.equal(section,'[Service]');
      const key=line.slice(0,line.indexOf('=')),value=line.slice(line.indexOf('=')+1);
      assert(['ExecStart','Environment','KillMode','Restart'].includes(key),'Unreviewed unit setting');
      if(key==='Environment'){
        const match=value.match(/^"?(CODEX_CLI_PATH|CODE_AI_BROWSER_PYTHON)=([^"\r\n]+)"?$/);
        assert(match,'Unreviewed unit environment');
        if(match[1]!=='CODEX_CLI_PATH')auxiliaryEnvironment.set(match[1],match[2]);
      }
      if(key==='KillMode'||key==='Restart')values.set(key,value);
    }
  }
  assert.equal((base.match(/^ExecStart=/gm)||[]).length,1);
  assert.equal((base.match(/^Environment="CODEX_CLI_PATH=/gm)||[]).length,1);
  const quote=value=>{assert(!/["\r\n%]/.test(value));return `"${value}"`;};
  let result=base.replace(/^ExecStart=.*$/m,`ExecStart=${[nodeBinary,runnerModule,planFile].map(quote).join(' ')}`)
    .replace(/^Environment="CODEX_CLI_PATH=.*$/m,`Environment=${quote('CODEX_CLI_PATH='+binary)}`);
  for(const [key,value] of auxiliaryEnvironment){
    assert(!new RegExp(`^Environment="${key}=`,'m').test(base),'Duplicate auxiliary base environment');
    result=result.replace(/^ExecStart=/m,`Environment=${quote(key+'='+value)}\nExecStart=`);
  }
  for(const [key,value] of values){
    assert(new RegExp(`^${key}=`,'m').test(result),'Unreviewed policy addition');
    result=result.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${value}`);
  }
  return result;
}

async function ownerUnits(runtime) {
  const result=[];
  for(const owner of runtime.owners){
    const filename=`/etc/systemd/system/code-ai-native-owner-${owner.profileId}.service`;
    const dropinDirectory=filename+'.d';
    const names=(await fs.readdir(dropinDirectory).catch(error=>{if(error.code==='ENOENT')return [];throw error;})).sort();
    assert(names.every(name=>name.endsWith('.conf')),'Unreviewed owner drop-in artifact');
    const files=[filename,...names.map(name=>path.join(dropinDirectory,name))];
    const originals=await Promise.all(files.map(async file=>({file,text:await fs.readFile(file,'utf8')})));
    const folded=foldOwnerUnit(originals[0].text,originals.slice(1).map(x=>x.text),{
      binary:runtime.binary,nodeBinary:owner.nodeBinary,runnerModule:owner.runnerModule,planFile:owner.planFile,
    });
    result.push({filename,files,originals,folded});
  }
  return result;
}

async function unitSemantics(unit) {
  const output=await run('/usr/bin/systemctl',['show',path.basename(unit),'-p','Type','-p','User','-p','Group',
    '-p','UMask','-p','Restart','-p','RestartUSec','-p','KillMode','-p','TimeoutStopUSec','-p','Environment','-p','ExecStart']);
  return output.split('\n').map(line=>{
    if(line.startsWith('Environment='))return 'Environment='+line.slice(12).split(' ').sort().join(' ');
    if(!line.startsWith('ExecStart='))return line;
    const match=line.match(/argv\[\]=(.*?) ; ignore_errors=/);assert(match,'Effective owner command unavailable');
    return 'ExecStart='+match[1];
  }).sort().join('\n');
}

async function consolidateOwnerUnits(units,recovery) {
  const archive=path.join(recovery,'owner-units.tar');
  const files=units.flatMap(unit=>unit.files);
  await run('/usr/bin/tar',['--create','--file',archive,'--directory','/etc/systemd/system',...files.map(file=>path.relative('/etc/systemd/system',file))]);
  const before=await Promise.all(units.map(unit=>unitSemantics(unit.filename)));
  for(const unit of units){
    for(const original of unit.originals)assert.equal(await fs.readFile(original.file,'utf8'),original.text,'Owner unit changed concurrently');
    const temporary=unit.filename+'.consolidating-'+randomUUID();
    await fs.writeFile(temporary,unit.folded,{mode:0o644});await fs.rename(temporary,unit.filename);
    for(const dropin of unit.files.slice(1))await fs.unlink(dropin);
    await fs.rmdir(unit.filename+'.d').catch(error=>{if(error.code!=='ENOENT')throw error;});
  }
  await run('/usr/bin/systemd-analyze',['verify',...units.map(unit=>unit.filename)]);
  await run('/usr/bin/systemctl',['daemon-reload']);
  assert.deepEqual(await Promise.all(units.map(unit=>unitSemantics(unit.filename))),before,'Effective owner policy changed');
  return {archive,removedDropins:units.flatMap(unit=>unit.files.slice(1)),effectivePolicyPreserved:true};
}

async function legacyLoadedThreads(socket) {
  const ws = new WebSocket(`ws+unix://${socket}:/`,{handshakeTimeout:4000,perMessageDeflate:false,maxPayload:1024*1024});
  let next = 0;
  const pending = new Map();
  ws.on('error',()=>{});
  ws.on('message',buffer=>{
    let frame; try {frame=JSON.parse(buffer.toString());}catch{return;}
    const call=pending.get(frame.id);if(!call)return;
    pending.delete(frame.id);clearTimeout(call.timer);
    if(frame.error)call.reject(Error('Legacy owner read rejected'));else call.resolve(frame.result);
  });
  const call=(method,params)=>new Promise((resolve,reject)=>{
    const id=++next;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('Legacy owner read timed out'));},4000);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  try {
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(Error('Legacy owner unavailable')));});
    await call('initialize',{clientInfo:{name:'code-ai-runtime-retirement',version:'1'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized',params:{}}));
    const result=await call('thread/loaded/list',{});
    assert(Array.isArray(result.data)&&!result.nextCursor,'Legacy loaded state incomplete');
    return result.data.length;
  } finally {
    ws.terminate();
    for(const call of pending.values()){clearTimeout(call.timer);call.reject(Error('Probe closed'));}
    await pause(75);
  }
}

async function legacyProcesses(runtime) {
  const found=[];
  for(const pidString of (await fs.readdir('/proc')).filter(value=>/^\d+$/.test(value))) {
    const pid=Number(pidString);
    let identity,args,cwd;
    try {
      identity=await processIdentity(pid);
      if(!identity.executable.startsWith('/usr/lib/node_modules/@openai/.codex-')||!identity.executable.endsWith('/bin/codex (deleted)'))continue;
      args=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0');
      cwd=await fs.readlink(`/proc/${pid}/cwd`);
    }catch{continue;}
    const owner=runtime.owners.find(value=>cwd===`/home/${value.profileId}`);
    if(!owner||!args.includes('app-server'))continue;
    assert.equal(args[args.indexOf('--listen')+1],'unix://');
    const version=await run(`/proc/${pid}/exe`,['--version']);
    assert.equal(version,'codex-cli 0.154.0','Unexpected legacy executable; inspect instead of retiring');
    const socket=path.join(cwd,'.codex/app-server-control/app-server-control.sock');
    assert.equal(await legacyLoadedThreads(socket),0,'Legacy owner still has loaded work');
    const unix=await fs.readFile('/proc/net/unix','utf8');
    assert(!unix.split('\n').some(line=>{const fields=line.trim().split(/\s+/);return fields.slice(7).join(' ')===socket&&fields[5]==='03';}),
      'Legacy owner still has a connected client');
    const children=(await fs.readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);
    const helpers=[];
    for(const child of children){
      const helper=await processIdentity(Number(child));
      assert(helper.executable.startsWith('/usr/lib/node_modules/@openai/.codex-')
        &&helper.executable.endsWith('/bin/codex-code-mode-host (deleted)'), 'Unreviewed legacy child process');
      helpers.push(helper);
    }
    found.push({...identity,socket,version,helpers});
  }
  return found;
}

async function retireLegacy(record) {
  assert.equal((await processIdentity(record.pid)).startTime,record.startTime,'Legacy PID changed');
  assert.equal(await legacyLoadedThreads(record.socket),0,'Legacy owner became busy');
  const unix=await fs.readFile('/proc/net/unix','utf8');
  assert(!unix.split('\n').some(line=>{const f=line.trim().split(/\s+/);return f.slice(7).join(' ')===record.socket&&f[5]==='03';}),
    'Legacy client connected before retirement');
  await stopRetiredProcess(record);
  for(const helper of record.helpers)await stopRetiredProcess(helper);
}

async function stopRetiredProcess(record) {
  const before=await processIdentity(record.pid).catch(()=>null);
  if(!before||before.startTime!==record.startTime||before.state==='Z')return;
  assert.equal(before.executable,record.executable,'Legacy executable changed');
  process.kill(record.pid,'SIGTERM');
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){
    const identity=await processIdentity(record.pid).catch(()=>null);
    if(!identity||identity.startTime!==record.startTime||identity.state==='Z')return;
    await pause(100);
  }
  throw Error('Legacy owner did not stop gracefully; no forced kill attempted');
}

async function assertNoLivePackageReference(directory) {
  for(const pid of (await fs.readdir('/proc')).filter(value=>/^\d+$/.test(value))){
    for(const link of ['exe','cwd']){
      const target=await fs.readlink(`/proc/${pid}/${link}`).catch(()=>null);
      assert(!target?.startsWith(directory+'/'),`Live process references package: ${pid}`);
    }
    const args=await fs.readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>null);
    assert(!args?.split('\0').some(arg=>arg.startsWith(directory+'/')),`Live launcher references package: ${pid}`);
    for(const fd of await fs.readdir(`/proc/${pid}/fd`).catch(()=>[])){
      const target=await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(()=>null);
      assert(!target?.startsWith(directory+'/'),`Open package file: ${pid}`);
    }
  }
}

export async function archivePackage(directory,archive) {
  assert.equal(path.basename(directory),'codex','Narrow package target required');
  const stat=await fs.lstat(directory);
  assert(stat.isDirectory()&&!stat.isSymbolicLink());
  await run('/usr/bin/tar',['--create','--file',archive,'--directory',path.dirname(directory),'codex']);
  await run('/usr/bin/tar',['--compare','--file',archive,'--directory',path.dirname(directory)]);
  return {path:directory,archive,device:stat.dev,inode:stat.ino,archiveSha256:digest(await fs.readFile(archive))};
}

async function main() {
  assert.equal(process.platform,'linux');
  assert.equal((await import('node:os')).hostname(),'web','Main Germany host only');
  assert.equal(process.getuid(),0);
  const apply=process.argv.includes('--apply');
  const pidArgument=process.argv.indexOf('--core-pid');
  const corePid=Number(process.argv[pidArgument+1]);
  assert(pidArgument>0&&Number.isSafeInteger(corePid)&&corePid>1,'--core-pid required');
  const runtime=await readRuntime(corePid);
  const units=await ownerUnits(runtime);
  const entries=['/usr/bin/codex','/usr/local/bin/codex','/root/.nvm/versions/node/v24.12.0/bin/codex'];
  const packages=['/usr/lib/node_modules/@openai/codex','/root/.nvm/versions/node/v24.12.0/lib/node_modules/@openai/codex'];
  const before=await inspectEntrypoints(runtime.binary,entries);
  const legacy=await legacyProcesses(runtime);
  console.log(JSON.stringify({phase:'preflight',apply,version:runtime.version,canonicalBinary:runtime.binary,entrypoints:before,
    legacy:legacy.map(({pid,version})=>({pid,version})),owners:runtime.owners.map(x=>({profileId:x.profileId,pid:x.nativePid})),
    supersededOwnerDropins:units.reduce((sum,unit)=>sum+unit.files.length-1,0)}));
  if(!apply)return;
  const base='/mnt/hdd/code-ai-recovery';
  await fs.mkdir(base,{recursive:true,mode:0o700});
  const recovery=await fs.mkdtemp(path.join(base,'codex-runtime-20261016-'));
  const receipt={format:'code-ai-runtime-consolidation',version:1,host:'web',startedAt:new Date().toISOString(),
    canonicalBinary:runtime.binary,sha256:runtime.sha256,nativeVersion:runtime.version,corePid,
    owners:runtime.owners.map(x=>({profileId:x.profileId,pid:x.nativePid,startTime:x.identity.startTime,lockIdentity:x.lockIdentity})),
    entrypointsBefore:before,archives:[],retiredLegacy:[],complete:false};
  const receiptFile=path.join(recovery,'receipt.json');
  const save=()=>fs.writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  await save();
  try {
    for(const directory of packages){
      if(!(await fs.lstat(directory).catch(()=>null)))continue;
      receipt.archives.push(await archivePackage(directory,path.join(recovery,`package-${receipt.archives.length+1}.tar`)));
      await save();
    }
    await assertStable(runtime.owners);
    receipt.ownerUnits=await consolidateOwnerUnits(units,recovery);await save();
    await assertStable(runtime.owners);
    await unifyEntrypoints(runtime.binary,entries,runtime.sha256);
    receipt.entrypointsUnified=true;await save();
    for(const record of legacy){await retireLegacy(record);receipt.retiredLegacy.push({pid:record.pid,version:record.version});await save();}
    for(const archived of receipt.archives){
      await assertNoLivePackageReference(archived.path);
      const stat=await fs.lstat(archived.path);
      assert.equal(stat.dev,archived.device);assert.equal(stat.ino,archived.inode);
      await fs.rm(archived.path,{recursive:true});
      archived.removedFromLiveInstall=true;await save();
    }
    for(const entry of entries)assert.equal(await run(entry,['--version']),runtime.version);
    await assertStable(runtime.owners);
    await readRuntime(corePid);
    assert.equal((await legacyProcesses(runtime)).length,0);
    receipt.entrypointsAfter=await inspectEntrypoints(runtime.binary,entries);
    receipt.complete=true;receipt.finishedAt=new Date().toISOString();await save();
    console.log(JSON.stringify({phase:'complete',receipt:receiptFile,...receipt}));
  }catch(error){receipt.error=error.message;await save();throw error;}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(error=>{
  console.error(`Codex runtime consolidation stopped: ${error.message}`);process.exitCode=1;
});
