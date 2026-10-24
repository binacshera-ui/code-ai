import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';

export async function verifyRemote(request) {
  const targets = {
    'beam-10g': { service: 'code-ai-remote-beam-10g.service' },
    pci: { service: 'code-ai-remote-pci.service' },
    'ubuntu-gpu-lab': { service: 'code-ai-ubuntu-agent.service', user: true },
  };
  const target = targets[request.id]; assert.ok(target);
  const ctl = args => execFileSync('systemctl', [...(target.user ? ['--user'] : []), ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(ctl(['is-active', target.service]), 'active');
  const pid = Number(ctl(['show', target.service, '-p', 'MainPID', '--value']));
  assert.ok(pid > 1);
  const root = ctl(['show', target.service, '-p', 'WorkingDirectory', '--value']);
  assert.equal(await realpath(root), await realpath(request.candidate));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(await readFile(root + '/release-files.json', 'utf8'));
  for (const [file, sha] of Object.entries(manifest.files)) assert.equal(hash(await readFile(root + '/' + file)), sha);
  assert.equal(hash(await readFile(root + '/dist/server.js')), request.expectedServerSha256);
  assert.equal(hash(await readFile(root + '/dist/app.mjs')), request.expectedAppSha256);
  const environment = await readFile('/proc/' + pid + '/environ', 'utf8');
  const entries = Object.fromEntries(environment.split('\0').filter(Boolean).map(row => {
    const separator = row.indexOf('='); return [row.slice(0, separator), row.slice(separator + 1)];
  }));
  assert.equal(Boolean(entries.CODE_AI_CODEX_SHARED_OWNER_PROFILES?.trim()), false);
  const token = request.pairingFile ? JSON.parse(await readFile(request.pairingFile, 'utf8')).token
    : parseEnv(await readFile(request.environmentFile, 'utf8')).CODEX_REMOTE_AGENT_TOKEN;
  assert.ok(token);
  const headers = { 'x-code-ai-remote-token': token };
  const health = await fetch('http://127.0.0.1:4010/api/codex/remote-agent/health', { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const unauthorized = await fetch('http://127.0.0.1:4010/api/codex/remote-agent/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  const question = await fetch('http://127.0.0.1:4010/api/codex/sessions/00000000-0000-4000-8000-000000000000/user-input',
    { headers, signal: AbortSignal.timeout(5000) });
  assert.ok([200, 400, 401, 403, 404].includes(question.status));
  assert.ok(question.headers.get('content-type')?.includes('application/json'));
  assert.equal(Number(ctl(['show', target.service, '-p', 'MainPID', '--value'])), pid);
  return { id: request.id, observedAt: new Date().toISOString(), hostname: execFileSync('hostname', { encoding: 'utf8' }).trim(),
    service: target.service, active: true, mainPid: pid, workingDirectory: root,
    artifactFilesVerified: Object.keys(manifest.files).length, applicationSha256: request.expectedAppSha256,
    authenticatedHealth: 200, unauthenticatedHealth: 401, questionStatus: question.status, questionJson: true,
    sharedOwnerEnabled: false, credentialValuesPrinted: false };
}
