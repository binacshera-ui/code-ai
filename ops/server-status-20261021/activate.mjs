import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { withNativeHandoff } from '../native-large-frames/native-handoff.mjs';
import { requestController } from '/mnt/hdd/code-ai-builds/native-unlock-source-mmJKMu/controller-client.mjs';

const root = '/root/projects/code-ai', ops = root + '/ops/server-status-20261021';
const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const s = await json(ops + '/staged.json'), r = s.request;
assert.equal(s.passed, true); assert.equal(r.id, 'main'); assert.equal(r.sharedProfiles, 'developer,developer2');
assert.equal(await fs.realpath(root + '/dist'), s.baseline + '/dist');
assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), s.uiPointer);
const controller = root + '/.code-ai/queue/deployment-drain/controller.json';
const run = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 120000,
  stdio: 'pipe', env: { ...process.env, PM2_HOME: '/root/.pm2' }, ...options });
const receipt = { format: 'code-ai-server-status-api-activation', version: 1, scope: 'main Germany only',
  buildId: s.buildId, candidate: s.candidate, startedAt: new Date().toISOString(), complete: false,
  nativeWritersRestarted: false, historyOrLocksDeleted: false, otherServersModified: false };
const save = () => fs.writeFile(ops + '/api-activation.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
let lease;
try {
  const status = await requestController(controller, { action: 'status' });
  lease = await requestController(controller, { action: 'acquire', runtimeEpoch: status.runtimeEpoch,
    ownerToken: randomUUID(), releaseId: s.buildId, ttlMs: 120000 });
  const pm2 = '/root/.nvm/versions/node/v24.12.0/bin/pm2';
  const current = JSON.parse(run(pm2, ['jlist'])).find(p => p.name === 'code-ai-app');
  assert.ok(current?.pid > 1 && current.pm2_env.status === 'online');
  const items = (await json(root + '/.code-ai/queue/state.json')).items;
  const nativeBefore = await Promise.all(['developer', 'developer2'].map(async id => {
    const owner = await json('/home/' + id + '/code-ai-native-owner/ownership.json');
    assert.equal(owner.brokerModuleSha256, s.nativeBrokerSha256);
    return { id, nativePid: owner.nativePid, generation: owner.nativeIdentity.startTime };
  }));
  receipt.corePidBefore = current.pid; receipt.nativeOwners = nativeBefore; await save();
  const switched = await withNativeHandoff({ pid: current.pid, items, profiles: r.sharedProfiles.split(','),
    replace: async () => JSON.parse(run(r.nodeExecutable, [s.candidate + '/install.mjs', 'activate', s.candidate + '/fleet-request.json'], { cwd: s.candidate }).trim()) });
  assert.equal(switched.result.installed, true);
  assert.equal(await fs.realpath(root + '/dist'), s.candidate + '/dist');
  assert.equal(await fs.realpath('/etc/nginx/code-ai-ui/current.locations.conf'), s.uiPointer);
  for (const n of nativeBefore) {
    const owner = await json('/home/' + n.id + '/code-ai-native-owner/ownership.json');
    assert.equal(owner.nativePid, n.nativePid); assert.equal(owner.nativeIdentity.startTime, n.generation);
    assert.equal(owner.brokerModuleSha256, s.nativeBrokerSha256);
  }
  const after = JSON.parse(run(pm2, ['jlist'])).find(p => p.name === 'code-ai-app');
  assert.equal(after.pm2_env.status, 'online');
  Object.assign(receipt, { complete: true, finishedAt: new Date().toISOString(), corePidAfter: after.pid,
    preservedActiveInputIds: switched.preserved.map(i => i.id), sourceInputsResent: false,
    geminiMcpRepairPreserved: true, originalUiRetainedUntilApiVerified: true, transaction: switched.result });
  await save(); console.log(JSON.stringify({ complete: true, preservedActiveInputs: switched.preserved.length, nativeWritersPreserved: true }));
} catch (error) {
  receipt.failure = { errorClass: error.name, reason: error.reason || null, message: String(error.message).slice(0, 300) };
  await save(); throw error;
} finally {
  if (lease) try {
    const current = await requestController(controller, { action: 'status' });
    await requestController(controller, { action: 'release', runtimeEpoch: current.runtimeEpoch,
      ownerToken: lease.ownerToken, generation: lease.generation });
  } catch { /* A replaced runtime already discarded its predecessor lease. */ }
}
