import assert from 'node:assert/strict';
import {
  isSafeForumSessionCookie,
  readRawCookieValue,
  resolveBinaMainAppOrigin,
  validateBinaForumSession,
} from '../server/binaSso.js';
import { issueBinaRuntimeWorkbenchSession } from '../server/binaRuntimeSso.js';

const sessionValue = 's%3Atest-session-id.test-signature-value';

assert.equal(
  readRawCookieValue(`theme=light; forum.session=${sessionValue}; code_ai_device_unlock=x`, 'forum.session'),
  sessionValue,
  'the signed cookie must stay encoded while crossing the server boundary',
);
assert.equal(isSafeForumSessionCookie(sessionValue), true);
assert.equal(isSafeForumSessionCookie('short'), false);
assert.equal(resolveBinaMainAppOrigin(), 'http://127.0.0.1:9001');
assert.throws(
  () => resolveBinaMainAppOrigin('https://attacker.example'),
  /Bina Cshera or loopback host/,
  'the verifier must not become an arbitrary SSRF client',
);

const customerCalls: string[] = [];
const customerResult = await validateBinaForumSession(sessionValue, {
  origin: 'http://127.0.0.1:9001',
  fetchImpl: (async (input, init) => {
    customerCalls.push(String(input));
    assert.equal(new Headers(init?.headers).get('cookie'), `forum.session=${sessionValue}`);
    return new Response(JSON.stringify({ customer: { id: 17 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch,
});
assert.deepEqual(customerResult, { authenticated: true, principalType: 'customer' });
assert.equal(customerCalls.length, 1);

let forumCallCount = 0;
const forumResult = await validateBinaForumSession(sessionValue, {
  origin: 'http://localhost:9001',
  fetchImpl: (async () => {
    forumCallCount += 1;
    if (forumCallCount === 1) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 });
    }
    return new Response(JSON.stringify({ success: true, user: { id: 9 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch,
});
assert.deepEqual(forumResult, { authenticated: true, principalType: 'forum' });
assert.equal(forumCallCount, 2, 'forum auth should be checked only after customer auth rejects the session');

const inactiveResult = await validateBinaForumSession(sessionValue, {
  origin: 'http://localhost:9001',
  fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
});
assert.deepEqual(inactiveResult, { authenticated: false, principalType: null });

let runtimeSsoRequest: { input: string; init?: RequestInit } | null = null;
const runtimeResult = await issueBinaRuntimeWorkbenchSession(
  { profileId: 'developer', sessionKey: 'draft:test-session' },
  {
    secret: 'runtime-workbench-sso-test-secret-with-more-than-32-bytes',
    fetchImpl: (async (input, init) => {
      runtimeSsoRequest = { input: String(input), init };
      return new Response(JSON.stringify({
        ok: true,
        sessionId: '0daec0f2-ce78-4677-a62d-f465ad4d6986',
        expiresAt: '2026-07-17T04:00:00.000Z',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  },
);
assert.equal(runtimeResult.runtimeSession, '0daec0f2-ce78-4677-a62d-f465ad4d6986');
assert.equal(runtimeSsoRequest?.input, 'http://127.0.0.1:46120/api/runtime/internal/workbench-sso/session');
assert.match(new Headers(runtimeSsoRequest?.init?.headers).get('x-bina-workbench-signature') || '', /^[A-Za-z0-9_-]{32,}$/);
await assert.rejects(
  issueBinaRuntimeWorkbenchSession(
    { profileId: 'developer', sessionKey: 'draft:test-session' },
    {
      internalOrigin: 'https://attacker.example',
      secret: 'runtime-workbench-sso-test-secret-with-more-than-32-bytes',
    },
  ),
  /loopback HTTP/,
);

console.log(JSON.stringify({
  ok: true,
  rawCookiePreserved: true,
  originAllowlist: true,
  customerSessionValidation: true,
  forumSessionFallback: true,
  inactiveSessionRejected: true,
  runtimeSessionDelegation: true,
}));
