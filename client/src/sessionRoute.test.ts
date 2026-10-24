import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionHref,
  readSessionRoute,
} from './sessionRoute';

test('remote notification links preserve the selected server', () => {
  const route = readSessionRoute(
    'https://code-ai.test/session/beam-user/session-123?server=remote-a',
  );

  assert.deepEqual(route, {
    serverId: 'remote-a',
    profileId: 'beam-user',
    sessionKey: 'session-123',
    sessionId: 'session-123',
    draftKey: null,
    kind: 'session',
    source: 'path',
  });
});

test('session navigation keeps the remote server query parameter', () => {
  assert.equal(
    buildSessionHref(
      'https://code-ai.test/session/beam-user/old-session?server=remote-a',
      'beam-user',
      'new-session',
      'session',
    ),
    '/session/beam-user/new-session?server=remote-a',
  );
});
