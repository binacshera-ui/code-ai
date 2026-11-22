import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyRuntimeDependencies } from './verify-runtime-dependencies.mjs';

test('release preflight fails on missing, incompatible and incomplete monitoring dependencies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-runtime-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { systeminformation: '5.33.16' } }));
  const entry = path.join(root, 'dist/server.js');
  await assert.rejects(verifyRuntimeDependencies(entry), { code: 'MODULE_NOT_FOUND' });
  const dependency = path.join(root, 'node_modules/systeminformation');
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ version: '5.33.16', main: 'index.cjs' }));
  await writeFile(path.join(dependency, 'index.cjs'), 'module.exports={};');
  await assert.rejects(verifyRuntimeDependencies(entry), /missing or incompatible/);
});

test('release preflight verifies the resolved package and its monitoring interface', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-runtime-dependency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependency = path.join(root, 'node_modules/systeminformation');
  await mkdir(dependency, { recursive: true });
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { systeminformation: '5.33.16' } }));
  await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ version: '5.33.16', main: 'index.cjs' }));
  await writeFile(path.join(dependency, 'index.cjs'), 'module.exports={cpu(){},currentLoad(){},mem(){},fsSize(){},networkStats(){}};');
  assert.deepEqual(await verifyRuntimeDependencies(path.join(root, 'dist/server.js')),
    { runtimeDependenciesVerified: true, systeminformation: '5.33.16' });
});
