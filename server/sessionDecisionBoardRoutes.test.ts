import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionDecisionBoardService } from './sessionDecisionBoard.js';
import { createSessionDecisionBoardRouter } from './sessionDecisionBoardRoutes.js';

const definitions = { title: 'החלטות לבדיקה', items: [
  { id: 'approve', title: 'לבצע?', kind: 'approval', options: [] },
  { id: 'single', title: 'איזו אפשרות?', kind: 'single', options: [{ id: 'a', label: 'אחת' }, { id: 'b', label: 'שתיים' }] },
  { id: 'multiple', title: 'אילו רכיבים?', kind: 'multiple', options: [{ id: 'x', label: 'ראשון' }, { id: 'y', label: 'שני' }] },
  { id: 'text', title: 'מה דעתך?', kind: 'text', options: [] },
] };

async function fixture(t: test.TestContext, resolveSessionKey?: (key: string) => Promise<string | null>) {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'code-ai-decision-routes-'));
  const service = createSessionDecisionBoardService({ storageRoot });
  const queued: any[] = [];
  let wrapped = 0;
  const app = express(); app.use(express.json());
  app.use('/api/codex', createSessionDecisionBoardRouter({
    requireAccess: (req, res, next) => req.headers['x-test-auth'] === 'yes' ? next() : void res.status(401).json({ error: 'auth required' }),
    findProfile: profile => ['developer', 'other'].includes(profile),
    resolveSessionKey,
    enqueue: async input => { queued.push(input); return { id: 'queue-fixture-' + queued.length }; },
    wrapHandler: handler => async (req, res, next) => { wrapped++; await handler(req, res, next); },
  }, service));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as { port: number };
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(storageRoot, { recursive: true, force: true }); });
  async function request(url = '/session-decisions?profileId=developer&sessionKey=session-1', method = 'GET', body?: unknown, auth = true) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/codex${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-test-auth': 'yes' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.headers.get('content-type')?.includes('application/json'));
    return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
  }
  return { service, request, queued, storageRoot, wrapped: () => wrapped };
}

test('decisions API authenticates and validates scope without HTML fallback', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(undefined, 'GET', undefined, false)).status, 401);
  assert.equal((await f.request('/session-decisions')).status, 400);
  assert.equal((await f.request('/session-decisions?profileId=missing&sessionKey=s')).status, 404);
  const read = await f.request();
  assert.equal(read.status, 200); assert.match(read.cache || '', /no-store/);
  assert.equal(read.data.board.enabled, false); assert.deepEqual(read.data.board.items, []);
  assert.equal(f.queued.length, 0);
});

test('all answer kinds persist and reopen; explicit submit alone admits a deduplicated continuation', async t => {
  const f = await fixture(t);
  const scope = { profileId: 'developer', sessionKey: 'session-1' };
  const enabled = await f.request('/session-decisions', 'PUT', { ...scope, expectedRevision: 0, enabled: true });
  assert.equal(enabled.status, 200);
  await f.service.ingestSessionDecisionBoardFromText('developer', 'session-1', '```code-ai-decisions\n' + JSON.stringify(definitions) + '\n```');
  const read = await f.request();
  const saved = await f.request('/session-decisions', 'PUT', { ...scope, expectedRevision: read.data.board.revision, answers: [
    { decisionId: 'approve', answer: { verdict: 'rejected', optionIds: [], note: 'לא לשנות הרשאות' } },
    { decisionId: 'single', answer: { verdict: null, optionIds: ['b'], note: '' } },
    { decisionId: 'multiple', answer: { verdict: null, optionIds: ['y', 'x'], note: 'שניהם' } },
    { decisionId: 'text', answer: { verdict: null, optionIds: [], note: 'להתחיל בפשטות' } },
  ] });
  assert.equal(saved.status, 200); assert.equal(f.queued.length, 0);
  const reopened = await createSessionDecisionBoardService({ storageRoot: f.storageRoot }).getSessionDecisionBoard('developer', 'session-1');
  assert.equal(reopened.items[0].answer?.verdict, 'rejected');
  assert.equal(reopened.items[3].answer?.note, 'להתחיל בפשטות');
  const submit = { ...scope, expectedRevision: saved.data.board.revision, requestId: 'route-test-once' };
  const [one, two] = await Promise.all([
    f.request('/session-decisions/submit', 'POST', submit), f.request('/session-decisions/submit', 'POST', submit),
  ]);
  assert.equal(one.status, 202); assert.equal(two.status, 202);
  assert.equal(one.data.queueItemId, two.data.queueItemId); assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].profileId, 'developer'); assert.equal(f.queued[0].sessionId, 'session-1');
  assert.match(f.queued[0].prompt, /rejected/); assert.match(f.queued[0].prompt, /לא לשנות הרשאות/);
  assert.ok(one.data.board.items.every((item: any) => item.submittedAt));
  assert.equal((await f.service.getSessionDecisionBoard('other', 'session-1')).items.length, 0);
  assert.ok(f.wrapped() >= 5);
});

test('draft binding retains the board and stale or malformed writes do not enqueue', async t => {
  const f = await fixture(t, async key => key === 'draft-bound' ? 'session-bound' : key);
  await f.service.setSessionDecisionBoard('developer', 'draft-bound', { expectedRevision: 0, enabled: true });
  await f.service.ingestSessionDecisionBoardFromText('developer', 'draft-bound', '```code-ai-decisions\n' + JSON.stringify(definitions) + '\n```');
  const read = await f.request('/session-decisions?profileId=developer&sessionKey=draft-bound');
  assert.equal(read.status, 200); assert.equal(read.data.board.items.length, 4);
  assert.equal((await f.service.getSessionDecisionBoard('developer', 'session-bound')).items.length, 4);
  assert.equal((await f.request('/session-decisions', 'PUT', { profileId: 'developer', sessionKey: 'session-bound', expectedRevision: 0, enabled: false })).status, 409);
  assert.equal((await f.request('/session-decisions', 'PUT', { profileId: 'developer', sessionKey: 'session-bound', expectedRevision: read.data.board.revision, answers: {} })).status, 400);
  assert.equal(f.queued.length, 0);
});
