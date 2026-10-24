#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = await import(pathToFileURL(path.join(root, 'dist/codexRuntimePrograms.mjs')));
const proof = [];
for (const name of Object.keys(runtime.codexRuntimePrograms)) {
  const program = runtime.resolveCodexRuntimeProgram(name, {
    moduleUrl: pathToFileURL(path.join(root, 'dist/app.mjs')),
  });
  assert.ok(program.startsWith(root + path.sep), 'Runtime program escaped candidate: ' + name);
  const row = { name, relative: path.relative(root, program) };
  if (name === 'browser_mode') {
    const catalog = JSON.parse(execFileSync('/usr/bin/python3', [program, '--describe-tools'], {
      encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    }));
    assert.ok(catalog.tools?.length && catalog.tools.every(t => t.name && t.inputSchema));
    row.tools = catalog.tools.length;
  } else {
    execFileSync(process.execPath, ['--check', program], { timeout: 15000, stdio: 'pipe' });
    if (['personal_chrome', 'phone_mode', 'design_mode', 'ux_mode'].includes(name)) {
      const catalog = JSON.parse(execFileSync(process.execPath, [program, '--describe-tools'], {
        encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' },
      }));
      assert.ok(catalog.tools?.length && catalog.tools.every(t => t.name && t.inputSchema));
      row.tools = catalog.tools.length;
    }
  }
  proof.push(row);
}
console.log(JSON.stringify({ runtimeProgramsVerified: true, programs: proof }));
