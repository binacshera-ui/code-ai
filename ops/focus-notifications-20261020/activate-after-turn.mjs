// One main-only handoff using the accepted installer. This is not an idle-fleet
// scheduler or a deployment-drain seal. Other work can be interrupted under the
// owner's existing explicit restart policy; the initiating native turn is spared.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [requestFile, itemId] = process.argv.slice(2);
assert.match(itemId || '', /^[a-f0-9-]{36}$/);
const request = JSON.parse(await readFile(requestFile, 'utf8'));
assert.equal(request.id, 'main');
assert.ok(request.candidate.startsWith('/mnt/hdd/code-ai-builds/work-modes-20261020-'));
const receiptFile = path.join(request.candidate, 'handoff-receipt.json');
const receipt = { format: 'code-ai-main-turn-handoff', version: 1, scope: 'main Germany web only',
  currentQueueItem: itemId, release: request.candidate, status: 'waiting_for_initiating_turn', startedAt: new Date().toISOString() };
const save = () => writeFile(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await save();
  const timeout = Date.now() + 6 * 60 * 60 * 1000;
  while (true) {
    assert.ok(Date.now() < timeout, 'Initiating turn did not finish in six hours; preserved prepared package');
    const state = JSON.parse(await readFile('/root/projects/code-ai/.code-ai/queue/state.json', 'utf8'));
    const item = state.items.find(item => item.id === itemId);
    assert.ok(item, 'Initiating queue record disappeared; no activation');
    if (['completed', 'failed', 'cancelled'].includes(item.status)) {
      assert.ok(!item.nativeSubmission || ['completed', 'cancelled', 'rejected'].includes(item.nativeSubmission.deliveryPhase),
        'Native acceptance still requires reconciliation; no activation');
      break;
    }
    await pause(2_000);
  }
  assert.equal(path.dirname(await realpath('/root/projects/code-ai/dist')), request.baseline, 'Accepted baseline changed; no stale activation');
  receipt.status = 'activating'; await save();
  const command = [path.join(request.candidate, 'install.mjs'), 'activate', requestFile];
  const result = execFileSync(request.nodeExecutable, command, { encoding: 'utf8',
    env: { ...process.env, PM2_HOME: '/root/.pm2' }, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  receipt.activation = JSON.parse(result.trim());
  assert.equal(receipt.activation.installed, true);
  assert.equal(path.dirname(await realpath('/root/projects/code-ai/dist')), request.candidate);
  // Reuse preserved authentication internally; never emit credentials/cookies.
  const { preserveRuntimeAuthentication } = await import(path.join(request.candidate, 'runtime-auth.mjs'));
  const privateEnvironment = { CODE_AI_AUTH_BASELINE_MODULE: request.authenticationBaselineModule,
    CODE_AI_AUTH_BASELINE_SHA256: request.authenticationBaselineSha256 };
  await preserveRuntimeAuthentication(privateEnvironment);
  const unlock = await fetch('http://127.0.0.1:4000/api/codex/device-unlock', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: privateEnvironment.CODEX_DEVICE_ADMIN_PASSWORD }),
    signal: AbortSignal.timeout(10_000) });
  assert.equal(unlock.status, 200, 'Preserved authentication did not unlock the local feature readback');
  const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Local authentication cookie missing');
  // Exercise changed API route shapes without altering preferences or cases.
  const paths = [
    '/api/codex/session-focus-mode?profileId=developer&sessionKey=01a05cd0-8a16-7752-9558-1dbe4f9ebd3f',
    '/api/codex/work-mode-runs?profileId=developer&sessionKey=01a05cd0-8a16-7752-9558-1dbe4f9ebd3f',
    '/api/codex/incident-cases',
  ];
  receipt.routeChecks = [];
  for (const route of paths) {
    const response = await fetch('http://127.0.0.1:4000' + route, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('application/json'));
    receipt.routeChecks.push({ route: route.split('?')[0], status: response.status, json: true });
  }
  receipt.status = 'activated'; receipt.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: receipt.status, release: request.candidate, receiptFile }));
} catch (error) {
  receipt.status = 'failed'; receipt.error = error.message; receipt.finishedAt = new Date().toISOString();
  await save();
  console.error('Main-only feature handoff failed; inspect the preserved handoff receipt and installer rollback result.');
  process.exitCode = 1;
}
