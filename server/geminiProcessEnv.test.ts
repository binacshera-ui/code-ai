import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIsolatedGeminiProcessEnv } from './geminiProcessEnv.js';

test('isolates Gemini from CODE-AI debugger and PM2 IPC state', () => {
  const env = buildIsolatedGeminiProcessEnv(
    {
      DEBUG: 'release',
      DEBUG_PORT: '9229',
      NODE_OPTIONS: '--inspect=127.0.0.1:9229',
      NODE_CHANNEL_FD: '3',
      NODE_CHANNEL_SERIALIZATION_MODE: 'json',
      NODE_INSPECT_RESUME_ON_START: '1',
      VSCODE_INSPECTOR_OPTIONS: '{"inspectorIpc":"example"}',
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'test-key',
    },
    {
      DEBUG: 'profile-debug-value',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/gemini-settings.json',
    },
  );

  assert.equal(env.DEBUG, undefined);
  assert.equal(env.DEBUG_PORT, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_CHANNEL_FD, undefined);
  assert.equal(env.NODE_CHANNEL_SERIALIZATION_MODE, undefined);
  assert.equal(env.NODE_INSPECT_RESUME_ON_START, undefined);
  assert.equal(env.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GEMINI_API_KEY, 'test-key');
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, '/tmp/gemini-settings.json');
});

test('does not mutate any source environment layer', () => {
  const parentEnv = { DEBUG: 'release', PATH: '/usr/local/bin' };
  const profileEnv = { GEMINI_API_KEY: 'profile-key' };

  buildIsolatedGeminiProcessEnv(parentEnv, profileEnv);

  assert.deepEqual(parentEnv, { DEBUG: 'release', PATH: '/usr/local/bin' });
  assert.deepEqual(profileEnv, { GEMINI_API_KEY: 'profile-key' });
});
