import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionListLimit } from './sessionListLimit.js';

test('an unpaged catalog retains old conversations and their topics beyond 500', () => {
  const catalog = Array.from({ length: 718 }, (_, index) => ({ id: index, topic: index >= 500 ? '02 מנוע ורמיקס' : null }));
  const listed = catalog.slice(0, sessionListLimit());
  assert.equal(listed.length, 718);
  assert.equal(listed.filter(item => item.topic).length, 218);
});

test('explicit picker/page bounds retain their existing contract', () => {
  assert.equal(sessionListLimit(60), 60);
  assert.equal(sessionListLimit(718), 500);
  assert.equal(sessionListLimit(718, true), 718);
  assert.equal(sessionListLimit(-1), 0);
  assert.equal(sessionListLimit(1.9), 1);
  assert.equal(sessionListLimit(Number.NaN), 500);
  assert.equal(sessionListLimit(Number.POSITIVE_INFINITY), 500);
});
