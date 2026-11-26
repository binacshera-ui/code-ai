import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ACTIVE_TURN_MESSAGE_NOTICE,
  composerMessageEndpoint,
  composerMessageProvenNotDelivered,
  createComposerLiveInputCapability,
  createComposerMessageEndpointPins,
  parseComposerMessageAcceptance,
} from './composerMessageDelivery';
import { createDurableQueueSubmission, createQueueRequestScope, removeAcknowledgedAttachments } from './queueRequestLifecycle';

const normalSend = { provider: 'codex', saveAsDraft: false, scheduledFor: '', scheduleType: 'once', supportsLiveInput: true } as const;
const expected = {
  endpoint: '/api/codex/messages', clientRequestId: 'request-a', profileId: 'profile-a', sessionId: 'session-a',
} as const;
const delivery = {
  kind: 'active-turn', id: 'receipt-a', clientRequestId: expected.clientRequestId, profileId: expected.profileId,
  sessionId: expected.sessionId, turnId: 'turn-a', status: 'delivered',
} as const;

test('normal Codex sends always use central delivery, without a client running-state decision', () => {
  assert.equal(composerMessageEndpoint(normalSend), '/api/codex/messages');
  assert.equal(composerMessageEndpoint({ ...normalSend, activeConversation: false }), '/api/codex/messages');
  assert.equal(composerMessageEndpoint({ ...normalSend, activeConversation: true }), '/api/codex/messages');
  for (const provider of ['claude', 'gemini', null, undefined]) {
    assert.equal(composerMessageEndpoint({ ...normalSend, provider }), '/api/codex/queue/items');
  }
});

test('older servers keep idle sends but never silently queue a known active follow-up', () => {
  assert.equal(composerMessageEndpoint({ ...normalSend, supportsLiveInput: false }), '/api/codex/queue/items');
  assert.throws(() => composerMessageEndpoint({ ...normalSend, supportsLiveInput: false, activeConversation: true }), /השרת הזה דורש עדכון/);
  for (const activeConversation of [false, true]) {
    assert.throws(() => composerMessageEndpoint({ ...normalSend, supportsLiveInput: undefined, activeConversation }), /הטיוטה נשמרה/);
  }
});

test('a running draft cannot create another queued message before binding to its native session', () => {
  for (const supportsLiveInput of [true, false, undefined]) {
    assert.throws(() => composerMessageEndpoint({ ...normalSend, supportsLiveInput, sessionBindingPending: true }), /הטיוטה נשמרה/);
  }
  assert.equal(composerMessageEndpoint({ ...normalSend, activeConversation: false, sessionBindingPending: false }), '/api/codex/messages');
  assert.equal(composerMessageEndpoint({ ...normalSend, sessionBindingPending: true, saveAsDraft: true }), '/api/codex/queue/drafts');
  assert.equal(composerMessageEndpoint({ ...normalSend, sessionBindingPending: true, scheduledFor: '2001-01-01T10:00' }), '/api/codex/queue/items');
});

test('catalog capability is isolated by server/profile and rejects stale reads and protocol mismatches', () => {
  const capability = createComposerLiveInputCapability();
  const current = 'server-a/profile-a', otherServer = 'server-b/profile-a', otherProfile = 'server-a/profile-b';
  capability.setScope(current);
  assert.equal(capability.read(current), undefined);
  const firstRead = capability.beginRead(current);
  const latestRead = capability.beginRead(current);
  assert.equal(capability.accept(firstRead, { supported: true, protocol: 'steer-context-v1' }), false);
  assert.equal(capability.accept(latestRead, { supported: true, protocol: 'steer-context-v1' }), true);
  assert.equal(capability.read(current), true);
  assert.equal(capability.read(otherServer), undefined);
  const pending = capability.beginRead(current);
  capability.setScope(otherProfile);
  assert.equal(capability.read(otherProfile), undefined);
  capability.setScope(current);
  assert.equal(capability.accept(pending, { supported: true, protocol: 'steer-context-v1' }), false);
  assert.equal(capability.read(current), undefined);
  assert.equal(capability.accept(capability.beginRead(current), undefined), true);
  assert.equal(capability.read(current), false);
  assert.equal(capability.accept(capability.beginRead(current), { supported: true, protocol: 'future-protocol' } as never), true);
  assert.equal(capability.read(current), false);
});

test('explicit schedules, including past times and recurring work, retain queue routing', () => {
  for (const scheduledFor of ['2001-01-01T10:00', '2099-01-01T10:00']) {
    assert.equal(composerMessageEndpoint({ ...normalSend, scheduledFor }), '/api/codex/queue/items');
  }
  assert.equal(composerMessageEndpoint({ ...normalSend, scheduleType: 'recurring' }), '/api/codex/queue/items');
  assert.equal(composerMessageEndpoint({ ...normalSend, saveAsDraft: true }), '/api/codex/queue/drafts');
  assert.equal(composerMessageEndpoint({ ...normalSend, saveAsDraft: true, scheduledFor: '2099-01-01T10:00', scheduleType: 'recurring' }), '/api/codex/queue/drafts');
});

test('active acknowledgement stays a delivery, never a synthesized queue item', () => {
  const accepted = parseComposerMessageAcceptance({ delivery }, expected);
  assert.deepEqual(accepted, { kind: 'active-turn', delivery });
  assert.equal('items' in accepted, false);
  assert.equal(ACTIVE_TURN_MESSAGE_NOTICE, 'ההודעה צורפה לריצה הפעילה');
});

test('idle sends, schedules and drafts retain both existing queue acknowledgement shapes', () => {
  const item = { id: 'item-a', status: 'queued' };
  for (const endpoint of ['/api/codex/messages', '/api/codex/queue/items', '/api/codex/queue/drafts'] as const) {
    for (const response of [{ item }, { items: [item] }, { items: [], item }]) {
      assert.deepEqual(parseComposerMessageAcceptance(response, { ...expected, endpoint }), { kind: 'queued', items: [item] });
    }
  }
});

test('pending, uncorrelated, incomplete or contradictory deliveries cannot clear the draft', () => {
  for (const invalid of [
    { ...delivery, status: 'pending' }, { ...delivery, status: 'unknown' },
    { ...delivery, clientRequestId: 'another-request' }, { ...delivery, id: '' }, { ...delivery, profileId: 'another-profile' },
    { ...delivery, sessionId: 'another-session' }, { ...delivery, turnId: '' },
    { ...delivery, turnId: null }, { ...delivery, kind: 'queued' }, null,
  ]) {
    assert.throws(() => parseComposerMessageAcceptance({ delivery: invalid }, expected), /הטיוטה נשמרה/);
  }
  assert.throws(() => parseComposerMessageAcceptance({ delivery, item: { id: 'fake-item' } }, expected), /הטיוטה נשמרה/);
  assert.throws(() => parseComposerMessageAcceptance({ delivery }, { ...expected, sessionId: null }), /הטיוטה נשמרה/);
  assert.throws(() => parseComposerMessageAcceptance({ delivery }, { ...expected, endpoint: '/api/codex/queue/items' }), /הטיוטה נשמרה/);
  for (const response of [null, {}, { items: [] }, { item: {} }, { items: [{ id: '' }] }]) {
    assert.throws(() => parseComposerMessageAcceptance(response, expected), /הטיוטה נשמרה/);
  }
});

test('lost acknowledgements, pending results and HTTP conflicts preserve payload and stable retry identity', async () => {
  const submission = createDurableQueueSubmission();
  const seenIds: string[] = [];
  let prompt = 'neutral follow-up';
  let attachments = [{ id: 'sent-file', previewUrl: 'blob:sent' }];
  let queueRows = [{ id: 'original-running-item' }];
  let nextId = 0, failures = 0;
  const failuresToSimulate = ['lost-ack', 'pending', 'conflict', 'delivered'];
  for (const failure of failuresToSimulate) {
    const result = await submission.run({
      fingerprint: 'same-payload', createRequestId: () => `request-${++nextId}`,
      sending: () => {},
      request: async clientRequestId => {
        seenIds.push(clientRequestId);
        if (failure === 'lost-ack') throw new TypeError('connection lost after POST');
        if (failure === 'conflict') throw Object.assign(new Error('HTTP 409'), { status: 409 });
        return parseComposerMessageAcceptance({ delivery: { ...delivery, clientRequestId,
          status: failure === 'pending' ? 'pending' : 'delivered' } }, { ...expected, clientRequestId });
      },
      accepted: accepted => {
        if (accepted.kind === 'queued') queueRows = [...queueRows, ...accepted.items];
        prompt = '';
        attachments = removeAcknowledgedAttachments(attachments, new Set(['sent-file']), () => {});
      },
      failed: () => { failures++; }, refresh: () => {}, backgroundFailed: error => { throw error; },
    });
    assert.equal(result, failure === 'delivered');
    assert.equal(prompt, failure === 'delivered' ? '' : 'neutral follow-up');
    assert.equal(attachments.length, failure === 'delivered' ? 0 : 1);
    assert.deepEqual(queueRows, [{ id: 'original-running-item' }]);
  }
  assert.equal(failures, 3);
  assert.deepEqual(seenIds, ['request-1', 'request-1', 'request-1', 'request-1']);
});

test('an unresolved request stays on its original endpoint across catalog capability changes', () => {
  const pins = createComposerMessageEndpointPins();
  const id = 'request-a';
  assert.equal(pins.read(id), undefined);
  assert.equal(pins.pin(id, composerMessageEndpoint(normalSend)), '/api/codex/messages');
  const legacyEndpoint = composerMessageEndpoint({ ...normalSend, supportsLiveInput: false });
  assert.equal(legacyEndpoint, '/api/codex/queue/items');
  assert.equal(pins.pin(id, legacyEndpoint), '/api/codex/messages');
  assert.equal(pins.read(id), '/api/codex/messages');
  assert.equal(pins.release(id), true);
  assert.equal(pins.read(id), undefined);
  assert.equal(pins.pin('legacy-request', legacyEndpoint), '/api/codex/queue/items');
  assert.equal(pins.pin('legacy-request', '/api/codex/messages'), '/api/codex/queue/items');
});

test('only explicit proven non-delivery errors release the ID for the next manual send', async () => {
  for (const code of ['LIVE_TURN_ENDED', 'LIVE_INPUT_REJECTED']) {
    const submission = createDurableQueueSubmission(), pins = createComposerMessageEndpointPins();
    const seen: string[] = [];
    let nextId = 0, prompt = 'neutral message', attemptRequestId = '';
    const options = {
      fingerprint: 'same-payload', createRequestId: () => `request-${++nextId}`, sending: () => {},
      request: async (requestId: string) => {
        attemptRequestId = requestId;
        seen.push(requestId);
        pins.pin(requestId, '/api/codex/messages');
        throw Object.assign(new Error('not delivered'), { code, status: 409 });
      },
      accepted: () => { prompt = ''; },
      failed: (error: unknown) => {
        if (composerMessageProvenNotDelivered(error, pins.read(attemptRequestId))) {
          submission.releaseUnresolved('same-payload', attemptRequestId);
          pins.release(attemptRequestId);
        }
      },
      refresh: () => {}, backgroundFailed: (error: unknown) => { throw error; },
    };
    assert.equal(await submission.run(options), false);
    assert.equal(prompt, 'neutral message');
    assert.deepEqual(seen, ['request-1']); // No automatic resend.
    assert.equal(await submission.run(options), false);
    assert.deepEqual(seen, ['request-1', 'request-2']);
  }
  for (const error of [new TypeError('lost ACK'), { status: 409 }, { status: 409, code: 'LIVE_INPUT_UNCONFIRMED' },
    { status: 409, code: 'LIVE_INPUT_CONFLICT' }, { status: 503, code: 'LIVE_INPUT_UNAVAILABLE' }, { status: 500, code: 'LIVE_TURN_ENDED' }]) {
    assert.equal(composerMessageProvenNotDelivered(error, '/api/codex/messages'), false);
  }
  assert.equal(composerMessageProvenNotDelivered({ status: 409, code: 'LIVE_TURN_ENDED' }, '/api/codex/queue/items'), false);
});

test('a late active acknowledgement after navigation cannot clear the other composer or refresh it', async () => {
  const submission = createDurableQueueSubmission(), scope = createQueueRequestScope();
  scope.setScope('server/profile/session-a');
  const ticket = scope.capture('server/profile/session-a');
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>(yes => { resolve = yes; });
  let prompt = 'original message', refreshes = 0;
  const send = submission.run({
    fingerprint: 'neutral-send', createRequestId: () => expected.clientRequestId, sending: () => {},
    request: async () => parseComposerMessageAcceptance(await response, expected),
    accepted: () => { if (scope.acknowledged(ticket)) prompt = ''; },
    failed: error => { throw error; },
    refresh: () => { if (scope.current(ticket)) refreshes++; }, backgroundFailed: error => { throw error; },
  });
  scope.setScope('server/profile/session-b');
  prompt = 'new conversation draft';
  resolve({ delivery });
  assert.equal(await send, true);
  assert.equal(prompt, 'new conversation draft');
  assert.equal(refreshes, 0);
});

test('actual composer uses the tested discriminant, guarded clearing and fresh persisted timeline read', async () => {
  const source = await readFile('client/src/components/codex/CodexMobileApp.tsx', 'utf8');
  const send = source.slice(source.indexOf('async function enqueueCurrentPrompt('), source.indexOf('async function continueAbortedSession('));
  assert.match(send, /composerMessageEndpoint\(/);
  assert.match(send, /request<unknown>\(endpoint,/);
  assert.match(send, /parseComposerMessageAcceptance<CodexQueueServerItem>\(data,/);
  assert.match(send, /if \(!queueRequestScope\.acknowledged\(sendTicket\)\) return;/);
  assert.match(send, /if \(accepted\.kind === 'active-turn'\) \{\s+setComposerDeliveryNotice\(sendTicket\);\s+\} else \{\s+startTransition/);
  assert.match(send, /loadQueueItems\(profileId,/);
  assert.match(send, /activeDeliverySessionId \? loadSessionDetail\(activeDeliverySessionId, profileId, \{ silent: true, fresh: true \}\)/);
  assert.match(send, /setPrompt\(\(current\) => current === prompt \? '' : current\)/);
  assert.match(send, /removeAcknowledgedAttachments\(current, sentAttachmentIds,/);
  assert.match(send, /if \(!saveAsDraft && accepted\.kind === 'queued'\) clearSessionContextSelectionAfterSend/);
  assert.match(send, /const endpoint = pinnedEndpoint \|\| composerMessageEndpoint/);
  assert.match(send, /composerMessageEndpointPins\.pin\(clientRequestId, endpoint\)/);
  assert.match(send, /queueSubmission\.releaseUnresolved\(submissionFingerprint, attemptRequestId\)/);
  assert.match(source, /הבחירה תחול על התור הבא/);
  assert.doesNotMatch(source, /הבחירה תחול על ההודעה הבאה/);
});
