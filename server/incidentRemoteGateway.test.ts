import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createIncidentRemoteGateway } from './incidentRemoteGateway.js';

const HOST_A = 'remote-a';
const HOST_B = 'remote-b';
const TOKEN_A = 'a-remote-existing-token-with-32-characters';
const TOKEN_B = 'b-remote-existing-token-with-32-characters';
const BASE = `/api/codex/remote-incidents/${HOST_A}`;
const mutations = ['messages', 'reports', 'decisions', 'executions', 'complete', 'reopen'];
const creation = {
  title: 'Needs a decision', summary: 'An investigation needs operator input.',
  investigator_profile_id: 'developer', investigator_session_id: 'session-123',
  event_id: 'manual_case:request-1', metadata: { decision_mode: true },
};

async function fixture(t: test.TestContext, globalParser = false) {
  const cases = new Map<string, any>();
  const calls: Array<{ pathname: string; options: RequestInit; body?: any }> = [];
  const hosts = new Map([
    [HOST_A, { id: HOST_A, enabled: true, token: TOKEN_A }],
    [HOST_B, { id: HOST_B, enabled: true, token: TOKEN_B }],
    ['disabled', { id: 'disabled', enabled: false, token: TOKEN_A }],
  ]);
  let failure: Error | null = null;
  const addCase = (caseId: string, serverId: string | null, extraMetadata = {}) => {
    const pkg = {
      incident_case: {
        ...creation, incident_case_id: caseId,
        metadata: { retained: 'current', ...(serverId ? { codeAiServerId: serverId } : {}), ...extraMetadata },
      },
      events: [], reports: [], decisions: [], executions: [],
    };
    cases.set(caseId, pkg);
    return pkg;
  };
  const app = express();
  if (globalParser) app.use(express.json({ limit: '25mb' }));
  app.use('/api/codex/remote-incidents/:serverId', createIncidentRemoteGateway({
    getHost: (id) => hosts.get(id) || null,
    requestCanonical: async (pathname, options = {}) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ pathname, options, body });
      if (failure) throw failure;
      if (options.method === 'GET') {
        if (pathname === '/v1/incident-cases' || pathname.startsWith('/v1/incident-cases?status=')) {
          return { incident_cases: [...cases.values()].map((pkg) => pkg.incident_case) };
        }
        const pkg = cases.get(pathname.split('/')[3]);
        if (!pkg) throw Object.assign(new Error('canonical_case_not_found'), { statusCode: 404 });
        return { package: pkg };
      }
      if (pathname === '/v1/incident-cases') {
        const id = body.incident_case_id || `new-case-${cases.size}`;
        const existing = cases.get(id);
        const pkg = existing || addCase(id, null);
        pkg.incident_case = { ...pkg.incident_case, ...body, incident_case_id: id };
        cases.set(id, pkg);
        return { incident_case: pkg.incident_case, created: !existing };
      }
      const pkg = cases.get(pathname.split('/')[3]);
      Object.assign(pkg.incident_case, body.case_patch || {});
      return { incident_case: pkg.incident_case, accepted_payload: body };
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // Use node:http so malformed path fixtures are not normalized by fetch/URL.
  const request = (pathname: string, options: {
    method?: string; token?: string | null; body?: any; raw?: string; chunked?: boolean; headers?: Record<string, string>;
  } = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const raw = options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
    const token = options.token === undefined ? TOKEN_A : options.token;
    const req = http.request({
      hostname: '127.0.0.1', port: address.port, path: pathname,
      method: options.method || 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(raw === undefined ? {} : {
          'content-type': 'application/json',
          ...(options.chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(raw).toString() }),
        }),
        ...options.headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
  return { cases, calls, addCase, request, failWith: (error: Error) => { failure = error; } };
}

test('creates a host-bound canonical case with namespaced idempotency and unchanged JSON fields', async (t) => {
  const f = await fixture(t);
  const input = { ...creation, incident_case_id: 'own-case', extra: { facts: ['one', 'two'], checked: false } };
  const result = await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', body: input });
  assert.equal(result.status, 200);
  assert.equal(result.body.incident_case.metadata.codeAiServerId, HOST_A);
  assert.equal(result.body.created, true);
  assert.equal(f.calls.length, 2, 'explicit IDs get an ownership preflight, with 404 treated as absent');
  assert.deepEqual(f.calls[1].body, {
    ...input, metadata: { ...input.metadata, codeAiServerId: HOST_A }, event_id: `remote:${HOST_A}:${input.event_id}`,
  });
  assert.deepEqual(f.calls[1].options, { method: 'POST', body: JSON.stringify(f.calls[1].body) });
  assert.ok(!JSON.stringify(f.calls).includes(TOKEN_A), 'remote credentials are not forwarded to canonical');
  assert.equal(input.metadata.decision_mode, true);
});

test('the same event ID is distinct across hosts and stable for retries', async (t) => {
  const f = await fixture(t);
  await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', body: creation });
  await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', body: creation });
  await f.request(`/api/codex/remote-incidents/${HOST_B}/v1/incident-cases`, {
    method: 'POST', token: TOKEN_B, body: creation,
  });
  const events = f.calls.filter((call) => call.options.method === 'POST').map((call) => call.body.event_id);
  assert.equal(events[0], events[1]);
  assert.notEqual(events[0], events[2]);
});

test('list and package reads expose only cases bound to the authenticated host', async (t) => {
  const f = await fixture(t);
  const own = f.addCase('own', HOST_A);
  f.addCase('foreign', HOST_B);
  f.addCase('legacy', null);
  const list = await f.request(`${BASE}/v1/incident-cases?status=waiting_operator`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.incident_cases.map((entry: any) => entry.incident_case_id), ['own']);
  assert.equal(f.calls[0].pathname, '/v1/incident-cases?status=waiting_operator');
  const pkg = await f.request(`${BASE}/v1/incident-cases/own/package`);
  assert.deepEqual(pkg, { status: 200, body: { package: own } });
});

test('all allowlisted mutations preserve existing metadata and forward nested JSON values', async (t) => {
  const f = await fixture(t);
  f.addCase('own', HOST_A);
  for (const operation of mutations) {
    const body = {
      kind: operation, text: 'עדכון', payload: { evidence: ['one'], confidence: 0, verified: false },
      case_patch: { last_wake_reason: operation, metadata: { changed: operation } },
    };
    const before = f.calls.length;
    const result = await f.request(`${BASE}/v1/incident-cases/own/${operation}`, { method: 'POST', body });
    assert.equal(result.status, 200, operation);
    assert.equal(f.calls[before].pathname, '/v1/incident-cases/own/package');
    assert.equal(f.calls[before + 1].pathname, `/v1/incident-cases/own/${operation}`);
    assert.deepEqual(result.body.accepted_payload, {
      ...body,
      case_patch: { ...body.case_patch, metadata: { retained: 'current', codeAiServerId: HOST_A, changed: operation } },
    });
  }
  for (const operation of mutations) {
    const body = { summary: 'normal update', idempotency_key: `normal:${operation}` };
    const result = await f.request(`${BASE}/v1/incident-cases/own/${operation}`, { method: 'POST', body });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.accepted_payload, body, `${operation} must not gain case_patch or other fields`);
    assert.equal(Object.hasOwn(result.body.accepted_payload, 'case_patch'), false);
  }
});

test('missing, wrong, disabled, unknown and cross-host tokens never call canonical', async (t) => {
  const f = await fixture(t);
  for (const [base, token] of [
    [BASE, null], [BASE, 'wrong'], [BASE, TOKEN_B],
    ['/api/codex/remote-incidents/disabled', TOKEN_A], ['/api/codex/remote-incidents/unknown', TOKEN_A],
  ]) {
    const result = await f.request(`${base}/v1/incident-cases`, { token });
    assert.deepEqual(result, { status: 401, body: { error: 'incident_remote_unauthorized' } });
  }
  const malformed = await f.request(`${BASE}/v1/incident-cases`, {
    method: 'POST', token: null, raw: '{bad json',
  });
  assert.equal(malformed.status, 401, 'auth runs before accepting/parsing JSON');
  assert.equal(f.calls.length, 0);
});

test('create rejects spoofed host metadata and requires bounded investigator profile/session IDs', async (t) => {
  const f = await fixture(t);
  const spoofed = await f.request(`${BASE}/v1/incident-cases`, {
    method: 'POST', body: { ...creation, metadata: { codeAiServerId: HOST_B } },
  });
  assert.equal(spoofed.status, 403);
  for (const field of ['investigator_profile_id', 'investigator_session_id']) {
    for (const value of [undefined, '', null, 'bad/id', ' ', 'a'.repeat(201)]) {
      const result = await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', body: { ...creation, [field]: value } });
      assert.equal(result.status, 400, `${field}: ${value}`);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('existing IDs cannot be claimed at create; own retries preserve canonical metadata', async (t) => {
  const f = await fixture(t);
  f.addCase('foreign', HOST_B);
  f.addCase('own', HOST_A);
  const foreign = await f.request(`${BASE}/v1/incident-cases`, {
    method: 'POST', body: { ...creation, incident_case_id: 'foreign' },
  });
  assert.equal(foreign.status, 404);
  assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 0);
  const own = await f.request(`${BASE}/v1/incident-cases`, {
    method: 'POST', body: { ...creation, incident_case_id: 'own' },
  });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.incident_case.metadata, { retained: 'current', decision_mode: true, codeAiServerId: HOST_A });
});

test('cross-host and unbound cases cannot be read or mutated', async (t) => {
  const f = await fixture(t);
  f.addCase('foreign', HOST_B);
  f.addCase('legacy', null);
  for (const caseId of ['foreign', 'legacy', 'missing']) {
    const pkg = await f.request(`${BASE}/v1/incident-cases/${caseId}/package`);
    assert.deepEqual(pkg, { status: 404, body: { error: 'incident_remote_case_not_found' } });
    for (const operation of mutations) {
      const result = await f.request(`${BASE}/v1/incident-cases/${caseId}/${operation}`, { method: 'POST', body: {} });
      assert.equal(result.status, 404);
    }
  }
  assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 0);
});

test('mutations cannot rebind metadata or redirect case identity', async (t) => {
  const f = await fixture(t);
  f.addCase('own', HOST_A);
  for (const body of [
    { metadata: { codeAiServerId: HOST_B } },
    { case_patch: { metadata: { codeAiServerId: HOST_B } } },
    { case_patch: { metadata: { codeAiServerId: null } } },
    { incident_case_id: 'foreign' }, { case_patch: { incident_case_id: 'foreign' } },
  ]) {
    const result = await f.request(`${BASE}/v1/incident-cases/own/messages`, { method: 'POST', body });
    assert.equal(result.status, 403);
  }
  assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 0);
});

test('raw encoded traversal, arbitrary v1 routes and query mutations are denied before backend access', async (t) => {
  const f = await fixture(t);
  for (const suffix of [
    '/v1/health', '/v1/failure-tickets', '/v1/incident-cases/own',
    '/v1/incident-cases/../secrets/package', '/v1/incident-cases/%2e%2e/package',
    '/v1/incident-cases/own%2fother/package', '/v1/incident-cases/own%252fother/package',
    '/v1/incident-cases/own\\other/package', '/v1/incident-cases/own/package?status=open',
    '/v1/incident-cases?status=open&status=completed', '/v1/incident-cases?status=open&limit=100',
    '/v1/incident-cases?%73tatus=open', '/v1/incident-cases?status=%6fpen',
    '/v1/incident-cases/own/messages?metadata=spoof',
  ]) {
    const result = await f.request(`${BASE}${suffix}`, {
      method: suffix.includes('messages') ? 'POST' : 'GET',
      ...(suffix.includes('messages') ? { body: {} } : {}),
    });
    assert.equal(result.status, 404, suffix);
  }
  assert.equal((await f.request(`${BASE}/v1/incident-cases`, { method: 'DELETE' })).status, 404);
  assert.equal((await f.request(`${BASE}/v1/incident-cases/own/package`, { method: 'POST', body: {} })).status, 404);
  assert.equal(f.calls.length, 0);
});

test('oversized, malformed and non-object JSON is bounded without backend calls, including after a global parser', async (t) => {
  for (const globalParser of [false, true]) {
    const f = await fixture(t, globalParser);
    for (const chunked of [false, true]) {
      const oversized = await f.request(`${BASE}/v1/incident-cases`, {
        method: 'POST', chunked, body: { ...creation, summary: '🔥'.repeat(32 * 1024) },
      });
      assert.equal(oversized.status, 413);
    }
    for (const raw of globalParser ? ['[]'] : ['[]', 'null', '"string"']) {
      const result = await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', raw });
      assert.equal(result.status, 400);
    }
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  assert.equal((await f.request(`${BASE}/v1/incident-cases`, { method: 'POST', raw: '{bad json' })).status, 400);
  assert.equal((await f.request(`${BASE}/v1/incident-cases`, {
    method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' },
  })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('upstream failures are sanitized and do not leak tokens or raw backend bodies', async (t) => {
  const f = await fixture(t);
  f.failWith(new Error(`backend response: secret-canonical-token ${TOKEN_A}`));
  const result = await f.request(`${BASE}/v1/incident-cases`);
  assert.deepEqual(result, { status: 502, body: { error: 'incident_remote_upstream_failed' } });
});
