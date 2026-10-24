import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {archivePackage,foldOwnerUnit,inspectEntrypoints,unifyEntrypoints} from './consolidate-runtime.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-runtime-consolidation-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const binary=path.join(root,'qualified-codex');await fs.writeFile(binary,'qualified bytes');
  return {root,binary,sha:createHash('sha256').update('qualified bytes').digest('hex')};
}

test('all entry points resolve to one executable; repeat is idempotent',async t=>{
  const f=await fixture(t),entries=['system','node','local'].map(v=>path.join(f.root,v));
  await fs.writeFile(path.join(f.root,'old'),'old');await fs.symlink('old',entries[0]);
  await fs.symlink(f.binary,entries[1]);
  const before=await unifyEntrypoints(f.binary,entries,f.sha);
  assert.deepEqual(before.map(x=>x.correct),[false,true,false]);
  assert((await inspectEntrypoints(f.binary,entries)).every(x=>x.correct));
  assert((await unifyEntrypoints(f.binary,entries,f.sha)).every(x=>x.correct));
});

test('wrong qualified hash changes nothing',async t=>{
  const f=await fixture(t),entry=path.join(f.root,'entry');await fs.symlink('old',entry);
  await assert.rejects(unifyEntrypoints(f.binary,[entry],'0'.repeat(64)),/hash changed/);
  assert.equal(await fs.readlink(entry),'old');
});

test('ordinary files are not overwritten',async t=>{
  const f=await fixture(t),entry=path.join(f.root,'entry');await fs.writeFile(entry,'user file');
  await assert.rejects(unifyEntrypoints(f.binary,[entry],f.sha),/non-symlink/);
  assert.equal(await fs.readFile(entry,'utf8'),'user file');
});

test('failed activation restores preceding entries',async t=>{
  const f=await fixture(t),first=path.join(f.root,'entry');await fs.symlink('old',first);
  const missing=path.join(f.root,'missing-parent','entry');
  await assert.rejects(unifyEntrypoints(f.binary,[first,missing],f.sha),/ENOENT/);
  assert.equal(await fs.readlink(first),'old');
});

test('package archive is verified without removing the source',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'codex');await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'package.json'),'{"version":"old"}');
  const r=await archivePackage(directory,path.join(f.root,'package.tar'));
  assert.equal(r.archiveSha256.length,64);
  assert.equal(await fs.readFile(path.join(directory,'package.json'),'utf8'),'{"version":"old"}');
  await assert.rejects(archivePackage(f.root,path.join(f.root,'wrong.tar')),/Narrow package/);
});

test('fold owner selection into one unit, preserving other policies',()=>{
  const base='[Service]\nEnvironment="HOME=/profile"\nEnvironment="CODEX_CLI_PATH=/old"\nExecStart=/old-runner\nRestart=on-failure\nKillMode=control-group\n';
  const result=foldOwnerUnit(base,['[Service]\nExecStart=\nExecStart=/superseded\nEnvironment="CODEX_CLI_PATH=/also-old"\nEnvironment="CODE_AI_BROWSER_PYTHON=/python"\n'],
    {binary:'/qualified',nodeBinary:'/node',runnerModule:'/current-runner',planFile:'/plan'});
  assert(!/old|superseded/.test(result));
  assert(result.includes('Environment="HOME=/profile"'));
  assert(result.includes('Environment="CODE_AI_BROWSER_PYTHON=/python"'));
  assert(result.includes('ExecStart="/node" "/current-runner" "/plan"'));
  assert.equal((result.match(/CODEX_CLI_PATH=/g)||[]).length,1);
  assert(result.includes('KillMode=control-group'));
});

test('unreviewed drop-in directives block consolidation',()=>{
  assert.throws(()=>foldOwnerUnit('',['[Service]\nExecStop=/custom\n'],{}),/Unreviewed/);
  assert.throws(()=>foldOwnerUnit('',['[Service]\nEnvironment="SOME_SECRET=private"\n'],{}),/Unreviewed/);
});
