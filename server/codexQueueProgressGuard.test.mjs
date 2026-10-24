import assert from 'node:assert/strict';
import test from 'node:test';
import { claimQueueProgressGuard } from './codexQueueProgressGuard.mjs';
const warning = { kind: 'repeated_failure', turnId: 'turn-1', fingerprint: 'a'.repeat(64), count: 3 };
const item = () => ({ status: 'running', nativeSubmission: { deliveryPhase: 'running', turnId: 'turn-1' } });
test('claim is durable before steering and concurrent/reconnected claims are denied', async () => {
  const row = item(); let writes = 0;
  const persist = async () => { writes++; await Promise.resolve(); };
  assert.deepEqual(await Promise.all([claimQueueProgressGuard(row, warning, persist), claimQueueProgressGuard(row, warning, persist)]), [true, false]);
  assert.equal(writes, 1);
  assert.equal(await claimQueueProgressGuard(JSON.parse(JSON.stringify(row)), warning, persist), false);
  assert.equal(JSON.stringify(row).includes('command'), false);
});
test('persist failure cannot send or cause a second attempt', async () => {
  const row = item();
  assert.equal(await claimQueueProgressGuard(row, warning, async () => { throw Error('disk'); }), false);
  assert.equal(await claimQueueProgressGuard(row, warning, async () => {}), false);
});
test('non-shared native adapter can claim its proven turn without shared submission metadata', async () => {
  const row = { status: 'running' };
  assert.equal(await claimQueueProgressGuard(row, warning, async () => {}), true);
  assert.equal(await claimQueueProgressGuard(row, warning, async () => {}), false);
});
test('foreign turn, cancellation, terminal or uncertain custody cannot claim', async () => {
  for (const row of [ { ...item(), status: 'failed' }, { ...item(), nativeCancellationRequestedAt: 'now' },
    { ...item(), nativeSubmission: { deliveryPhase: 'queued', turnId: 'turn-1' } },
    { ...item(), nativeSubmission: { deliveryPhase: 'running', turnId: 'other' } } ]) {
    assert.equal(await claimQueueProgressGuard(row, warning, async () => { assert.fail('persist'); }), false);
  }
});
