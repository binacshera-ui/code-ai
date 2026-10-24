import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithDeploymentRetry } from './deploymentRetry';

const maintenance = () => Response.json({ code: 'CODE_AI_DEPLOYMENT_DRAIN', retryable: true },
  { status: 503, headers: { 'Retry-After': '2' } });
test('maintenance replays the exact idempotent request and succeeds after cutover', async () => {
  const init = { method: 'POST', body: JSON.stringify({ clientRequestId: 'stable', prompt: 'synthetic' }) };
  const calls: unknown[] = []; const delays: number[] = [];
  const result = await fetchWithDeploymentRetry(async (input, options) => {
    calls.push([input, options]); return calls.length < 3 ? maintenance() : Response.json({ accepted: true });
  }, '/api/codex/queue/items', init, { wait: async delay => { delays.push(delay); } });
  assert.equal(result.status, 200); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => (call as unknown[])[1] === init));
  assert.deepEqual(delays, [2000, 2000]);
});
test('never replays ambiguous network failures or general service errors', async () => {
  for (const response of [Response.json({ error: 'Unavailable' }, { status: 503 }),
    Response.json({ code: 'CODE_AI_DEPLOYMENT_DRAIN', retryable: false }, { status: 503 })]) {
    let count = 0;
    assert.equal(await fetchWithDeploymentRetry(async () => { count++; return response; }, '/api'), response);
    assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(fetchWithDeploymentRetry(async () => { count++; throw new TypeError('network failure'); }, '/api'));
  assert.equal(count, 1);
});
test('writes lacking idempotency and consumed request bodies are not retried', async () => {
  for (const init of [{ method: 'POST', body: '{"prompt":"synthetic"}' },
    { method: 'POST', body: new FormData() }, { method: 'DELETE' }]) {
    let count = 0;
    const result = await fetchWithDeploymentRetry(async () => { count++; return maintenance(); }, '/api', init);
    assert.equal(result.status, 503); assert.equal(count, 1);
  }
});
test('user cancellation interrupts retry delay without submitting again', async () => {
  const controller = new AbortController(); let count = 0;
  await assert.rejects(fetchWithDeploymentRetry(async () => { count++; return maintenance(); }, '/api',
    { signal: controller.signal }, { wait: async (_delay, signal) => { controller.abort(); signal?.throwIfAborted(); } }));
  assert.equal(count, 1);
});
test('retry budget expires with response intact, so composer text is retained', async () => {
  let count = 0;
  const response = await fetchWithDeploymentRetry(async () => { count++; return maintenance(); }, '/api', undefined,
    { maxWaitMs: 0 });
  assert.equal(response.status, 503); assert.equal(count, 1);
  assert.equal((await response.json()).code, 'CODE_AI_DEPLOYMENT_DRAIN');
});
