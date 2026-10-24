import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, cp, readlink } from 'node:fs/promises';
import { copyOptions,assertContainedLinks } from './package-contract.mjs';
test('npm executable links survive relocation without referencing the build workspace',async()=>{
  const scratch=await mkdtemp('/mnt/hdd/code-ai-builds/pci-link-contract-');
  const source=scratch+'/source/node_modules';
  const output=scratch+'/output';
  await mkdir(source+'/.bin',{recursive:true});
  await mkdir(source+'/mime',{recursive:true});
  await writeFile(source+'/mime/cli.js','');
  await symlink('../mime/cli.js',source+'/.bin/mime');
  await cp(source,output+'/app/node_modules',copyOptions);
  assert.equal(await readlink(output+'/app/node_modules/.bin/mime'),'../mime/cli.js');
  assert.deepEqual(await assertContainedLinks(output),{containedSymbolicLinks:1});
  await symlink('/workspace/work/payload/node_modules/mime/cli.js',output+'/bad');
  await assert.rejects(()=>assertContainedLinks(output),/must be relative/);
});
