import assert from 'node:assert/strict';
import test from 'node:test';
import { createIncidentRemoteWake, type IncidentWakeResult } from './incidentRemoteWake.js';

const token = 'remote-test-token-that-must-never-escape';
const endpoint = { hostname: '127.0.0.1', port: 19223, token };
const task = { caseId: 'icase_remote_1', taskType: 'execute_decision', idempotencyKey: 'wake:decision_1', decisionId: 'decision_1' };
const result: IncidentWakeResult = {
  queue_item_id: 'queue_remote_1', queue_status: 'queued', session_id: 'remote-session',
  profile_id: 'developer', context_file_path: '/remote/context/case.json',
};

test('remote wake sends one token-authenticated mutation to its owner and returns only the wake contract', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const discovery: string[] = [];
  const wake = createIncidentRemoteWake({
    ensureEndpoint: async (id) => { discovery.push(id); return endpoint; },
    fetch: (async (url, options) => {
      requests.push({ url: String(url), options: options || {} });
      return Response.json({ ...result, private_key: token });
    }) as typeof fetch,
  });
  assert.deepEqual(await wake('beam-10g', task), result);
  assert.deepEqual(discovery, ['beam-10g']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:19223/api/codex/incident-cases/icase_remote_1/wake');
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    taskType: task.taskType, idempotencyKey: task.idempotencyKey, decisionId: task.decisionId,
  });
  assert.deepEqual(requests[0].options.headers, { 'content-type': 'application/json', 'x-code-ai-remote-token': token });
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error', 'credential-bearing requests must not follow redirects');
});

test('unknown remote discovery is sanitized and never attempts a mutation', async () => {
  let requests = 0;
  const wake = createIncidentRemoteWake({
    ensureEndpoint: async () => { throw new Error(`Unknown server /private/key ${token}`); },
    fetch: (async () => { requests += 1; return Response.json(result); }) as typeof fetch,
  });
  await assert.rejects(wake('unknown', task), (error: any) => {
    assert.equal(error.message, 'incident_remote_wake_endpoint_unavailable');
    assert.equal(error.statusCode, 502);
    assert.ok(!JSON.stringify(error).includes(token));
    return true;
  });
  assert.equal(requests, 0);
});

test('HTTP failures preserve a safe status code without reading or exposing remote error bodies or retrying', async () => {
  let requests = 0;
  const wake = createIncidentRemoteWake({
    ensureEndpoint: async () => endpoint,
    fetch: (async () => { requests += 1; return Response.json({ error: `Authorization: Bearer ${token}` }, { status: 403 }); }) as typeof fetch,
  });
  await assert.rejects(wake('pci', task), (error: any) => {
    assert.equal(error.message, 'incident_remote_wake_http_403');
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(requests, 1);
});

test('transport errors are sanitized and mutation acceptance is never retried automatically', async () => {
  let requests = 0;
  const wake = createIncidentRemoteWake({
    ensureEndpoint: async () => endpoint,
    fetch: (async () => { requests += 1; throw new Error(`x-code-ai-remote-token: ${token}`); }) as typeof fetch,
  });
  await assert.rejects(wake('pci', task), { message: 'incident_remote_wake_failed' });
  assert.equal(requests, 1);
});

test('missing or credential-bearing fields are not accepted as a successful queue acknowledgement', async () => {
  for (const body of [{ ok: true }, { ...result, context_file_path: token }]) {
    const wake = createIncidentRemoteWake({
      ensureEndpoint: async () => endpoint,
      fetch: (async () => Response.json(body)) as typeof fetch,
    });
    await assert.rejects(wake('pci', task), { message: 'incident_remote_wake_response_invalid' });
  }
});

test('the mutation has a bounded timeout and aborts without a retry', async () => {
  let requests = 0;
  let signal: AbortSignal | undefined;
  const wake = createIncidentRemoteWake({
    timeoutMs: 10,
    ensureEndpoint: async () => endpoint,
    fetch: ((_url, options) => {
      requests += 1;
      signal = options?.signal || undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  await assert.rejects(wake('pci', task), (error: any) => error.message === 'incident_remote_wake_timeout' && error.statusCode === 504);
  assert.equal(signal?.aborted, true);
  assert.equal(requests, 1);
});

test('slow endpoint discovery cannot issue a late mutation after timeout', async () => {
  let finishDiscovery!: (value: typeof endpoint) => void;
  let requests = 0;
  const wake = createIncidentRemoteWake({
    timeoutMs: 10,
    ensureEndpoint: () => new Promise((resolve) => { finishDiscovery = resolve; }),
    fetch: (async () => { requests += 1; return Response.json(result); }) as typeof fetch,
  });
  await assert.rejects(wake('pci', task), { message: 'incident_remote_wake_timeout' });
  finishDiscovery(endpoint);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests, 0);
});
