import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveManagedRecoveryBroker, recoverReservedQueuedInput } from './codexQueuedRecovery.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-recovery-broker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'code-ai-native-owner');
  await mkdir(directory, { mode: 0o700 });
  const active = path.join(root, 'active.mjs'), candidate = path.join(root, 'candidate.mjs');
  await writeFile(active, 'throw Error("must not execute during resolution")');
  await writeFile(candidate, 'throw Error("different application release")');
  const custody = { codexHome: path.join(root, '.codex'), profileId: 'fixture',
    nativeBinarySha256: digest('native'), brokerModuleSha256: digest('throw Error("must not execute during resolution")') };
  const plan = { format: 'code-ai-native-owner-profile', version: 1,
    ...custody, ownerDirectory: directory, brokerModule: active };
  const planFile = path.join(directory, 'profile-00000000-0000-0000-0000-000000000000.json');
  const savePlan = value => writeFile(planFile, JSON.stringify(value), { mode: 0o600 });
  return { directory, custody, brokerModule: candidate, active, candidate, plan, planFile, savePlan };
}

test('matching application broker requires no profile plan', async t => {
  const f = await fixture(t);
  assert.equal(await resolveManagedRecoveryBroker({ ...f, brokerModule: f.active }), f.active);
});

test('newer app recovers the existing queued input through the active pinned predecessor', async t => {
  const f = await fixture(t);
  await f.savePlan(f.plan);
  assert.equal(await resolveManagedRecoveryBroker(f), f.active);
  const target = { threadId: 'thread', queuedSubmissionId: 'queued', clientUserMessageId: 'own' };
  const requested = { model: 'mock', effort: 'medium', cwd: '/fixture',
    approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  const calls = [];
  const result = await recoverReservedQueuedInput({ ...target,
    readReservation: async () => ({ threadId: 'thread', queuedId: 'queued', clientId: 'own',
      phase: 'queued', turnId: null, turnComplete: false, requested }),
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } };
      if (method === 'thread/queue/list') return { data: [{ id: 'queued', clientUserMessageId: 'own' }] };
      if (method === 'thread/resume') return { ...requested, reasoningEffort: requested.effort, sandbox: requested.sandboxPolicy };
      assert.equal(method, 'thread/queue/start');
      assert.deepEqual(params, { threadId: 'thread', queuedSubmissionId: 'queued' });
      return {};
    },
  });
  assert.equal(result, 'start-requested');
  assert.deepEqual(calls.map(([method]) => method), ['thread/read', 'thread/queue/list', 'thread/resume', 'thread/queue/start']);
});

test('missing predecessor, modified bytes and a claimed hash cannot authorize recovery', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveManagedRecoveryBroker(f), /version mismatch/);
  await f.savePlan({ ...f.plan, brokerModule: f.candidate });
  await assert.rejects(resolveManagedRecoveryBroker(f), /version mismatch/);
  await f.savePlan(f.plan);
  await writeFile(f.active, 'modified');
  await assert.rejects(resolveManagedRecoveryBroker(f), /version mismatch/);
});

test('foreign profile, home, owner directory, native binary and hash plans are ignored', async t => {
  const f = await fixture(t);
  for (const [key, value] of Object.entries({ profileId: 'foreign', codexHome: '/foreign',
    ownerDirectory: '/foreign', nativeBinarySha256: digest('foreign'), brokerModuleSha256: digest('foreign'), version: 2 })) {
    await f.savePlan({ ...f.plan, [key]: value });
    await assert.rejects(resolveManagedRecoveryBroker(f), /version mismatch/, key);
  }
});

test('public or symbolic-link profile metadata cannot supply a recovery module', async t => {
  const f = await fixture(t);
  await f.savePlan(f.plan);
  await chmod(f.planFile, 0o644);
  await assert.rejects(resolveManagedRecoveryBroker(f), /Private owner metadata/);
  await rm(f.planFile);
  const external = path.join(f.directory, 'external.json');
  await writeFile(external, JSON.stringify(f.plan), { mode: 0o600 });
  await symlink(external, f.planFile);
  await assert.rejects(resolveManagedRecoveryBroker(f), /Private owner metadata/);
});

test('public owner directory and malformed active hash fail closed', async t => {
  const f = await fixture(t);
  await f.savePlan(f.plan);
  await assert.rejects(resolveManagedRecoveryBroker({ ...f, custody: { ...f.custody, brokerModuleSha256: 'unknown' } }), /version unavailable/);
  await chmod(f.directory, 0o755);
  await assert.rejects(resolveManagedRecoveryBroker(f), /Private owner directory/);
});
