import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSessionHref,
  buildSessionPath,
  getSessionRouteSurface,
  readSessionRoute,
} from '../client/src/sessionRoute.js';

test('real sessions use a canonical path on both surfaces', () => {
  const sessionId = '019fb7e5-a409-7eb0-aa28-6a2947d2a92d';
  assert.equal(
    buildSessionPath('developer2', sessionId, 'session', 'workbench'),
    `/session/developer2/${sessionId}`
  );
  assert.equal(
    buildSessionPath('developer2', sessionId, 'session', 'chat'),
    `/chat/session/developer2/${sessionId}`
  );
  assert.deepEqual(
    readSessionRoute(`https://code-ai.example/session/developer2/${sessionId}`),
    {
      profileId: 'developer2',
      sessionKey: sessionId,
      sessionId,
      draftKey: null,
      kind: 'session',
      source: 'path',
    }
  );
});

test('draft tabs receive distinct persistent route keys', () => {
  const firstKey = 'draft-queue-11111111-1111-4111-8111-111111111111';
  const secondKey = 'draft-queue-22222222-2222-4222-8222-222222222222';
  const firstPath = buildSessionPath('developer', firstKey, 'draft');
  const secondPath = buildSessionPath('developer', secondKey, 'draft');
  assert.notEqual(firstPath, secondPath);
  assert.equal(readSessionRoute(firstPath)?.sessionKey, firstKey);
  assert.equal(readSessionRoute(secondPath)?.sessionKey, secondKey);
  assert.equal(readSessionRoute(firstPath)?.kind, 'draft');
});

test('canonicalization preserves embed state and removes legacy routing query params', () => {
  const href = buildSessionHref(
    'https://code-ai.example/chat?embed=workbench&profile=developer&session=old#composer',
    'developer',
    'new-session',
    'session'
  );
  assert.equal(href, '/chat/session/developer/new-session?embed=workbench#composer');
  assert.equal(getSessionRouteSurface(href), 'chat');
});

test('legacy query links remain readable during migration', () => {
  assert.deepEqual(
    readSessionRoute('https://code-ai.example/?profile=developer&session=legacy-session'),
    {
      profileId: 'developer',
      sessionKey: 'legacy-session',
      sessionId: 'legacy-session',
      draftKey: null,
      kind: 'session',
      source: 'query',
    }
  );
});

test('unsafe route tokens are rejected', () => {
  assert.equal(
    readSessionRoute('https://code-ai.example/session/developer/%2Fetc%2Fpasswd'),
    null
  );
});
