#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check dynamic runtime imports from the release, not the developer's cwd. */
export async function verifyRuntimeDependencies(entry) {
  const filename = path.resolve(entry);
  const root = path.dirname(path.dirname(filename));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const require = createRequire(filename);
  const provider = require('systeminformation');
  const installed = require('systeminformation/package.json').version;
  if (installed !== manifest.dependencies.systeminformation
      || !['cpu', 'currentLoad', 'mem', 'fsSize', 'networkStats'].every(key => typeof provider[key] === 'function')) {
    throw new Error('Monitoring runtime dependency is missing or incompatible');
  }
  return { runtimeDependenciesVerified: true, systeminformation: installed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyRuntimeDependencies(process.argv[2] || 'dist/server.js')));
}
