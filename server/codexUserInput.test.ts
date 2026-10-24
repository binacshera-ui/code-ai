import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_USER_INPUT_LIMITS } from '../shared/codexUserInput.js';
import { CodexUserInputError, CodexUserInputRegistry, type CodexNativeUserInputParams } from './codexUserInput.js';

const scope = { profileId: 'codex-a', sessionId: 'session-a', runId: 'run-a' };

function params(overrides: Partial<CodexNativeUserInputParams> = {}): CodexNativeUserInputParams {
  return {
    threadId: scope.sessionId, turnId: 'turn-a', itemId: 'item-a', isBlocking: true,
    questions: [{ id: 'destination', header: 'Destination', question: 'Where should the output go?', isOther: true, isSecret: false,
      options: [{ label: 'Local', description: 'Keep it here' }, { label: 'Remote', description: 'Use another host' }] }],
    ...overrides,
  };
}

test('native answers stay in the same request; retries are idempotent and differently answered retries conflict', async () => {
  const registry = new CodexUserInputRegistry();
  const sent: unknown[] = [];
  const request = registry.register(scope, 7, params(), response => { sent.push(response); });
  const answers = { destination: { answers: ['Custom path'] } };
  const answered = await registry.answer({ ...scope, requestId: request.id, answers });
  assert.equal(answered.request.status, 'answered');
  assert.equal(answered.duplicate, false);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ answers }]);
  const duplicate = await registry.answer({ ...scope, requestId: request.id, answers });
  assert.equal(duplicate.duplicate, true);
  assert.equal(sent.length, 1);
  await assert.rejects(registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } }),
    (error: unknown) => error instanceof CodexUserInputError && error.code === 'answer_conflict');
});

test('concurrent identical submissions write once and await the same transport delivery', async () => {
  const registry = new CodexUserInputRegistry();
  let sends = 0;
  let deliver!: () => void;
  const delivered = new Promise<void>(resolve => { deliver = resolve; });
  const request = registry.register(scope, 'native', params(), async () => { sends++; await delivered; });
  const input = { ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } };
  const first = registry.answer(input);
  const second = registry.answer(input);
  await Promise.resolve();
  assert.equal(sends, 1);
  deliver();
  assert.equal((await first).duplicate, false);
  assert.equal((await second).duplicate, true);
});

test('profile/session/run scoping and child thread resolution prevent cross-conversation answers', async () => {
  const registry = new CodexUserInputRegistry();
  const child = registry.register(scope, 1, params({ threadId: 'child-thread' }), () => {});
  const other = registry.register({ ...scope, runId: 'run-b' }, 1, params(), () => {});
  await assert.rejects(registry.answer({ ...scope, profileId: 'codex-b', requestId: child.id,
    answers: { destination: { answers: ['Local'] } } }), (error: unknown) => error instanceof CodexUserInputError && error.httpStatus === 404);
  await assert.rejects(registry.answer({ ...scope, sessionId: 'session-b', requestId: child.id,
    answers: { destination: { answers: ['Local'] } } }), (error: unknown) => error instanceof CodexUserInputError && error.httpStatus === 404);
  registry.resolveNative(scope, 1, 'unrelated-child');
  assert.equal(registry.list(scope.profileId, scope.sessionId).pendingCount, 2);
  registry.resolveNative(scope, 1, 'child-thread');
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests.find(request => request.id === child.id)?.status, 'expired');
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests.find(request => request.id === other.id)?.status, 'pending');
});

test('secret answer bytes are delivered verbatim, never exposed in resolved snapshots, and remain retry-safe', async () => {
  const registry = new CodexUserInputRegistry();
  const secret = '  confidential-value  ';
  const prompt = 'secret-prompt-sentinel';
  let sent = '';
  const request = registry.register(scope, 1, params({ questions: [
    { id: 'secret', header: prompt, question: prompt, isOther: false, isSecret: true, options: null },
  ] }), response => { sent = response.answers.secret.answers[0]; });
  const input = { ...scope, requestId: request.id, answers: { secret: { answers: [secret] } } };
  await registry.answer(input);
  assert.equal(sent, secret);
  const snapshot = JSON.stringify(registry.list(scope.profileId, scope.sessionId));
  assert.equal(snapshot.includes(secret), false);
  assert.equal(snapshot.includes(prompt), false);
  assert.equal(snapshot.includes('[redacted]'), true);
  assert.equal((await registry.answer(input)).duplicate, true);
});

test('fixed choices, missing/unknown IDs, blank answers, malformed arrays and limits reject before transport', async () => {
  const registry = new CodexUserInputRegistry();
  let sends = 0;
  const request = registry.register(scope, 1, params({ questions: params().questions.map(question => ({ ...question, isOther: false })) }), () => { sends++; });
  const invalid = [
    {}, { wrong: { answers: ['Local'] } }, { destination: { answers: ['Other'] } },
    { destination: { answers: [''] } }, { destination: { answers: ['Local', 'Remote'] } },
    { destination: { answers: 'Local' } }, { destination: { answers: ['Local'], extra: true } },
    { destination: { answers: ['x'.repeat(CODEX_USER_INPUT_LIMITS.answerText + 1)] } },
  ];
  for (const answers of invalid) await assert.rejects(registry.answer({ ...scope, requestId: request.id, answers }), CodexUserInputError);
  assert.equal(sends, 0);
  assert.equal(registry.list(scope.profileId, scope.sessionId).pendingCount, 1);
});

test('unsupported request shapes and duplicate question IDs are rejected; empty options mean free text', async () => {
  const registry = new CodexUserInputRegistry();
  assert.throws(() => registry.register(scope, 1, params({ questions: [params().questions[0], params().questions[0]] }), () => {}), CodexUserInputError);
  assert.throws(() => registry.register(scope, 1, { ...params(), isBlocking: undefined }, () => {}), CodexUserInputError);
  const request = registry.register(scope, 1, params({ isBlocking: false, questions: [{ ...params().questions[0], options: [] }] }), () => {});
  await registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Free text'] } } });
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests[0].isBlocking, false);
});

test('run end and native resolution expire unanswered requests without manufacturing an answer', async () => {
  const registry = new CodexUserInputRegistry();
  let sends = 0;
  const request = registry.register(scope, 1, params(), () => { sends++; });
  registry.clearRun(scope.runId, 'cancelled', 'run_cancelled', scope.profileId);
  assert.equal(sends, 0);
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests[0].status, 'cancelled');
  await assert.rejects(registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } }),
    (error: unknown) => error instanceof CodexUserInputError && error.code === 'request_expired');
});

test('failed native delivery is explicit and cannot be replayed silently', async () => {
  const registry = new CodexUserInputRegistry();
  let sends = 0;
  const request = registry.register(scope, 1, params(), () => { sends++; throw new Error('private-diagnostic'); });
  const input = { ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } };
  await assert.rejects(registry.answer(input), (error: unknown) => error instanceof Error && !error.message.includes('private-diagnostic'));
  await assert.rejects(registry.answer(input), CodexUserInputError);
  assert.equal(sends, 1);
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests[0].status, 'failed');
});

test('native expiry racing an in-flight write cannot be reported as an accepted answer', async () => {
  const registry = new CodexUserInputRegistry();
  let deliver!: () => void;
  const delivery = new Promise<void>(resolve => { deliver = resolve; });
  const request = registry.register(scope, 1, params(), () => delivery);
  const result = registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } });
  const rejected = assert.rejects(result, (error: unknown) => error instanceof CodexUserInputError && error.code === 'request_expired');
  await Promise.resolve();
  registry.resolveNative(scope, 1);
  deliver();
  await rejected;
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests[0].status, 'expired');
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests[0].answers, undefined);
});

test('bounded retention and TTL keep history finite while preserving active requests', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const registry = new CodexUserInputRegistry({ now: () => now, maxEntries: 3, maxPendingPerRun: 2, maxResolvedPerSession: 1, resolvedTtlMs: 100 });
  registry.register(scope, 1, params(), () => {});
  registry.register(scope, 2, params(), () => {});
  assert.throws(() => registry.register(scope, 3, params(), () => {}), (error: unknown) => error instanceof CodexUserInputError && error.code === 'request_capacity');
  registry.clearRun(scope.runId);
  assert.equal(registry.list(scope.profileId, scope.sessionId).requests.length, 1);
  registry.register({ ...scope, runId: 'next-run' }, 1, params(), () => {});
  now += 101;
  const snapshot = registry.list(scope.profileId, scope.sessionId);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.pendingCount, 1);
});

test('opaque IDs safely support special JavaScript property names', async () => {
  const registry = new CodexUserInputRegistry();
  const request = registry.register(scope, 1, params({ questions: [{ ...params().questions[0], id: '__proto__', options: null }] }), () => {});
  const answers = JSON.parse('{"__proto__":{"answers":["Safe answer"]}}');
  const result = await registry.answer({ ...scope, requestId: request.id, answers });
  assert.deepEqual(result.request.answers?.['__proto__'].answers, ['Safe answer']);
});

test('proven native recovery reattaches only the unanswered detached question with the same UI ID', async () => {
  const registry = new CodexUserInputRegistry();
  let oldSends = 0;
  let newSends = 0;
  const request = registry.register(scope, 8, params(), () => { oldSends++; });
  registry.clearRun(scope.runId, 'failed', 'native_detached', scope.profileId);
  assert.equal(registry.register(scope, 8, params(), () => {}).status, 'failed');
  const recovered = registry.register(scope, 8, params(), () => { newSends++; }, { reattachDetached: true });
  assert.equal(recovered.id, request.id);
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.resolvedAt, null);
  assert.equal(recovered.resolutionReason, undefined);
  await registry.answer({ ...scope, requestId: recovered.id, answers: { destination: { answers: ['Local'] } } });
  assert.equal(oldSends, 0);
  assert.equal(newSends, 1);
  const again = registry.register(scope, 8, params(), () => { newSends++; }, { reattachDetached: true });
  assert.equal(again.status, 'answered');
  assert.equal(newSends, 1);
});

test('reattachment rejects changed turn, item, question or blocking metadata without replacing the question', () => {
  for (const changed of [
    params({ turnId: 'foreign-turn' }), params({ itemId: 'foreign-item' }), params({ isBlocking: false }),
    params({ questions: [{ ...params().questions[0], question: 'Different question' }] }),
  ]) {
    const registry = new CodexUserInputRegistry();
    registry.register(scope, 8, params(), () => {});
    registry.clearRun(scope.runId, 'failed', 'native_detached', scope.profileId);
    assert.throws(() => registry.register(scope, 8, changed, () => {}, { reattachDetached: true }),
      (error: unknown) => error instanceof CodexUserInputError && error.code === 'request_conflict');
    assert.equal(registry.list(scope.profileId, scope.sessionId).pendingCount, 0);
  }
});

test('native recovery cannot resurrect resolved, cancelled or delivery-uncertain requests', async () => {
  for (const status of ['cancelled', 'expired', 'failed'] as const) {
    const registry = new CodexUserInputRegistry();
    registry.register(scope, 8, params(), () => {});
    registry.clearRun(scope.runId, status, status === 'expired' ? 'provider_resolved' : 'run_ended', scope.profileId);
    assert.equal(registry.register(scope, 8, params(), () => {}, { reattachDetached: true }).status, status);
  }
  const registry = new CodexUserInputRegistry();
  const request = registry.register(scope, 8, params(), () => { throw new Error('synthetic delivery failure'); });
  await assert.rejects(registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } }));
  assert.equal(registry.register(scope, 8, params(), () => {}, { reattachDetached: true }).status, 'failed');
});

test('reattachment restores a secret prompt only while pending and still enforces capacity', () => {
  const registry = new CodexUserInputRegistry({ maxPendingPerRun: 1 });
  const secretParams = params({ questions: [{ ...params().questions[0], isSecret: true, question: 'synthetic-private-question' }] });
  const request = registry.register(scope, 8, secretParams, () => {});
  registry.clearRun(scope.runId, 'failed', 'native_detached', scope.profileId);
  assert.equal(JSON.stringify(registry.list(scope.profileId, scope.sessionId)).includes('synthetic-private-question'), false);
  registry.register(scope, 9, params(), () => {});
  assert.throws(() => registry.register(scope, 8, secretParams, () => {}, { reattachDetached: true }),
    (error: unknown) => error instanceof CodexUserInputError && error.code === 'request_capacity');
  registry.resolveNative(scope, 9);
  const recovered = registry.register(scope, 8, secretParams, () => {}, { reattachDetached: true });
  assert.equal(recovered.id, request.id);
  assert.equal(recovered.questions[0].question, 'synthetic-private-question');
  registry.clearRun(scope.runId, 'failed', 'native_detached', scope.profileId);
  assert.equal(JSON.stringify(registry.list(scope.profileId, scope.sessionId)).includes('synthetic-private-question'), false);
});

test('native detach during an answer write never reattaches an uncertain delivery', async () => {
  const registry = new CodexUserInputRegistry();
  let complete!: () => void;
  let reboundSends = 0;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const request = registry.register(scope, 8, params(), () => waiting);
  const answering = registry.answer({ ...scope, requestId: request.id, answers: { destination: { answers: ['Local'] } } });
  const failed = assert.rejects(answering, CodexUserInputError);
  await Promise.resolve();
  registry.clearRun(scope.runId, 'failed', 'native_detached', scope.profileId);
  const replay = registry.register(scope, 8, params(), () => { reboundSends++; }, { reattachDetached: true });
  assert.equal(replay.status, 'failed');
  complete();
  await failed;
  assert.equal(reboundSends, 0);
  assert.equal(registry.list(scope.profileId, scope.sessionId).pendingCount, 0);
});
