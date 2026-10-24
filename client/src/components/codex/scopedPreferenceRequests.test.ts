import assert from 'node:assert/strict';
import test from 'node:test';
import { createScopedPreferenceRequests } from './scopedPreferenceRequests.ts';
test('a slow GET cannot overwrite a newer toggle; reads wait for its save', () => {
  const g = createScopedPreferenceRequests(); g.setScope('main:p:s');
  const read = g.beginRead('main:p:s')!;
  const write = g.beginWrite('main:p:s')!;
  assert.equal(g.current(read), false);
  assert.equal(g.beginRead('main:p:s'), null);
  assert.equal(g.beginWrite('main:p:s'), null);
  g.finishWrite(write);
  assert.ok(g.beginRead('main:p:s'));
});
test('stale save/finally cannot update another server, profile, conversation or a returned visit', () => {
  for (const next of ['other:p:s', 'main:q:s', 'main:p:t']) {
    const g = createScopedPreferenceRequests(); g.setScope('main:p:s');
    const old = g.beginWrite('main:p:s')!;
    g.setScope(next);
    const current = g.beginWrite(next)!;
    g.finishWrite(old);
    assert.equal(g.current(old), false);
    assert.equal(g.beginRead(next), null);
    g.finishWrite(current);
    g.setScope('main:p:s');
    assert.equal(g.current(old), false);
    assert.equal(g.beginRead(next), null);
  }
});
