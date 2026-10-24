import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const root = '/root/projects/code-ai', ops = root + '/ops/server-status-20261021';
const baseline = path.dirname(await fs.realpath(root + '/dist'));
const request = JSON.parse(await fs.readFile(baseline + '/fleet-request.json', 'utf8'));
const { preserveRuntimeAuthentication } = await import(pathToFileURL(baseline + '/runtime-auth.mjs'));
const env = { CODE_AI_AUTH_BASELINE_MODULE: request.authenticationBaselineModule, CODE_AI_AUTH_BASELINE_SHA256: request.authenticationBaselineSha256 };
await preserveRuntimeAuthentication(env);
const origin = process.env.CODE_AI_STATUS_TEST_ORIGIN || 'https://app-codex.bina-cshera.co.il';
const r = await fetch(origin + '/api/codex/device-unlock', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: env.CODEX_DEVICE_ADMIN_PASSWORD }), signal: AbortSignal.timeout(15000) });
assert.equal(r.status, 200);
const cookie = r.headers.getSetCookie().map(v => v.split(';')[0]).join('; '); assert.ok(cookie);
const child = spawn(root + '/.venv/bin/python', [ops + '/browser-check.py'], { cwd: root,
  env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', CODE_AI_STATUS_TEST_ORIGIN: origin, CODE_AI_STATUS_TEST_COOKIE: cookie },
  stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '';
child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
if (code !== 0) { console.error(errors.slice(-5000)); throw Error('Browser acceptance failed'); }
const receipt = JSON.parse(output.trim()); assert.equal(receipt.passed, true);
await fs.writeFile(ops + '/browser-check.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt));
