import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionHref,
  readSessionRoute,
} from './sessionRoute';

test('remote notification links preserve the selected server', () => {
  const route = readSessionRoute(
    'https://code-ai.test/session/beam-user/session-123?server=beam-10g',
  );

  assert.deepEqual(route, {
    serverId: 'beam-10g',
    profileId: 'beam-user',
    sessionKey: 'session-123',
    sessionId: 'session-123',
    draftKey: null,
    kind: 'session',
    source: 'path',
  });
});

test('local notification links explicitly override a previously selected remote server', () => {
  const route = readSessionRoute('https://code-ai.test/session/developer/session-123?server=local');
  assert.equal(route?.serverId, 'local');
  assert.equal(route?.profileId, 'developer');
  assert.equal(route?.sessionId, 'session-123');
});

test('older local notification links without a server still open locally', () => {
  const route = readSessionRoute('https://code-ai.test/session/developer/session-123');
  assert.equal(route?.serverId, 'local');
  assert.equal(route?.sessionId, 'session-123');
});

test('session navigation keeps the remote server query parameter', () => {
  assert.equal(
    buildSessionHref(
      'https://code-ai.test/session/beam-user/old-session?server=beam-10g',
      'beam-user',
      'new-session',
      'session',
    ),
    '/session/beam-user/new-session?server=beam-10g',
  );
});
