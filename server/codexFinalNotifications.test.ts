import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  buildNtfyRequest,
  copySessionFinalNotificationPreference,
  deleteSessionFinalNotificationPreference,
  deliverNtfyRequestForTest,
  enqueueFinalResponseNotification,
  getSessionFinalNotificationPreference,
  rebindSessionFinalNotificationPreference,
  resetCodexFinalNotificationRuntimeForTests,
  setSessionFinalNotificationPreference,
  startCodexFinalNotificationWorker,
} from './codexFinalNotifications.js';

const TEST_ENDPOINT = 'https://ntfy.test/code-ai-test';
const TEST_ORIGIN = 'https://code-ai.test';

function buildRequest(finalMessage: string) {
  return buildNtfyRequest({
    endpoint: TEST_ENDPOINT,
    sequenceId: 'sequence-1',
    profileId: 'developer',
    sessionId: 'session-123',
    sessionTitle: 'בדיקת מערכת',
    provider: 'codex',
    finalMessage,
    publicOrigin: TEST_ORIGIN,
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while waiting for final-notification worker');
}

function useIsolatedState(name: string): string {
  const root = process.env.CODEX_STORAGE_ROOT || '/tmp';
  const stateFile = path.join(root, `${name}.json`);
  process.env.CODEX_NTFY_STATE_FILE = stateFile;
  process.env.CODEX_NTFY_URL = TEST_ENDPOINT;
  process.env.CODEX_NTFY_ENABLED = 'true';
  process.env.CODEX_NTFY_DEFAULT_ENABLED = 'true';
  process.env.CODEX_PUBLIC_ORIGIN = TEST_ORIGIN;
  resetCodexFinalNotificationRuntimeForTests();
  return stateFile;
}

test('short final responses are sent as Markdown notification bodies', () => {
  const message = 'המשימה הסתיימה בהצלחה.\n\n1. נבדק\n2. אומת';
  const request = buildRequest(message);

  assert.equal(request.method, 'POST');
  assert.equal(request.isAttachment, false);
  assert.equal(request.filename, null);
  assert.equal(Buffer.from(request.body).toString('utf8'), message);
  assert.equal(request.headers.Markdown, 'yes');
  assert.equal(request.headers['Content-Type'], 'text/markdown; charset=utf-8');
  assert.equal(request.headers.Click, `${TEST_ORIGIN}/session/developer/session-123`);
  assert.equal(request.headers['X-Sequence-ID'], 'sequence-1');
  assert.match(request.headers.Title, /^=\?UTF-8\?B\?/u);
});

test('long final responses are preserved in a text attachment without truncation', () => {
  const message = `Complete report\n${'Detailed result line. '.repeat(420)}`;
  const request = buildRequest(message);

  assert.equal(request.method, 'PUT');
  assert.equal(request.isAttachment, true);
  assert.match(request.filename || '', /\.txt$/u);
  assert.equal(request.headers.Filename, request.filename);
  assert.equal(request.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(Buffer.from(request.body).toString('utf8'), message);
  assert.match(request.headers.Message, /^=\?UTF-8\?B\?/u);
});

test('very large final responses are losslessly compressed before upload', () => {
  const message = 'תוצאת בדיקה מלאה\n'.repeat(160_000);
  const request = buildRequest(message);

  assert.equal(request.method, 'PUT');
  assert.equal(request.isAttachment, true);
  assert.match(request.filename || '', /\.txt\.gz$/u);
  assert.equal(request.headers['Content-Type'], 'application/gzip');
  assert.equal(gunzipSync(Buffer.from(request.body)).toString('utf8'), message);
});

test('ntfy non-success responses are surfaced to the retry layer', async () => {
  const fakeFetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  await assert.rejects(
    deliverNtfyRequestForTest({
      endpoint: TEST_ENDPOINT,
      sequenceId: 'sequence-failure',
      profileId: 'developer',
      sessionId: 'session-failure',
      finalMessage: 'final',
      publicOrigin: TEST_ORIGIN,
    }, fakeFetch),
    /ntfy returned 429/u
  );
});

test('per-session preference survives copy, rebind and delete operations', async () => {
  const stateFile = useIsolatedState('preference-state');
  await fs.rm(stateFile, { force: true });

  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft-a')).effectiveEnabled, true);
  await setSessionFinalNotificationPreference('developer', 'draft-a', false);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft-a')).effectiveEnabled, false);

  await copySessionFinalNotificationPreference('developer', 'draft-a', 'second-user', 'copied-session');
  assert.equal((await getSessionFinalNotificationPreference('second-user', 'copied-session')).enabled, false);

  await rebindSessionFinalNotificationPreference('developer', 'draft-a', 'real-session');
  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft-a')).enabled, true);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-session')).enabled, false);

  await deleteSessionFinalNotificationPreference('developer', 'real-session');
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-session')).enabled, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('the durable worker delivers a completion once and deduplicates retries', async () => {
  const stateFile = useIsolatedState('delivery-state');
  await fs.rm(stateFile, { force: true });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method || 'GET'),
      body: Buffer.from(init?.body as ArrayBuffer).toString('utf8'),
    });
    return new Response(JSON.stringify({ id: 'notification-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await startCodexFinalNotificationWorker();
    const first = await enqueueFinalResponseNotification({
      profileId: 'developer',
      preferenceSessionKey: 'draft-delivery',
      sessionId: 'real-delivery',
      sessionTitle: 'Durable delivery',
      provider: 'codex',
      finalMessage: 'Only one final response',
      dedupeKey: 'queue-item-1',
    });
    const duplicate = await enqueueFinalResponseNotification({
      profileId: 'developer',
      preferenceSessionKey: 'draft-delivery',
      sessionId: 'real-delivery',
      finalMessage: 'Only one final response',
      dedupeKey: 'queue-item-1',
    });

    assert.deepEqual(first, { queued: true, reason: 'queued' });
    assert.deepEqual(duplicate, { queued: false, reason: 'duplicate' });
    await waitFor(() => requests.length === 1);
    await waitFor(async () => {
      const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
        deliveriesById: Record<string, { status: string; finalMessage: string | null }>;
      };
      const delivery = Object.values(persisted.deliveriesById)[0];
      return delivery?.status === 'delivered' && delivery.finalMessage === null;
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, TEST_ENDPOINT);
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.body, 'Only one final response');
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexFinalNotificationRuntimeForTests();
  }
});
