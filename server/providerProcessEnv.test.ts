import assert from 'node:assert/strict';
import test from 'node:test';

import { isolateProviderProcessEnv } from './providerProcessEnv.js';

test('keeps CODE-AI phone notification configuration out of provider processes', () => {
  const parent = {
    PATH: '/usr/bin',
    CODEX_NTFY_URL: 'https://ntfy.test/private-topic',
    CODEX_NTFY_ACCESS_TOKEN: 'private-token',
    CODEX_NTFY_ENABLED: 'true',
    CODEX_NTFY_DEFAULT_ENABLED: 'true',
    CODEX_NTFY_STATE_FILE: '/private/notification-state.json',
  };

  const isolated = isolateProviderProcessEnv(parent);

  assert.equal(isolated.PATH, '/usr/bin');
  assert.equal(isolated.CODEX_NTFY_URL, undefined);
  assert.equal(isolated.CODEX_NTFY_ACCESS_TOKEN, undefined);
  assert.equal(isolated.CODEX_NTFY_ENABLED, undefined);
  assert.equal(isolated.CODEX_NTFY_DEFAULT_ENABLED, undefined);
  assert.equal(isolated.CODEX_NTFY_STATE_FILE, undefined);
  assert.equal(parent.CODEX_NTFY_URL, 'https://ntfy.test/private-topic');
});
