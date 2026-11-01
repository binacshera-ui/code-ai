import assert from 'node:assert/strict';
import test from 'node:test';
import { installDecisionBoardLiveBridge } from './decisionBoardLiveBridge.mjs';

function fixture(overrides = {}) {
  const calls = [], router = { stack: [] }, marker = { prior: true };
  let prompt = async (...args) => { calls.push(['flowPrompt', ...args]); return 'FLOW'; };
  let ingest = async (...args) => { calls.push(['flowIngest', ...args]); return marker; };
  let rebind = async (...args) => { calls.push(['flowRebind', ...args]); };
  let routesRemoved = 0;
  const original = { prompt, ingest, rebind };
  const scope = { router, requireAccess() {}, findProfile: () => ({}),
    resolveSessionKey: async value => value, enqueue: async input => { calls.push(['enqueue', input]); return { id: 'owned' }; },
    wrapHandler: value => value, getFlowPromptBuilder: () => prompt, setFlowPromptBuilder: value => { prompt = value; },
    getFlowIngest: () => ingest, setFlowIngest: value => { ingest = value; },
    getFlowRebind: () => rebind, setFlowRebind: value => { rebind = value; } };
  const domain = {
    buildSessionDecisionBoardPromptAdditions: async (...args) => { calls.push(['decisionPrompt', ...args]); return 'DECISIONS'; },
    ingestSessionDecisionBoardFromText: async (...args) => { calls.push(['decisionIngest', ...args]); return { board: true }; },
    rebindSessionDecisionBoard: async (...args) => { calls.push(['decisionRebind', ...args]); },
    installSessionDecisionBoardRoutes(target, dependencies, suppliedDomain) {
      assert.equal(target, router); assert.equal(suppliedDomain, domain);
      calls.push(['install', dependencies]);
      target.stack.push({ route: { path: '/session-decisions' } });
      const layer = target.stack.at(-1);
      return { uninstall() { routesRemoved++; const index = target.stack.indexOf(layer); if (index >= 0) target.stack.splice(index, 1); } };
    }, ...overrides,
  };
  return { calls, router, marker, scope, domain, original,
    get prompt() { return prompt; }, get ingest() { return ingest; }, get rebind() { return rebind; },
    get routesRemoved() { return routesRemoved; } };
}

test('adds the decision context when Flow is active and preserves existing arguments/order', async () => {
  const f = fixture(); installDecisionBoardLiveBridge(f.scope, f.domain);
  assert.equal(await f.prompt('profile', 'session'), 'FLOW\n\nDECISIONS');
  assert.deepEqual(f.calls.slice(-2), [['flowPrompt', 'profile', 'session'], ['decisionPrompt', 'profile', 'session']]);
});

test('decision context works when Flow is disabled, and absent decision context preserves the original value', async () => {
  const f = fixture(); f.scope.setFlowPromptBuilder(async () => null);
  installDecisionBoardLiveBridge(f.scope, f.domain);
  assert.equal(await f.prompt('p', 's'), 'DECISIONS');
  const empty = fixture({ buildSessionDecisionBoardPromptAdditions: async () => null });
  installDecisionBoardLiveBridge(empty.scope, empty.domain);
  assert.equal(await empty.prompt('p', 's'), 'FLOW');
});

test('ingestion preserves Flow execution target and return type while writing decision text once', async () => {
  const f = fixture(); installDecisionBoardLiveBridge(f.scope, f.domain);
  const target = { mapId: 'map', mapRevision: 7 };
  assert.equal(await f.ingest('p', 's', 'agent text', target), f.marker);
  assert.deepEqual(f.calls.slice(-2), [['flowIngest', 'p', 's', 'agent text', target], ['decisionIngest', 'p', 's', 'agent text']]);
});

test('draft binding reaches both domains in the exact same profile/session scope', async () => {
  const f = fixture(); installDecisionBoardLiveBridge(f.scope, f.domain);
  await f.rebind('visible-profile', 'draft:key', 'real-session');
  assert.deepEqual(f.calls.slice(-2), [['flowRebind', 'visible-profile', 'draft:key', 'real-session'],
    ['decisionRebind', 'visible-profile', 'draft:key', 'real-session']]);
});

test('a repeated installation is idempotent and routes receive only the injected durable enqueue', async () => {
  const f = fixture(); const first = installDecisionBoardLiveBridge(f.scope, f.domain);
  assert.equal(installDecisionBoardLiveBridge(f.scope, f.domain), first);
  assert.equal(f.calls.filter(value => value[0] === 'install').length, 1);
  const dependencies = f.calls.find(value => value[0] === 'install')[1];
  assert.equal((await dependencies.enqueue({ clientRequestId: 'stable' })).id, 'owned');
  assert.deepEqual(f.calls.at(-1), ['enqueue', { clientRequestId: 'stable' }]);
  assert.equal(first.queueWriterImported, false); assert.equal(first.asyncTracking, true);
});

test('rollback removes only owned routes/hooks, preserves later hook changes and never deletes domain records', () => {
  const f = fixture(); const installed = installDecisionBoardLiveBridge(f.scope, f.domain);
  const successorPrompt = () => 'later'; f.scope.setFlowPromptBuilder(successorPrompt);
  f.router.stack.push({ route: { path: '/unrelated' } });
  installed.uninstall(); installed.uninstall();
  assert.equal(f.prompt, successorPrompt); assert.equal(f.ingest, f.original.ingest); assert.equal(f.rebind, f.original.rebind);
  assert.equal(f.routesRemoved, 1); assert.deepEqual(f.router.stack.map(value => value.route.path), ['/unrelated']);
});

test('preexisting routes or missing ownership capabilities fail before changing bindings', () => {
  const f = fixture(); f.router.stack.push({ route: { path: '/session-decisions' } });
  assert.throws(() => installDecisionBoardLiveBridge(f.scope, f.domain), /already exist/);
  assert.equal(f.prompt, f.original.prompt); assert.equal(f.calls.length, 0);
  const missing = fixture(); delete missing.scope.enqueue;
  assert.throws(() => installDecisionBoardLiveBridge(missing.scope, missing.domain), /enqueue/);
  assert.equal(missing.calls.length, 0);
});

test('optional decision conflict never changes a successful Flow/native outcome and logs no contents', async () => {
  const conflict = Object.assign(new Error('private decision content must not escape'), { statusCode: 409 });
  const f = fixture({ ingestSessionDecisionBoardFromText: async () => { throw conflict; },
    rebindSessionDecisionBoard: async () => { throw conflict; } });
  const failures = []; f.scope.reportDecisionFailure = value => failures.push(value);
  installDecisionBoardLiveBridge(f.scope, f.domain);
  assert.equal(await f.ingest('p', 's', 'private text'), f.marker);
  assert.equal(await f.rebind('p', 'draft', 'real'), undefined);
  assert.deepEqual(failures, [{ operation: 'ingest', statusCode: 409 }, { operation: 'rebind', statusCode: 409 }]);
});
