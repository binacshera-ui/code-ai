import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInteractiveFixture } from '../codex-interactive-release/api-smoke.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function privateControl(pointer, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pointer.socketPath);
    let received = '';
    socket.setTimeout(3_000, () => socket.destroy(new Error('Isolated drain controller timed out')));
    socket.once('error', () => reject(new Error('Isolated drain controller unavailable')));
    socket.once('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { received += chunk.toString('utf8'); });
    socket.once('end', () => {
      try {
        const reply = JSON.parse(received);
        if (!reply.ok) throw Object.assign(new Error('Isolated drain controller refused the request'), {
          reason: reply.reason || 'unknown_request',
        });
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
  });
}

/** Compiled application audit, never an installed queue/home or cutover proof.
 * Reuses the existing marked-home fake Codex so the real API, queue, runner,
 * questions and durable state execute together with zero inference/accounts.
 * The app-owned HTTP lifecycle guard MUST refuse a seal; route-only tests must
 * not be promoted to middleware/external-store or production continuity proof.
 */
export async function smoke({ appRoot, fakeCodex }) {
  const compiled = path.join(path.resolve(appRoot), 'dist', 'server.js');
  let installed;
  try { installed = await realpath('/root/projects/code-ai/dist/server.js'); } catch {}
  assert.notEqual(await realpath(compiled), installed, 'Refusing to run qualification against the installed application');
  const fixture = await createInteractiveFixture(compiled, fakeCodex, { timeoutMs: 90_000 });
  const checks = [];
  let pointer;
  let lease;
  const ownerToken = randomUUID();
  const stateFile = path.join(fixture.storage, 'queue', 'state.json');
  const pointerFile = path.join(fixture.storage, 'queue', 'deployment-drain', 'controller.json');
  const control = input => privateControl(pointer, input);
  const queueInput = key => ({
    profileId: fixture.profileId, cwd: fixture.cwd,
    queueKey: key, clientRequestId: randomUUID(),
    prompt: 'Synthetic deployment-drain qualification; no model or real credentials.',
  });

  async function waitActive(itemId) {
    return fixture.poll(async () => {
      const reply = await fixture.request(`/api/codex/queue/items/${itemId}?includeSession=false`);
      if (['failed', 'cancelled'].includes(reply.item.status)) throw new Error('Isolated queue run did not preserve normal execution');
      return reply.item.status === 'running' && reply.item.sessionId ? reply.item : false;
    });
  }

  async function finishSyntheticRun(itemId) {
    const running = await waitActive(itemId);
    const inputRoute = `/api/codex/sessions/${running.sessionId}/user-input`;
    for (const [questionId, answer] of [['destination', 'Local (Recommended)'], ['note', 'Drain fixture answer']]) {
      const question = await fixture.poll(async () => {
        const reply = await fixture.request(`${inputRoute}?profile=${fixture.profileId}`);
        return reply.requests.find(item => item.status === 'pending' && item.questions[0]?.id === questionId) || false;
      });
      await fixture.request(`${inputRoute}/${question.id}/answer`, 'POST', {
        profileId: fixture.profileId, answers: { [questionId]: { answers: [answer] } },
      });
    }
    return fixture.poll(async () => {
      const reply = await fixture.request(`/api/codex/queue/items/${itemId}?includeSession=false`);
      assert.notEqual(reply.item.status, 'cancelled', 'Drain must never cancel admitted work');
      assert.notEqual(reply.item.status, 'failed', 'Drain must never fail admitted work');
      return reply.item.status === 'completed' ? reply.item : false;
    });
  }

  async function waitKnownParticipantsIdle() {
    return fixture.poll(async () => {
      const observed = await control({ action: 'status' });
      const known = ['queue', 'agent', 'terminal', 'native-codex', 'http-writes', 'http-peers'];
      return observed.activeAdmissions === 0 && known.every(name => {
        const participant = observed.participants[name];
        return participant?.ready && participant.active === 0 && !participant.inFlight && !participant.persisting;
      }) ? observed : false;
    });
  }

  async function acquire(ttlMs = 30_000) {
    const status = await control({ action: 'status' });
    lease = await control({
      action: 'acquire', runtimeEpoch: status.runtimeEpoch,
      ownerToken, releaseId: 'isolated-full-app-drain-fixture', ttlMs,
    });
    return lease;
  }

  const leaseRequest = (action, ttlMs = 30_000) => ({
    action, runtimeEpoch: lease.runtimeEpoch, ownerToken,
    generation: lease.generation, ttlMs,
  });

  try {
    await fixture.start();
    await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
    pointer = await fixture.poll(async () => {
      try {
        const value = JSON.parse(await readFile(pointerFile, 'utf8'));
        assert.ok(value.socketPath.startsWith(path.dirname(pointerFile) + path.sep));
        return value;
      } catch { return false; }
    });
    const initial = await control({ action: 'status' });
    assert.equal(initial.coverageReady, false);
    assert.equal(initial.drained, false);
    assert.equal(initial.httpIngressDrainProven, false);
    assert.equal(initial.admissionClosed, false, 'Unqualified coverage alone must not freeze normal work');
    assert.deepEqual(initial.participants['app-http-lifecycle'], {
      ready: false, active: 0, inFlight: 0, persisting: false, reason: 'http_lifecycle_unqualified',
    });
    checks.push('compiled application mandatory HTTP lifecycle guard refuses qualification without blocking normal work');

    const firstInput = queueInput('first-admitted');
    const first = (await fixture.request('/api/codex/queue/items', 'POST', firstInput, 202)).item;
    await waitActive(first.id);
    await acquire();
    assert.equal(lease.drained, false);
    assert.equal(lease.admissionClosed, true);
    const secondInput = queueInput('queued-during-drain');
    const second = (await fixture.request('/api/codex/queue/items', 'POST', secondInput, 202)).item;
    const scheduledInput = { ...queueInput('preserved-future-job'), scheduledAt: '2099-01-01T00:00:00.000Z' };
    const scheduled = (await fixture.request('/api/codex/queue/items', 'POST', scheduledInput, 202)).item;
    await sleep(1_800); // At least one real worker poll must observe the fence.
    const held = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(held.items.find(item => item.id === second.id).status, 'queued');
    assert.equal(held.items.find(item => item.id === second.id).attempts, 0);
    assert.equal(held.items.find(item => item.id === scheduled.id).status, 'scheduled');
    assert.equal(JSON.parse(await readFile(path.join(fixture.home, '.fixture-audit.json'), 'utf8')).turnStartCount, 1);
    checks.push('real queue accepts/persists new messages and future jobs without starting another native turn');

    await finishSyntheticRun(first.id);
    const knownIdle = await waitKnownParticipantsIdle();
    assert.equal(knownIdle.coverageReady, false);
    assert.equal(knownIdle.drained, false);
    assert.equal(knownIdle.httpIngressDrainProven, false);
    await assert.rejects(control(leaseRequest('seal', 120_000)), { reason: 'runtime_not_drained' });
    const refusedSeal = await control({ action: 'status' });
    assert.equal(refusedSeal.phase, 'draining');
    assert.equal(refusedSeal.sealId, null);
    assert.equal(refusedSeal.runtimeEpoch, pointer.runtimeEpoch);
    await fixture.request('/api/codex/queue/items');
    await fixture.request('/api/codex/remote-agent/health');
    const heldState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(heldState.items.length, 3);
    assert.equal(heldState.items.find(item => item.id === first.id).status, 'completed');
    assert.equal(heldState.items.find(item => item.id === scheduled.id).scheduledAt, scheduledInput.scheduledAt);
    assert.equal(JSON.parse(await readFile(path.join(fixture.home, '.fixture-audit.json'), 'utf8')).turnStartCount, 1);
    checks.push('known participants become idle but unqualified middleware/store coverage still refuses seal; no process replacement');

    await control(leaseRequest('release'));
    const secondCompleted = await finishSyntheticRun(second.id);
    assert.equal(secondCompleted.attempts, 1);
    const duplicate = await fixture.request('/api/codex/queue/items', 'POST', secondInput, 202);
    assert.equal(duplicate.item.id, second.id);
    assert.equal(duplicate.item.attempts, 1);
    checks.push('release resumes original queued item exactly once; same request identity remains idempotent');

    await acquire(5_000);
    const afterExpiry = (await fixture.request('/api/codex/queue/items', 'POST', queueInput('after-lease-expiry'), 202)).item;
    assert.equal(afterExpiry.attempts, 0);
    await finishSyntheticRun(afterExpiry.id); // Cannot begin until bounded lease actually expires.
    const final = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(final.items.length, 4);
    assert.equal(final.items.find(item => item.id === scheduled.id).status, 'scheduled');
    assert.equal(final.items.find(item => item.id === scheduled.id).attempts, 0);
    assert.ok(final.items.filter(item => item.id !== scheduled.id).every(item => item.status === 'completed' && item.attempts === 1));
    const audit = JSON.parse(await readFile(path.join(fixture.home, '.fixture-audit.json'), 'utf8'));
    assert.equal(audit.turnStartCount, 3);
    assert.equal(audit.answerCount, 6);
    checks.push('real lease expiry resumes safely; every accepted question/job persists; no cancellation or duplicate turn');
    return {
      ok: true, checks, syntheticTurns: audit.turnStartCount, scheduledJobsPreserved: 1,
      realModelTurns: 0, realAccounts: false, productionEffects: false,
      liveActivationQualified: false,
      futureRuntimeRestartQualified: false,
      compiledLifecycleGuardVerified: true,
      processReplacementTested: false,
      limitation: 'App HTTP middleware, session-store and external settlement remain unqualified and block seal; installed legacy bootstrap is also unproved.',
    };
  } finally {
    await fixture.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('An explicit isolated compiled candidate path is required');
    const compiled = path.resolve(process.argv[2]);
    console.log(JSON.stringify(await smoke({ appRoot: path.dirname(path.dirname(compiled)), fakeCodex: process.argv[3] })));
  } catch (error) {
    // No captured process output, request payloads, synthetic cookies or keys.
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Isolated deployment drain smoke failed' }));
    process.exitCode = 1;
  }
}
