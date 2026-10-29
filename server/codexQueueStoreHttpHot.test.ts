import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { installOwnerQueueHttp } from './codexQueueStoreHttpHot.mjs';
import { selectQueueWorkspaceView, selectQueueHistoryPage } from './queueWorkspaceSelection.js';
import { createCodexDeploymentHttpTracker } from './codexDeploymentDrain.mjs';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('hot owner HTTP bridge preserves authorization and legacy while compact/history read only raw owner state', async t => {
  const at = '2026-10-29T09:00:00Z';
  const item = (id: string, status = 'failed', extra = {}) => ({ id, profileId: 'developer', sessionId: 'session-' + id,
    queueKey: 'session-' + id, status, createdAt: at, updatedAt: at, prompt: 'full input ' + id, ...extra });
  const rows = Array.from({ length: 300 }, (_, index) => item(String(index).padStart(3, '0')));
  rows.push(item('running', 'running'), item('draft', 'draft', { queueKey: 'draft:current', sessionId: 'resolved-session' }),
    item('other-profile', 'running', { profileId: 'developer2' }));
  const router = express.Router();
  let legacyCalls = 0;
  const auth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization !== 'Synthetic test authorization') { res.status(401).json({ denied: true }); return; }
    next();
  };
  router.get('/queue/items', auth, (_req, res) => { legacyCalls++; res.json({ legacy: true, items: rows }); });
  let commits = 0;
  let enqueue = async (_input: unknown) => ({ id: 'same-stable-id' });
  const initialEnqueue = enqueue;
  let persistence = Promise.resolve();
  let loading = Promise.resolve();
  let active = 0;
  const authority = { registerParticipant() {}, acquireHttpAdmission() {
    active++; return { release() { active--; }, assertActive() {} };
  } };
  const tracker = createCodexDeploymentHttpTracker(authority);
  const scope = {
    router, getState: () => ({ items: rows }), ensureStateLoaded: () => loading,
    normalizeSessionBindingKey: (value: string) => value || null,
    resolveSessionBindingFromState: (value: string) => value === 'draft:current' ? 'resolved-session' : value,
    sortQueueItems: (items: typeof rows) => [...items].sort((a, b) => a.id.localeCompare(b.id)),
    toCodexQueueListItem: (row: (typeof rows)[number], details: boolean) => ({ id: row.id, status: row.status,
      profileId: row.profileId, prompt: details ? row.prompt : '', detailsIncluded: details }),
    requireCodexAccess: auth,
    getEnqueue: () => enqueue, setEnqueue: (value: typeof enqueue) => { enqueue = value; },
    persist: () => { commits++; return persistence; },
    wrapHandler: (handle: Function) => {
      const layer = { handle }; tracker.wrapHandlers({ stack: [{ route: { stack: [layer] } }] }); return layer.handle;
    },
  };
  tracker.wrapHandlers(router);
  const app = express(); app.use(tracker.middleware); app.use('/api/codex', router);
  const receipt = installOwnerQueueHttp(scope, { selectQueueWorkspaceView, selectQueueHistoryPage });
  assert.equal(receipt.asyncTracking, true);
  assert.equal(installOwnerQueueHttp(scope, { selectQueueWorkspaceView, selectQueueHistoryPage }), receipt);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/codex`;
  const read = (url: string, authorized = true) => fetch(base + url, {
    headers: authorized ? { Authorization: 'Synthetic test authorization' } : {},
  });

  await t.test('authorization is retained for patched and new endpoints', async () => {
    assert.equal((await read('/queue/items?view=compact', false)).status, 401);
    assert.equal((await read('/queue/history', false)).status, 401);
    assert.equal(legacyCalls, 0);
  });
  await t.test('legacy response is byte-for-contract unchanged; compact response bounds only terminal rows', async () => {
    const legacy = await (await read('/queue/items?profile=developer')).json();
    assert.equal(legacy.legacy, true); assert.equal(legacy.items.length, 303); assert.equal(legacyCalls, 1);
    const compact = await (await read('/queue/items?profile=developer&view=compact&queueKey=draft%3Acurrent')).json();
    assert.equal(compact.items.length, 22); assert.equal(compact.boundSessionId, 'resolved-session');
    assert.equal(compact.history.totalTerminal, 300);
    assert.ok(compact.items.some((row: { id: string }) => row.id === 'running'));
    assert.equal(compact.items.some((row: { id: string }) => row.id === 'other-profile'), false);
    assert.equal(compact.items.find((row: { id: string }) => row.id === 'draft').detailsIncluded, true);
    assert.equal(legacyCalls, 1); assert.equal(commits, 0);
  });
  await t.test('history is authorized, paginated, and rejects invalid cursor without any writes', async () => {
    const first = await (await read('/queue/history?profile=developer&limit=13')).json();
    assert.equal(first.items.length, 13); assert.equal(first.total, 300); assert.ok(first.nextCursor);
    const second = await (await read('/queue/history?profile=developer&limit=13&cursor=' + first.nextCursor)).json();
    assert.equal(second.items.length, 13);
    assert.equal(first.items.some((one: { id: string }) => second.items.some((two: { id: string }) => one.id === two.id)), false);
    assert.equal((await read('/queue/history?cursor=invalid!')).status, 400);
    assert.equal(commits, 0);
  });
  await t.test('deduped enqueue result cannot resolve before durable owner barrier and propagates commit failure', async () => {
    const gate = deferred(); persistence = gate.promise;
    let settled = false; const result = enqueue({ clientRequestId: 'same-id' }).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    gate.resolve(); assert.deepEqual(await result, { id: 'same-stable-id' });
    const failure = deferred(); persistence = failure.promise;
    const rejected = enqueue({ clientRequestId: 'same-id' }); failure.reject(new Error('Synthetic persistence failure'));
    await assert.rejects(rejected, /Synthetic persistence failure/);
    persistence = Promise.resolve();
  });
  await t.test('aborted compact socket remains tracked until actual async handler settles', async () => {
    assert.equal(active, 0, 'earlier HTTP handler remained active');
    const gate = deferred(); loading = gate.promise;
    const controller = new AbortController();
    const pending = fetch(base + '/queue/items?view=compact', { headers: { Authorization: 'Synthetic test authorization' }, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort(); await assert.rejects(pending);
    assert.ok(active > 0, 'socket abort released unfinished compact handler');
    gate.resolve(); loading = Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(active, 0);
  });
  await t.test('uninstall restores only this bridge and the original enqueue', async () => {
    receipt.uninstall(); assert.equal(receipt.installed, false); assert.equal(enqueue, initialEnqueue);
    const legacy = await (await read('/queue/items?view=compact')).json(); assert.equal(legacy.legacy, true);
    assert.equal((await read('/queue/history')).status, 404);
  });
});
