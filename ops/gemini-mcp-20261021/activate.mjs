/** Uses the existing one-use native-owner broker handoff. No native writer,
 * backend, credentials, history, lock file or remote host is restarted/removed. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ops = '/root/projects/code-ai/ops/gemini-mcp-20261021';
const staged = JSON.parse(await fs.readFile(ops + '/staged.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const ctl = args => execFileSync('/usr/bin/systemctl', args, { encoding: 'utf8', timeout: 20000, stdio: 'pipe' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const generation = async pid => {
  const s = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
};
async function atomicOwned(file, bytes) {
  const stat = await fs.stat(file), temporary = file + '.gemini-mcp-next';
  await fs.writeFile(temporary, bytes, { mode: stat.mode & 0o777, flag: 'wx' });
  await fs.chown(temporary, stat.uid, stat.gid); await fs.rename(temporary, file);
}
const receipt = { format: 'code-ai-gemini-mcp-custody-activation', version: 1,
  scope: staged.scope, candidate: staged.candidate, brokerSha256: staged.brokerSha256,
  startedAt: new Date().toISOString(), complete: false, profiles: [],
  backendRestarted: false, nativeWritersRestarted: false, historyDeleted: false, otherServersModified: false };
const save = () => fs.writeFile(ops + '/activation.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const backup = staged.candidate + '/private-handoff-backup';
await fs.mkdir(backup, { mode: 0o700 });
try {
  for (const [file, digest] of Object.entries(staged.files)) assert.equal(hash(await fs.readFile(staged.candidate + '/' + file)), digest);
  // Validate both predecessors before any mutation; refuse stale source lineage.
  for (const p of staged.profiles) assert.equal(hash(await fs.readFile(p.planFile)), p.planSha256);
  await save();
  for (const p of staged.profiles) {
    const unit = 'code-ai-native-owner-' + p.id + '.service';
    assert.equal(ctl(['is-active', unit]), 'active');
    const beforeBytes = await fs.readFile(p.directory + '/ownership.json'), before = JSON.parse(beforeBytes);
    assert.equal(before.brokerModuleSha256, p.plan.brokerModuleSha256);
    assert.equal(await generation(before.runnerPid), before.runnerIdentity.startTime);
    assert.equal(await generation(before.nativePid), before.nativeIdentity.startTime);
    assert.equal(hash(await fs.readFile(p.plan.runnerModule)), p.runnerSha256);
    const lockInode = (await fs.lstat(p.directory + '/owner.lock')).ino;
    const engineInode = (await fs.lstat(p.directory + '/engine.sock')).ino;
    const ticket = p.directory + '/broker-handoff.json';
    assert.equal(await fs.lstat(ticket).then(() => true, () => false), false);
    const entry = { profileId: p.id, nativePid: before.nativePid, nativeGeneration: before.nativeIdentity.startTime, phase: 'prepared' };
    receipt.profiles.push(entry); await save();
    await fs.copyFile(p.planFile, backup + '/' + p.id + '-plan.json');
    await fs.copyFile(p.directory + '/ownership.json', backup + '/' + p.id + '-custody.json');
    await fs.copyFile(p.directory + '/broker-journal.json', backup + '/' + p.id + '-journal.json');
    const dropinDir = '/etc/systemd/system/' + unit + '.d';
    const dropin = dropinDir + '/99-gemini-mcp-custody.conf';
    assert.equal(await fs.lstat(dropin).then(() => true, () => false), false);
    await fs.mkdir(dropinDir, { recursive: true });
    await fs.writeFile(dropin, '[Service]\nKillMode=process\nRestart=no\n', { mode: 0o644 });
    ctl(['daemon-reload']);
    assert.equal(ctl(['show', unit, '-p', 'KillMode', '--value']), 'process');
    assert.equal(ctl(['show', unit, '-p', 'Restart', '--value']), 'no');
    await fs.writeFile(ticket, JSON.stringify({ format: 'code-ai-broker-handoff', version: 1,
      custodySha256: hash(beforeBytes), brokerModuleSha256: staged.brokerSha256,
      runnerModuleSha256: p.runnerSha256 }), { mode: 0o600, flag: 'wx' });
    const next = { ...p.plan, brokerModule: staged.candidate + '/server/codexSharedOwnerBroker.mjs', brokerModuleSha256: staged.brokerSha256 };
    // Only the recorded adapter/lock-holder. The existing native PID and all
    // its tool children deliberately remain in the original service cgroup.
    assert.equal(await generation(before.runnerPid), before.runnerIdentity.startTime);
    process.kill(before.runnerPid, 'SIGKILL');
    let deadline = Date.now() + 15000;
    while (Number(ctl(['show', unit, '-p', 'MainPID', '--value']))) {
      if (Date.now() > deadline) throw Error('Recorded adapter did not exit');
      await sleep(100);
    }
    assert.equal(await generation(before.nativePid), before.nativeIdentity.startTime);
    await atomicOwned(p.planFile, JSON.stringify(next, null, 2) + '\n');
    ctl(['start', unit]);
    deadline = Date.now() + 45000;
    while (true) {
      const observed = await json(p.directory + '/ownership.json');
      const ready = await json(p.directory + '/ready.json').catch(() => ({}));
      assert.equal(observed.nativePid, before.nativePid);
      assert.equal(await generation(before.nativePid), before.nativeIdentity.startTime);
      if (observed.brokerModuleSha256 === staged.brokerSha256 && ready.brokerModuleSha256 === staged.brokerSha256 && ctl(['is-active', unit]) === 'active') {
        assert.notEqual(observed.runnerPid, before.runnerPid); break;
      }
      if (Date.now() > deadline) throw Error('Existing native writer adoption readiness timed out');
      await sleep(100);
    }
    assert.equal((await fs.lstat(p.directory + '/owner.lock')).ino, lockInode);
    assert.equal((await fs.lstat(p.directory + '/engine.sock')).ino, engineInode);
    assert.equal(await fs.lstat(ticket).then(() => true, () => false), false);
    await fs.writeFile(dropin, '[Service]\nKillMode=control-group\nRestart=on-failure\n', { mode: 0o644 });
    ctl(['daemon-reload']);
    assert.equal(ctl(['show', unit, '-p', 'KillMode', '--value']), 'control-group');
    Object.assign(entry, { phase: 'ready', nativeWriterPreserved: true, lockAndEnginePreserved: true });
    await save();
  }
  receipt.complete = true; receipt.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.failure = { errorClass: error.name, message: String(error.message).slice(0, 500) };
  await save(); throw error;
}
