import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import type { CodexRationalRun } from '../../../../shared/codexWorkModes';
import { releaseWorkModeHoldsForUser, stopQueueItemForUser } from './workModeOwnerActions';

const scope = { profileId: 'developer', sessionKey: 'session-one' };
const run = (extra = {}) => ({ runId: 'plan-one', profileId: scope.profileId, sessionKey: scope.sessionKey,
  enabled: true, status: 'incomplete', outcome: 'cancelled', finishedAt: 'now', holdReleasedAt: null,
  ...extra } as CodexRationalRun);
function transport(steps: unknown[]) {
  const calls: { url: string; method: string; body?: string }[] = [];
  return { calls, request: async <T>(url: string, init?: RequestInit): Promise<T> => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body as string | undefined });
    assert.ok(steps.length, 'Unexpected request ' + url);
    const next = steps.shift(); if (next instanceof Error) throw next; return next as T;
  }};
}
test('explicit stop waits for native cancellation and plan finalization before releasing just that plan', async () => {
  const stopping = { id: 'one', status: 'cancelling', workModeRunId: 'plan-one' };
  const stopped = { ...stopping, status: 'cancelled' };
  const io = transport([{ item: stopping }, { item: stopped }, { runs: [run({ finishedAt: null }), run({ runId: 'other' })] },
    { item: stopped }, { runs: [run(), run({ runId: 'other' })] }, { run: run({ holdReleasedAt: 'now' }) }]);
  const statuses: string[] = [];
  await stopQueueItemForUser(io.request, 'one', scope, item => statuses.push(item.status), { wait: async () => {} });
  assert.deepEqual(statuses, ['cancelling', 'cancelled', 'cancelled']);
  assert.equal(io.calls.filter(c => c.url.endsWith('/cancel')).length, 1);
  assert.deepEqual(io.calls.filter(c => c.method === 'POST').map(c => c.url),
    ['/api/codex/queue/items/one/cancel', '/api/codex/work-mode-runs/plan-one/release']);
  assert.deepEqual(JSON.parse(io.calls.at(-1)!.body!), scope);
});
test('unconfirmed cancellation remains pending, does not release or resend any input', async () => {
  const io = transport([{ item: { id: 'one', status: 'cancelling', workModeRunId: 'plan-one' } }]);
  await stopQueueItemForUser(io.request, 'one', scope, () => {}, { attempts: 0 });
  assert.equal(io.calls.length, 1);
});
test('ordinary stop with no plan never queries the work-mode API', async () => {
  const io = transport([{ item: { id: 'one', status: 'cancelled' } }]);
  await stopQueueItemForUser(io.request, 'one', scope, () => {});
  assert.equal(io.calls.length, 1);
});
test('wrong native item cannot release a plan', async () => {
  const io = transport([{ item: { id: 'other', status: 'cancelled', workModeRunId: 'plan-one' } }]);
  await assert.rejects(stopQueueItemForUser(io.request, 'one', scope, () => {}));
  assert.equal(io.calls.length, 1);
});
test('a failed rather than cancelled run is not silently acknowledged by the stop path', async () => {
  const io = transport([{ item: { id: 'one', status: 'cancelled', workModeRunId: 'plan-one' } }, { runs: [run({ outcome: 'failed' })] }]);
  await stopQueueItemForUser(io.request, 'one', scope, () => {});
  assert.equal(io.calls.filter(c => c.url.endsWith('/release')).length, 0);
});
test('explicit new input acknowledges finished expired and incomplete holds without changing their outcomes', async () => {
  const io = transport([{ runs: [run(), run({ runId: 'expired', status: 'expired' }), run({ runId: 'running', status: 'running', finishedAt: null })] }, {}, {}]);
  await releaseWorkModeHoldsForUser(io.request, scope);
  assert.deepEqual(io.calls.filter(c => c.method === 'POST').map(c => c.url),
    ['/api/codex/work-mode-runs/plan-one/release', '/api/codex/work-mode-runs/expired/release']);
  assert.ok(io.calls.slice(1).every(c => c.body === JSON.stringify(scope)));
});
test('new input waits for actual stop confirmation, not just deadline expiry', async () => {
  const io = transport([{ runs: [run({ status: 'expired', finishedAt: null })] }]);
  await assert.rejects(releaseWorkModeHoldsForUser(io.request, scope), /ההודעה לא נשלחה/);
  assert.equal(io.calls.length, 1);
});
test('already released, disabled and completed plans do not trigger extra writes', async () => {
  const io = transport([{ runs: [run({ holdReleasedAt: 'now' }), run({ enabled: false }), run({ status: 'completed' })] }]);
  await releaseWorkModeHoldsForUser(io.request, scope); assert.equal(io.calls.length, 1);
});
test('another profile and release errors fail closed before any new submission', async () => {
  const wrong = transport([{ runs: [run({ profileId: 'other' })] }]);
  await assert.rejects(releaseWorkModeHoldsForUser(wrong.request, scope)); assert.equal(wrong.calls.length, 1);
  const denied = transport([{ runs: [run()] }, new Error('Owner route denied')]);
  await assert.rejects(releaseWorkModeHoldsForUser(denied.request, scope), /denied/);
  assert.equal(denied.calls.length, 2);
});
test('actual app wires owner acknowledgement to send, continue, retry and stop, never drafts or polling', async () => {
  const app = await fs.readFile('client/src/components/codex/CodexMobileApp.tsx', 'utf8');
  assert.equal((app.match(/await releaseWorkModeHoldsForUser\(/g) || []).length, 3);
  assert.ok(app.includes('if (!saveAsDraft && currentProfile'));
  assert.equal((app.match(/await stopQueueItemForUser</g) || []).length, 1);
  const status = await fs.readFile('client/src/components/codex/WorkModeStatus.tsx', 'utf8');
  assert.ok(!status.includes('releaseWorkModeHoldsForUser'));
});
