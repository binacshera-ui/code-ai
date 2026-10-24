import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {saveWorkModePreferences, type WorkModeRequest} from './workModeTransport.ts';
import {createScopedPreferenceRequests} from './scopedPreferenceRequests.ts';
import {emptyWorkModePreferences, workModePatch, type WorkModeKind} from './workModePreferences.ts';

function legacyEndpoint() {
  let mode = {...emptyWorkModePreferences(), enabled: true, goal: 'Preserve engineering goal', decisionEnabled: true};
  const calls: {server: string; url: string; init?: RequestInit}[] = [];
  const request: WorkModeRequest = async <T>(server: string, url: RequestInfo, init?: RequestInit) => {
    calls.push({server, url: String(url), init});
    if (init?.method === 'POST') {
      const {profileId, sessionKey, focusMode} = JSON.parse(String(init.body));
      // Same required-body contract as the live route, not a permissive mock.
      assert.ok(profileId && sessionKey);
      assert.equal(typeof focusMode.enabled, 'boolean');
      assert.equal(typeof focusMode.goal, 'string');
      assert.ok(focusMode.goal.length <= 2000);
      mode = {...mode, ...focusMode};
    }
    return {focusMode: {...mode}} as T;
  };
  return {request, calls, mode: () => mode};
}

for (const kind of ['rational', 'decision', 'focus'] as WorkModeKind[]) {
  test(`${kind} saves through the required legacy contract and preserves other modes`, async () => {
    const api = legacyEndpoint(), before = {...api.mode()};
    const draft = {...before, rationalEnabled: true, decisionEnabled: false, enabled: false, goal: 'Updated goal'};
    const patch = workModePatch(kind, draft);
    const result = await saveWorkModePreferences(api.request, 'remote-a', 'p', 's', patch, () => true);
    assert.deepEqual(result, {...before, ...patch});
    assert.deepEqual(api.mode(), {...before, ...patch});
    assert.equal(api.calls.length, 2);
    assert.equal(api.calls[0].init?.cache, 'no-store');
    assert.ok(api.calls.every(x => x.server === 'remote-a'));
    const body = JSON.parse(String(api.calls[1].init?.body));
    assert.deepEqual(body.focusMode, {enabled: before.enabled, goal: before.goal, ...patch});
  });
}

test('reads canonical required fields rather than a stale editor snapshot', async () => {
  const api = legacyEndpoint();
  const result = await saveWorkModePreferences(api.request, 'remote-b', 'p + א', 'session/א', {decisionEnabled: false}, () => true);
  assert.equal(result?.goal, 'Preserve engineering goal');
  assert.equal(result?.enabled, true);
  const query = new URL(api.calls[0].url, 'https://example.test').searchParams;
  assert.equal(query.get('profileId'), 'p + א');
  assert.equal(query.get('sessionKey'), 'session/א');
});

test('navigation during required-fields read prevents POST, including a returned visit', async () => {
  const guard = createScopedPreferenceRequests(); guard.setScope('one');
  const ticket = guard.beginWrite('one')!;
  let posts = 0;
  const request: WorkModeRequest = async <T>(_server: string, _url: RequestInfo, init?: RequestInit) => {
    if (init?.method === 'POST') posts++;
    guard.setScope('other'); guard.setScope('one');
    return {focusMode: emptyWorkModePreferences()} as T;
  };
  assert.equal(await saveWorkModePreferences(request, 'local', 'p', 's', {rationalEnabled: true}, () => guard.current(ticket)), null);
  assert.equal(posts, 0);
});

test('navigation after POST cannot report successful save in another conversation', async () => {
  let current = true;
  const api = legacyEndpoint();
  const request: WorkModeRequest = async <T>(...args: Parameters<WorkModeRequest>) => {
    const result = await api.request<T>(...args);
    if (args[2]?.method === 'POST') current = false;
    return result;
  };
  assert.equal(await saveWorkModePreferences(request, 'local', 'p', 's', {decisionEnabled: false}, () => current), null);
  assert.equal(api.calls.length, 2);
});

test('failed or malformed GET never falls back to defaults and never writes', async () => {
  for (const failure of [new Error('offline'), null]) {
    let calls = 0;
    const request: WorkModeRequest = async <T>() => {calls++; if (failure) throw failure; return {focusMode: {}} as T;};
    await assert.rejects(saveWorkModePreferences(request, 'local', 'p', 's', {decisionEnabled: true}, () => true));
    assert.equal(calls, 1);
  }
});

test('uncertain or refused POST is surfaced once, never automatically resent', async () => {
  let posts = 0;
  const request: WorkModeRequest = async <T>(_server: string, _url: RequestInfo, init?: RequestInit) => {
    if (init?.method === 'POST') {posts++; throw new Error('HTTP 400');}
    return {focusMode: emptyWorkModePreferences()} as T;
  };
  await assert.rejects(saveWorkModePreferences(request, 'local', 'p', 's', {rationalEnabled: true}, () => true), /HTTP 400/);
  assert.equal(posts, 1);
});

test('missing identity or stale ticket never sends a request', async () => {
  const api = legacyEndpoint();
  for (const [profile, session, current] of [['', 's', true], ['p', '', true], ['p', 's', false]] as const) {
    assert.equal(await saveWorkModePreferences(api.request, 'local', profile, session, {}, () => current), null);
  }
  assert.equal(api.calls.length, 0);
});

test('actual React hook uses the tested save transport instead of serializing partial patches', async () => {
  const hook = await fs.readFile('client/src/components/codex/useSessionWorkModes.ts', 'utf8');
  assert.ok(hook.includes('await saveWorkModePreferences(request,serverId,profileId,sessionKey,patch,()=>guard.current(ticket))'));
  assert.ok(!hook.includes('focusMode:patch'));
});
