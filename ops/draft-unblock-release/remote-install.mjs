import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, rename, mkdir, statfs, chmod, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const [phase, requestFile] = process.argv.slice(2);
const request = JSON.parse(await readFile(requestFile, 'utf8'));
const allowed = {
  'beam-10g': { service: 'code-ai-remote-beam-10g.service', root: '/opt/code-ai-releases/' },
  pci: { service: 'code-ai-remote-pci.service', root: '/opt/code-ai-releases/' },
  'ubuntu-gpu-lab': { service: 'code-ai-ubuntu-agent.service', root: '/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/', user: true },
};
const target = allowed[request.id];
assert.ok(target, 'Unknown deployment target');
for (const key of ['baseline', 'candidate']) {
  assert.ok(request[key].startsWith(target.root) && !request[key].includes('..'), 'Release path out of scope');
}
assert.notEqual(request.baseline, request.candidate);
assert.match(request.candidate, /draft-unblock-[a-f0-9-]{36}$/);
assert.match(request.expectedBaselineSha256, /^[a-f0-9]{64}$/);
assert.match(request.expectedCandidateSha256, /^[a-f0-9]{64}$/);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }).trim();
const systemctl = args => run('systemctl', [...(target.user ? ['--user'] : []), ...args]);
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = async filename => digest(await readFile(filename));
async function serviceOverride() {
  const unitFile = systemctl(['show', target.service, '-p', 'FragmentPath', '--value']);
  const text = systemctl(['cat', target.service]);
  let serviceSection = false;
  let commands = [];
  for (const line of text.split('\n')) {
    if (/^\[.*\]$/.test(line.trim())) serviceSection = line.trim() === '[Service]';
    if (!serviceSection || !/^\s*ExecStart=/.test(line)) continue;
    const command = line.slice(line.indexOf('=') + 1).trim();
    assert.ok(!command.endsWith('\\'), 'Multiline service command requires explicit qualification');
    if (command) commands.push(command); else commands = [];
  }
  assert.equal(commands.length, 1, 'Service must have one effective start command');
  assert.ok(commands[0].includes(request.baseline), 'Effective start command does not name accepted release');
  const override = unitFile + '.d/zzzz-code-ai-draft-unblock.conf';
  assert.equal(await lstat(override).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false,
    'Draft release override already exists');
  return { override, text: '[Service]\nWorkingDirectory=' + request.candidate + '\nExecStart=\nExecStart=' +
    commands[0].split(request.baseline).join(request.candidate) + '\n' };
}
const queue = async () => {
  let items = [];
  try { items = JSON.parse(await readFile(request.queueFile, 'utf8')).items; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { items, active: items.filter(item => ['running', 'cancelling', 'queued', 'scheduled'].includes(item.status)) };
};
async function token() {
  if (request.pairingFile) return JSON.parse(await readFile(request.pairingFile, 'utf8')).token;
  return parseEnv(await readFile(request.environmentFile, 'utf8')).CODEX_REMOTE_AGENT_TOKEN;
}
async function health() {
  const secret = await token();
  assert.ok(typeof secret === 'string' && secret.length > 0, 'Remote authentication unavailable');
  const url = 'http://127.0.0.1:4010/api/codex/remote-agent/health';
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { 'x-code-ai-remote-token': secret }, signal: AbortSignal.timeout(1500) });
      if (response.status === 200 && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.json();
        assert.ok(body.ok); ready = true; break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Remote readiness failed');
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(2000) })).status, 401, 'Remote authentication policy changed');
}

async function install() {
if (phase === 'prepare') {
  assert.equal(systemctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.baseline);
  await serviceOverride();
  assert.equal(await sha(request.baseline + '/dist/server.js'), request.expectedBaselineSha256);
  const space = await statfs(request.baseline);
  assert.ok(space.bavail * space.bsize > Math.max(space.blocks * space.bsize * 0.15, 100_000_000_000) + 16_000_000, 'Storage reserve failed');
  assert.equal(await sha(request.patchFile), request.expectedCandidateSha256);
  const exists = await lstat(request.candidate).then(() => true,
    error => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) run('cp', ['-al', request.baseline, request.candidate]);
  else assert.equal(await sha(request.candidate + '/dist/server.js'), request.expectedBaselineSha256,
    'Existing preparation directory is not an untouched baseline');
  const sourceDirectory = await lstat(request.baseline + '/dist');
  const candidateDirectory = await lstat(request.candidate + '/dist');
  assert.ok(candidateDirectory.isDirectory() && !candidateDirectory.isSymbolicLink());
  assert.ok(candidateDirectory.dev !== sourceDirectory.dev || candidateDirectory.ino !== sourceDirectory.ino,
    'Candidate directory shares the installed inode');
  // cp -al preserves immutable directory modes. Change only the new directory,
  // never a hard-linked file or the installed release, and restore its mode.
  await chmod(request.candidate + '/dist', (candidateDirectory.mode & 0o777) | 0o200);
  try {
    await copyFile(request.patchFile, request.candidate + '/dist/server.js.next', 1 /* COPYFILE_EXCL */);
    await chmod(request.candidate + '/dist/server.js.next', 0o644);
    await rename(request.candidate + '/dist/server.js.next', request.candidate + '/dist/server.js');
  } finally {
    await chmod(request.candidate + '/dist', candidateDirectory.mode & 0o777);
  }
  assert.equal(await sha(request.baseline + '/dist/server.js'), request.expectedBaselineSha256, 'Active binary was modified');
  run(process.execPath, ['--check', request.candidate + '/dist/server.js']);
  execFileSync(process.execPath, [request.smokeFile], { cwd: request.candidate, stdio: 'pipe', timeout: 60_000 });
  await writeFile(request.candidate + '/draft-unblock-prepared.json', JSON.stringify({
    id: request.id, baselineSha256: request.expectedBaselineSha256,
    candidateSha256: request.expectedCandidateSha256, isolatedHttpSmokePassed: true,
  }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ id: request.id, prepared: true, isolatedHttpSmokePassed: true }));
} else if (phase === 'preflight') {
  assert.equal(systemctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.baseline);
  await serviceOverride();
  console.log(JSON.stringify({ id: request.id, effectiveServiceCommandQualified: true }));
} else if (phase === 'activate') {
  assert.equal(await sha(request.baseline + '/dist/server.js'), request.expectedBaselineSha256);
  assert.equal(await sha(request.candidate + '/dist/server.js'), request.expectedCandidateSha256);
  assert.equal(systemctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.baseline);
  const before = await queue();
  assert.equal(before.active.length, 0, 'New work arrived; activation deferred');
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal((await queue()).active.length, 0, 'New work arrived; activation deferred');
  const pid = systemctl(['show', target.service, '-p', 'MainPID', '--value']);
  const children = spawnSync('ps', ['--ppid', pid, '-o', 'comm='], { encoding: 'utf8' });
  assert.ok(children.status === 0 || children.status === 1, 'Service child inspection failed');
  assert.equal(children.stdout.trim(), '', 'Service has active child processes');
  const { override, text } = await serviceOverride();
  let switched = false;
  let configured = false;
  try {
    await mkdir(override.slice(0, override.lastIndexOf('/')), { recursive: true });
    await writeFile(override, text, { mode: 0o600, flag: 'wx' }); configured = true;
    systemctl(['daemon-reload']);
    assert.equal(systemctl(['show', target.service, '-p', 'LoadState', '--value']), 'loaded');
    assert.equal(systemctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.candidate);
    assert.ok(systemctl(['show', target.service, '-p', 'ExecStart', '--value']).includes(request.candidate),
      'Candidate start command was not loaded');
    assert.equal((await queue()).active.length, 0, 'New work arrived; activation deferred');
    systemctl(['restart', target.service]); switched = true;
    assert.equal(systemctl(['is-active', target.service]), 'active');
    assert.equal(systemctl(['show', target.service, '-p', 'WorkingDirectory', '--value']), request.candidate);
    await health();
    const after = await queue();
    assert.equal(after.active.length, 0);
    const drafts = items => items.filter(item => item.status === 'draft').map(item => JSON.stringify(item)).sort();
    assert.deepEqual(drafts(after.items), drafts(before.items), 'Saved drafts changed');
    console.log(JSON.stringify({ id: request.id, activated: true, authenticatedHealth: 200,
      unauthenticatedHealth: 401, activeQueueItems: 0, draftsPreserved: true,
      baselinePreserved: (await sha(request.baseline + '/dist/server.js')) === request.expectedBaselineSha256 }));
  } catch (error) {
    if (configured) {
      await rename(override, override + '.rolled-back-' + request.buildId);
      systemctl(['daemon-reload']);
    }
    if (switched) { systemctl(['restart', target.service]); await health(); }
    throw error;
  }
} else throw new Error('Unknown installation phase');
}
try { await install(); }
catch (error) {
  // Subprocess stderr and assertion values can contain private runtime data.
  console.error(JSON.stringify({ id: request.id, phase, failed: true,
    reason: String(error.message || 'Installation failed').split('\n')[0] }));
  process.exitCode = 1;
}
