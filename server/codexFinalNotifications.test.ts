import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  buildNtfyRequest,
  buildSessionOutcomeMessage,
  copySessionFinalNotificationPreference,
  deleteSessionFinalNotificationPreference,
  deliverNtfyRequestForTest,
  enqueueFinalResponseNotification,
  getSessionFinalNotificationPreference,
  rebindSessionFinalNotificationPreference,
  resetCodexFinalNotificationRuntimeForTests,
  sealCodexFinalNotificationServerEnvironment,
  setSessionFinalNotificationPreference,
  startCodexFinalNotificationWorker,
} from './codexFinalNotifications.js';

const TEST_ENDPOINT = 'https://ntfy.test/code-ai-test';
const TEST_ORIGIN = 'https://code-ai.test';

function buildRequest(
  finalMessage: string,
  options: {
    outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    serverId?: string;
    serverLabel?: string;
    sessionId?: string;
  } = {},
) {
  return buildNtfyRequest({
    endpoint: TEST_ENDPOINT,
    sequenceId: 'sequence-1',
    profileId: 'developer',
    sessionId: options.sessionId || 'session-123',
    sessionTitle: 'בדיקת מערכת',
    provider: 'codex',
    outcome: options.outcome,
    serverId: options.serverId,
    serverLabel: options.serverLabel,
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
  assert.equal(request.headers.Click, `${TEST_ORIGIN}/session/developer/session-123?server=local`);
  assert.equal(request.headers['X-Sequence-ID'], 'sequence-1');
  assert.match(request.headers.Title, /^=\?UTF-8\?B\?/u);
});

test('native GUI failure enters the existing durable outbox once without a queue; queue-owned and disabled failures do not duplicate', async () => {
  const stateFile = useIsolatedState('native-gui-failure-outbox');
  await fs.rm(stateFile, { force: true });
  await setSessionFinalNotificationPreference('developer', 'native-off', false);
  const originalFetch = globalThis.fetch;
  const sent: Array<{ body: string; priority: string | undefined }> = [];
  globalThis.fetch = (async (_input: any, init: any) => {
    sent.push({ body: Buffer.from(init.body).toString('utf8'), priority: init.headers.Priority });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const source = async (cursor: unknown) => ({
    cursor: { version: 1 as const, startedAt: '2026-10-20T08:00:00Z', observedAt: '2026-10-20T08:01:00Z', files: {} },
    failures: cursor ? [] : ['native-only', 'queue-owned', 'native-off'].map(sessionId => ({
      profileId: 'developer', sessionId, turnId: 'native-turn', timestamp: '2026-10-20T08:01:00Z', reason: 'המודל עמוס כרגע.',
    })),
  });
  try {
    await startCodexFinalNotificationWorker({ readNativeFailures: source, ownsNativeFailure: async f => f.sessionId === 'queue-owned' });
    await waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      return saved.nativeFailureCursor && Object.values(saved.deliveriesById).some((d: any) => d.status === 'delivered');
    });
    assert.equal(sent.length, 1); assert.equal(sent[0].priority, 'high'); assert.match(sent[0].body, /עמוס/);
    resetCodexFinalNotificationRuntimeForTests();
    await setSessionFinalNotificationPreference('developer', 'native-off', true);
    await startCodexFinalNotificationWorker({ readNativeFailures: source });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(sent.length, 1, 'Restart/enable must not replay native failures from before the cursor');
  } finally {
    resetCodexFinalNotificationRuntimeForTests(); globalThis.fetch = originalFetch;
    await fs.rm(stateFile, { force: true });
  }
});

test('server seals ntfy configuration before provider processes can inherit it', async () => {
  process.env.CODEX_NTFY_URL = TEST_ENDPOINT;
  process.env.CODEX_NTFY_ACCESS_TOKEN = 'server-only-token';
  process.env.CODEX_NTFY_ENABLED = 'true';
  process.env.CODEX_NTFY_DEFAULT_ENABLED = 'true';
  process.env.CODEX_NTFY_STATE_FILE = path.join(process.env.CODEX_STORAGE_ROOT || '/tmp', 'sealed-state.json');

  sealCodexFinalNotificationServerEnvironment();
  assert.equal(process.env.CODEX_NTFY_URL, undefined);
  assert.equal(process.env.CODEX_NTFY_ACCESS_TOKEN, undefined);
  assert.equal(process.env.CODEX_NTFY_ENABLED, undefined);
  assert.equal(process.env.CODEX_NTFY_DEFAULT_ENABLED, undefined);
  assert.equal(process.env.CODEX_NTFY_STATE_FILE, undefined);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'sealed-session')).available, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('interrupted runs use a high-priority warning and reopen the selected remote server', () => {
  const message = buildSessionOutcomeMessage(
    'interrupted',
    'Interrupted by server restart before completion.',
    'BEAM 10G',
  );
  const request = buildRequest(message, {
    outcome: 'interrupted',
    serverId: 'remote-a',
    serverLabel: 'BEAM 10G',
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Tags, 'warning,robot_face');
  assert.equal(request.headers.Priority, 'high');
  assert.equal(request.headers.Click, `${TEST_ORIGIN}/session/developer/session-123?server=remote-a`);
  assert.match(Buffer.from(request.body).toString('utf8'), /המשימה נקטעה/u);
  assert.match(Buffer.from(request.body).toString('utf8'), /BEAM 10G/u);
  assert.match(Buffer.from(request.body).toString('utf8'), /המשך במשימה/u);
});

test('cancelled draft tasks link back to their draft conversation', () => {
  const request = buildRequest('המשימה הופסקה.', {
    outcome: 'cancelled',
    serverId: 'personal-windows',
    sessionId: 'draft:phone-task',
  });

  assert.equal(request.headers.Tags, 'stop_sign,robot_face');
  assert.equal(
    request.headers.Click,
    `${TEST_ORIGIN}/session/developer/draft/draft%3Aphone-task?server=personal-windows`,
  );
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
  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft-a')).enabled, false);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-session')).enabled, false);

  await deleteSessionFinalNotificationPreference('developer', 'real-session');
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-session')).enabled, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('draft aliases survive reload, remain profile scoped and accept delayed toggles', async () => {
  const stateFile = useIsolatedState('preference-alias-state');
  await fs.rm(stateFile, { force: true });
  await setSessionFinalNotificationPreference('developer', 'draft:a', false);
  await rebindSessionFinalNotificationPreference('developer', 'draft:a', 'real-a');
  await rebindSessionFinalNotificationPreference('developer', 'real-a', 'recovered-a');
  resetCodexFinalNotificationRuntimeForTests();

  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft:a')).enabled, false);
  assert.equal((await getSessionFinalNotificationPreference('developer2', 'draft:a')).enabled, true);
  await setSessionFinalNotificationPreference('developer', 'draft:a', true);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'recovered-a')).enabled, true);
  await setSessionFinalNotificationPreference('developer', 'real-a', false);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft:a')).enabled, false);
  resetCodexFinalNotificationRuntimeForTests();
});

test('real-session explicit opt-in is not overwritten by an older disabled draft', async () => {
  const stateFile = useIsolatedState('preference-destination-state');
  await fs.rm(stateFile, { force: true });
  await setSessionFinalNotificationPreference('developer', 'draft:a', false);
  await setSessionFinalNotificationPreference('developer', 'real-a', true);
  await rebindSessionFinalNotificationPreference('developer', 'draft:a', 'real-a');
  assert.equal((await getSessionFinalNotificationPreference('developer', 'draft:a')).enabled, true);
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-a')).enabled, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('default-enabled draft rebind still redirects a later draft opt-out', async () => {
  const stateFile = useIsolatedState('preference-default-alias-state');
  await fs.rm(stateFile, { force: true });
  await rebindSessionFinalNotificationPreference('developer', 'draft:a', 'real-a');
  await setSessionFinalNotificationPreference('developer', 'draft:a', false);
  const result = await enqueueFinalResponseNotification({
    profileId: 'developer', preferenceSessionKey: 'real-a', sessionId: 'real-a',
    finalMessage: 'Must not notify', dedupeKey: 'off-default-alias',
  });
  assert.deepEqual(result, { queued: false, reason: 'disabled' });
  resetCodexFinalNotificationRuntimeForTests();
});

test('a failed persistence write does not poison the next preference save', async () => {
  const stateFile = useIsolatedState('preference-persistence-recovery');
  await fs.rm(stateFile, { force: true });
  await getSessionFinalNotificationPreference('developer', 'real-a');
  // An existing directory cannot be replaced by the atomic file rename.
  await fs.mkdir(stateFile);
  await assert.rejects(setSessionFinalNotificationPreference('developer', 'real-a', false));
  await fs.rmdir(stateFile);
  await setSessionFinalNotificationPreference('developer', 'real-a', true);
  resetCodexFinalNotificationRuntimeForTests();
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-a')).enabled, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('state can be loaded again after a transient malformed-file read failure', async () => {
  const stateFile = useIsolatedState('preference-read-recovery');
  await fs.writeFile(stateFile, '{incomplete');
  await assert.rejects(getSessionFinalNotificationPreference('developer', 'real-a'));
  await fs.writeFile(stateFile, JSON.stringify({
    version: 1, overridesByKey: {}, deliveriesById: {},
  }));
  assert.equal((await getSessionFinalNotificationPreference('developer', 'real-a')).enabled, true);
  resetCodexFinalNotificationRuntimeForTests();
});

test('deleting a rebound conversation removes its unsent payload and aliases', async () => {
  const stateFile = useIsolatedState('delivery-deleted-state');
  await fs.rm(stateFile, { force: true });
  await enqueueFinalResponseNotification({
    profileId: 'developer', preferenceSessionKey: 'draft:a', sessionId: 'draft:a',
    finalMessage: 'Must not notify after deleting conversation', dedupeKey: 'deleted-conversation',
  });
  await rebindSessionFinalNotificationPreference('developer', 'draft:a', 'real-a');
  await rebindSessionFinalNotificationPreference('developer', 'real-a', 'recovered-a');
  await setSessionFinalNotificationPreference('developer', 'real-a', false);
  await deleteSessionFinalNotificationPreference('developer', 'recovered-a');
  const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const delivery = Object.values(persisted.deliveriesById as Record<string, { status: string; finalMessage: string | null }>)[0];
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.finalMessage, null);
  assert.deepEqual(persisted.sessionAliasesByKey, {});
  resetCodexFinalNotificationRuntimeForTests();
});

test('disable pauses an existing outbox; re-enable delivers it once with the rebound identity', async () => {
  const stateFile = useIsolatedState('delivery-toggle-state');
  await fs.rm(stateFile, { force: true });
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(init || {});
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const input = {
      profileId: 'developer', preferenceSessionKey: 'draft:a', sessionId: 'draft:a',
      finalMessage: 'Queued before opt-out', dedupeKey: 'toggle-once',
    };
    await enqueueFinalResponseNotification(input);
    await rebindSessionFinalNotificationPreference('developer', 'draft:a', 'real-a');
    await setSessionFinalNotificationPreference('developer', 'real-a', false);
    await startCodexFinalNotificationWorker();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requests.length, 0);
    const paused = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(Object.values(paused.deliveriesById as Record<string, { status: string }>)[0].status, 'paused');
    // Old draft callers and newly opened real-session callers are the same chat.
    await setSessionFinalNotificationPreference('developer', 'draft:a', true);
    await waitFor(() => requests.length === 1);
    await waitFor(async () => Object.values(JSON.parse(await fs.readFile(stateFile, 'utf8')).deliveriesById)
      .some((delivery: any) => delivery.status === 'delivered'));
    assert.equal(new Headers(requests[0].headers).get('Click'), `${TEST_ORIGIN}/session/developer/real-a?server=local`);
    await setSessionFinalNotificationPreference('developer', 'real-a', false);
    await setSessionFinalNotificationPreference('developer', 'real-a', true);
    assert.deepEqual(await enqueueFinalResponseNotification(input), { queued: false, reason: 'duplicate' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexFinalNotificationRuntimeForTests();
  }
});

test('events completed entirely while disabled are not replayed on opt-in', async () => {
  const stateFile = useIsolatedState('delivery-disabled-state');
  await fs.rm(stateFile, { force: true });
  await setSessionFinalNotificationPreference('developer', 'real-a', false);
  assert.deepEqual(await enqueueFinalResponseNotification({
    profileId: 'developer', preferenceSessionKey: 'real-a', sessionId: 'real-a',
    finalMessage: 'Completed while off', dedupeKey: 'completed-while-off',
  }), { queued: false, reason: 'disabled' });
  await setSessionFinalNotificationPreference('developer', 'real-a', true);
  const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(Object.keys(persisted.deliveriesById).length, 0);
  resetCodexFinalNotificationRuntimeForTests();
});

test('disabling during a failed request suppresses its retry until re-enabled', async () => {
  const stateFile = useIsolatedState('delivery-retry-toggle-state');
  await fs.rm(stateFile, { force: true });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let finishFirst!: () => void;
  const firstRequestFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  globalThis.fetch = (async () => {
    requests += 1;
    if (requests === 1) {
      await firstRequestFinished;
      return new Response('private endpoint must never enter persisted lastError', { status: 503 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    await startCodexFinalNotificationWorker();
    await enqueueFinalResponseNotification({
      profileId: 'developer', preferenceSessionKey: 'real-a', sessionId: 'real-a',
      finalMessage: 'Retryable completion', dedupeKey: 'retry-toggle',
    });
    await waitFor(() => requests === 1);
    await setSessionFinalNotificationPreference('developer', 'real-a', false);
    finishFirst();
    await waitFor(async () => Object.values(JSON.parse(await fs.readFile(stateFile, 'utf8')).deliveriesById)
      .some((delivery: any) => delivery.status === 'paused'));
    assert.equal(requests, 1);
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(Object.values(persisted.deliveriesById as Record<string, { lastError: string }>)[0].lastError, 'ntfy returned 503');
    await setSessionFinalNotificationPreference('developer', 'real-a', true);
    await waitFor(() => requests === 2);
  } finally {
    finishFirst();
    // Allow the last worker write to settle before clearing module state.
    await new Promise((resolve) => setTimeout(resolve, 40));
    globalThis.fetch = originalFetch;
    resetCodexFinalNotificationRuntimeForTests();
  }
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
