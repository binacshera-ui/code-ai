import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, realpath, statfs, access, symlink, rename, lstat, readlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { preserveRuntimeAuthentication, parseRuntimeEnvironment } from './runtime-auth.mjs';
import { verifyQuestionResponse, verifyServedAssets, recoverMainTransaction } from './transaction-contract.mjs';

const [phase, requestFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const digest = async file => hash(await readFile(file));
const fixedError = reason => Object.assign(new Error('Code AI release transaction failed.'), { reason });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (command, args, env) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 90_000, cwd: request.candidate,
  ...(env ? { env } : {}) }).trim();
const target = {
  main: { manager: 'pm2', queue: '/root/projects/code-ai/.code-ai/queue/state.json' },
  'beam-10g': { service: 'code-ai-remote-beam-10g.service', root: '/opt/code-ai-releases/', queue: '/var/lib/code-ai-remote/beam-10g/queue/state.json' },
  pci: { service: 'code-ai-remote-pci.service', root: '/opt/code-ai-releases/', queue: '/var/lib/code-ai-pci/queue/state.json' },
  'ubuntu-gpu-lab': { service: 'code-ai-ubuntu-agent.service', root: '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/',
    user: true, queue: '/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json' },
}[request.id];
assert.ok(target && request.ownerAuthorizedInterruption === true, 'Exact target and interruption policy required');
assert.match(request.buildId, /^[a-f0-9-]{36}$/);
for (const key of ['expectedBaselineSha256', 'expectedServerSha256', 'expectedAppSha256']) assert.match(request[key], /^[a-f0-9]{64}$/);
assert.ok(path.isAbsolute(request.candidate) && !request.candidate.includes('..'));
assert.ok(request.candidate.startsWith(target.root || '/mnt/hdd/code-ai-builds/'));
assert.notEqual(request.candidate, request.baseline);
if (request.attemptId) assert.match(request.attemptId, /^[a-z0-9-]{1,80}$/);
const ctl = args => run('systemctl', [...(target.user ? ['--user'] : []), ...args]);
const unitInfo = async service => {
  const text = ctl(['cat', service]); let section = false; let commands = [];
  for (const line of text.split('\n')) {
    if (/^\[.*\]$/.test(line.trim())) section = line.trim() === '[Service]';
    if (!section || !/^\s*ExecStart=/.test(line)) continue;
    const value = line.slice(line.indexOf('=') + 1).trim();
    assert.ok(!value.endsWith('\\'), 'Multiline start command requires review');
    if (value) commands.push(value); else commands = [];
  }
  assert.equal(commands.length, 1);
  assert.equal(/(?:TOKEN|PASSWORD|SECRET)=/i.test(commands[0]), false, 'Credential-bearing command requires separate handling');
  const fragment = ctl(['show', service, '-p', 'FragmentPath', '--value']);
  return { command: commands[0], fragment };
};
async function verifyCandidate() {
  assert.equal(await digest(request.baseline + '/dist/server.js'), request.expectedBaselineSha256, 'Installed baseline changed');
  assert.equal(await digest(request.candidate + '/dist/server.js'), request.expectedServerSha256);
  assert.equal(await digest(request.candidate + '/dist/app.mjs'), request.expectedAppSha256);
  const manifest = JSON.parse(await readFile(request.candidate + '/release-files.json', 'utf8'));
  for (const [file, sha] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    assert.equal(await digest(request.candidate + '/' + file), sha, 'Qualified release file changed');
  }
  const space = await statfs(request.candidate);
  assert.ok(space.bavail * space.bsize > Math.max(space.blocks * space.bsize * 0.15, 100_000_000_000));
  const requirePath = await realpath(request.candidate + '/node_modules');
  assert.ok(requirePath.length > 1);
  run(request.nodeExecutable, ['--check', request.candidate + '/dist/server.js']);
  run(request.nodeExecutable, ['--check', request.candidate + '/dist/app.mjs']);
  const probe = run(request.nodeExecutable, ['--input-type=module', '-e',
    'for(const p of ["express","express-session","connect-pg-simple","ws"]){await import(p)} process.stdout.write("dependencies-ok")'],
    { ...process.env, NODE_PATH: requirePath });
  // This process is launched with cwd=candidate; ESM resolves its dependencies there.
  assert.equal(probe, 'dependencies-ok');
}
async function queueSnapshot(label) {
  const directory = request.candidate + '/private-deployment-backup' + (request.attemptId ? '/' + request.attemptId : '');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let bytes;
  try { bytes = await readFile(target.queue); } catch (error) { if (error.code === 'ENOENT') return { items: [], counts: {} }; throw error; }
  const data = JSON.parse(bytes); const items = data.items || [];
  await writeFile(directory + '/' + label + '-queue.json', bytes, { mode: 0o600, flag: 'wx' });
  return { items, counts: Object.fromEntries(['running', 'queued', 'scheduled', 'draft', 'cancelling', 'completed', 'failed', 'cancelled']
    .map(status => [status, items.filter(item => item.status === status).length])) };
}
async function remoteToken() {
  if (request.pairingFile) return JSON.parse(await readFile(request.pairingFile, 'utf8')).token;
  return parseEnv(await readFile(request.environmentFile, 'utf8')).CODEX_REMOTE_AGENT_TOKEN;
}
async function readiness(releaseRoot = request.candidate) {
  const token = request.id === 'main' ? null : await remoteToken();
  const headers = token ? { 'x-code-ai-remote-token': token } : {};
  const origin = 'http://127.0.0.1:' + (request.id === 'main' ? '4000' : '4010');
  const route = request.id === 'main' ? '/api/auth/check-session' : '/api/codex/remote-agent/health';
  const deadline = Date.now() + 40_000; let body;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + route, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status === 200 && response.headers.get('content-type')?.includes('application/json')) {
        body = await response.json(); if (request.id === 'main' || body.ok === true) break;
      }
    } catch {} await sleep(350);
  }
  assert.ok(body && (request.id === 'main' || body.ok === true), 'Live JSON readiness failed');
  if (token) assert.equal((await fetch(origin + route, { signal: AbortSignal.timeout(3000) })).status, 401);
  const question = await fetch(origin + '/api/codex/sessions/00000000-0000-4000-8000-000000000000/user-input',
    { headers, signal: AbortSignal.timeout(5000) });
  verifyQuestionResponse(question);
  if (request.id === 'main') {
    await verifyServedAssets({ origin, releaseRoot, fetch, readFile });
  }
  return { authenticatedHealth: 200, unauthenticatedRemoteHealth: token ? 401 : null,
    questionRouteJson: true, liveCredentialValuesPrinted: false };
}
async function uploadReadiness() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:4001/api/auth/check-session', { signal: AbortSignal.timeout(2000) });
      if (response.status === 200 && response.headers.get('content-type')?.includes('application/json')) return;
    } catch {}
    await sleep(350);
  }
  throw fixedError('upload_json_readiness_failed');
}
async function writeOverride(service, command, baselineModule, baselineSha, workingDirectory) {
  const info = await unitInfo(service);
  const file = info.fragment + '.d/zzzzzz-code-ai-immediate-' + request.buildId + '.conf';
  await mkdir(path.dirname(file), { recursive: true });
  const text = '[Service]\nWorkingDirectory=' + workingDirectory + '\nExecStart=\nExecStart=' + command + '\n'
    + 'Environment="CODE_AI_AUTH_BASELINE_MODULE=' + baselineModule + '"\n'
    + 'Environment="CODE_AI_AUTH_BASELINE_SHA256=' + baselineSha + '"\n'
    + 'Environment="CODE_AI_CODEX_SHARED_OWNER_PROFILES="\n';
  await writeFile(file, text, { mode: 0o600, flag: 'wx' });
  return file;
}
async function activateRemote() {
  assert.equal(ctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.baseline);
  const info = await unitInfo(target.service);
  assert.ok(info.command.includes(request.baseline), 'Effective service does not reference the pinned predecessor');
  const before = await queueSnapshot('before-stop'); let override; let stopped = false;
  try {
    override = await writeOverride(target.service, info.command.split(request.baseline).join(request.candidate),
      request.baseline + '/dist/server.js', request.expectedBaselineSha256, request.candidate);
    ctl(['daemon-reload']); assert.equal(ctl(['show', target.service, '-p', 'LoadState', '--value']), 'loaded');
    stopped = true; ctl(['stop', target.service]);
    await queueSnapshot('after-stop');
    ctl(['start', target.service]); assert.equal(ctl(['is-active', target.service]), 'active');
    const health = await readiness();
    assert.equal(ctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.candidate);
    const after = await queueSnapshot('after-start');
    const retained = new Set(after.items.map(item => item.id));
    assert.ok(before.items.filter(item => !['completed', 'failed', 'cancelled'].includes(item.status)).every(item => retained.has(item.id)), 'Pending queue records disappeared');
    return { id: request.id, installed: true, policy: 'owner-authorized interruption', ...health,
      queueBefore: before.counts, queueAfter: after.counts, nonterminalQueueIdsPreserved: true, fullPreStopQueueBackupPreserved: true,
      predecessorPreserved: true, sharedOwnerEnabled: false, credentialRotation: false,
      activeRelease: request.candidate, mainPid: Number(ctl(['show', target.service, '-p', 'MainPID', '--value'])) };
  } catch (error) {
    if (override) { await rename(override, override + '.rolled-back'); ctl(['daemon-reload']); }
    if (stopped) { ctl(['restart', target.service]); await readiness(); }
    throw error;
  }
}
async function activateMain() {
  const pm2 = '/root/.nvm/versions/node/v24.12.0/bin/pm2';
  const record = JSON.parse(run(pm2, ['jlist'])).find(item => item.name === 'code-ai-app');
  assert.ok(record && record.pm2_env.env);
  assert.ok(Number.isInteger(record.pid) && record.pid > 1);
  const previousEnv = { ...record.pm2_env.env,
    ...parseRuntimeEnvironment(await readFile('/proc/' + record.pid + '/environ')) };
  const currentEnv = { ...previousEnv, CODE_AI_AUTH_BASELINE_MODULE: request.baseline + '/dist/server.js',
    CODE_AI_AUTH_BASELINE_SHA256: request.expectedBaselineSha256, CODE_AI_CODEX_SHARED_OWNER_PROFILES: '' };
  currentEnv.CODE_AI_PM2_TARGET_MODULE = request.candidate + '/dist/server.js';
  await preserveRuntimeAuthentication({ ...currentEnv });
  const dist = '/root/projects/code-ai/dist'; assert.ok((await lstat(dist)).isSymbolicLink());
  const originalLink = await readlink(dist);
  const uploads = 'code-ai-upload-api.service'; const uploadInfo = await unitInfo(uploads);
  assert.ok(uploadInfo.command.includes(request.uploadBaselineModule));
  assert.equal(await digest(request.uploadBaselineModule), request.uploadBaselineSha256);
  const before = await queueSnapshot('before-stop'); let override; let stopped = false; let swapped = false;
  let step = 'write_upload_override';
  try {
    override = await writeOverride(uploads, uploadInfo.command.split(request.uploadBaselineModule).join(request.candidate + '/dist/server.js'),
      request.uploadBaselineModule, request.uploadBaselineSha256, '/root/projects/code-ai');
    ctl(['daemon-reload']); assert.equal(ctl(['show', uploads, '-p', 'LoadState', '--value']), 'loaded');
    step = 'stop_services'; stopped = true; ctl(['stop', uploads]); run(pm2, ['stop', 'code-ai-app']);
    await queueSnapshot('after-stop');
    step = 'switch_dist'; await symlink(request.candidate + '/dist', dist + '.immediate-' + request.buildId);
    await rename(dist + '.immediate-' + request.buildId, dist); swapped = true;
    step = 'start_main'; run(pm2, ['restart', 'code-ai-app', '--update-env'], currentEnv);
    step = 'verify_main'; await readiness();
    step = 'start_uploads'; ctl(['start', uploads]); assert.equal(ctl(['is-active', uploads]), 'active');
    step = 'verify_uploads'; await uploadReadiness();
    step = 'save_pm2'; run(pm2, ['save']);
    const after = await queueSnapshot('after-start'); const retained = new Set(after.items.map(item => item.id));
    assert.ok(before.items.filter(item => !['completed', 'failed', 'cancelled'].includes(item.status)).every(item => retained.has(item.id)), 'Pending queue records disappeared');
    return { id: 'main', installed: true, policy: 'owner-authorized interruption',
      activeRelease: request.candidate, uploadUpdated: true, sessionEndpointHealth: 200,
      queueBefore: before.counts, queueAfter: after.counts, nonterminalQueueIdsPreserved: true, fullPreStopQueueBackupPreserved: true,
      servedAssetHashesMatched: true, predecessorPreserved: true, credentialRotation: false, sharedOwnerEnabled: false };
  } catch (error) {
    error.activationStep = step;
    const rollbackEnv = { ...previousEnv, CODE_AI_PM2_TARGET_MODULE: request.baseline + '/dist/server.js' };
    error.rollback = await recoverMainTransaction({ swapped, override, stopped, actions: {
      restorePointer: async () => { await symlink(originalLink, dist + '.rollback-' + request.buildId); await rename(dist + '.rollback-' + request.buildId, dist); },
      restoreUploadOverride: async () => { await rename(override, override + '.rolled-back'); ctl(['daemon-reload']); },
      restartMain: () => run(pm2, ['restart', 'code-ai-app', '--update-env'], rollbackEnv),
      checkMainBaseline: () => readiness(request.baseline),
      savePm2: () => run(pm2, ['save']),
      restartUploads: () => ctl(['restart', uploads]),
      checkUploads: uploadReadiness,
    } });
    throw error;
  }
}
try {
  await verifyCandidate();
  if (phase === 'preflight') {
    if (target.service) { const info = await unitInfo(target.service); assert.ok(info.command.includes(request.baseline)); }
    console.log(JSON.stringify({ id: request.id, prepared: true, artifactFilesVerified: true, ownerAuthorizedInterruption: true }));
  } else if (phase === 'activate') {
    const receipt = await (request.id === 'main' ? activateMain() : activateRemote());
    receipt.buildId = request.buildId; receipt.finishedAt = new Date().toISOString();
    await writeFile(request.candidate + '/activation-receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } else throw fixedError('invalid_phase');
} catch (error) {
  const failure = { id: request.id, phase, installed: false,
    reason: /^[a-z_]{1,100}$/.test(error.reason || '') ? error.reason : 'transaction_failed',
    code: /^[A-Z_0-9]{1,40}$/.test(error.code || '') ? error.code : 'UNCLASSIFIED',
    ...(error.activationStep ? { activationStep: error.activationStep, rollback: error.rollback } : {}),
    finishedAt: new Date().toISOString() };
  await writeFile(request.candidate + '/activation-failure.json', JSON.stringify(failure, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify(failure)); process.exitCode = 1;
}
