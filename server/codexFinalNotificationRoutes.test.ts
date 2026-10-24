import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createCodexFinalNotificationRouter } from './codexFinalNotificationRoutes.js';
import {
  getSessionFinalNotificationPreference,
  resetCodexFinalNotificationRuntimeForTests,
  setSessionFinalNotificationPreference,
} from './codexFinalNotifications.js';

test('notification routes canonicalize historical draft keys and preserve explicit real-session opt-in', async () => {
  const root = await fs.mkdtemp('/tmp/code-ai-notification-routes-');
  process.env.CODEX_NTFY_STATE_FILE = path.join(root, 'state.json');
  process.env.CODEX_NTFY_URL = 'https://ntfy.test/isolated-test';
  process.env.CODEX_NTFY_DEFAULT_ENABLED = 'true';
  process.env.CODEX_NTFY_ENABLED = 'true';
  resetCodexFinalNotificationRuntimeForTests();
  const app = express();
  app.use(express.json());
  app.use('/notifications', createCodexFinalNotificationRouter(async (key) => key === 'draft:old' ? 'real-chat' : key));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    await setSessionFinalNotificationPreference('developer', 'draft:old', false);
    await setSessionFinalNotificationPreference('developer', 'real-chat', true);
    const read = await fetch(`${origin}/notifications?profileId=developer&sessionKey=draft%3Aold`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal((await read.json()).notification.enabled, true);

    for (const enabled of [false, true]) {
      const saved = await fetch(`${origin}/notifications`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'developer', sessionKey: 'draft:old', enabled }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).notification.enabled, enabled);
      assert.equal((await getSessionFinalNotificationPreference('developer', 'real-chat')).enabled, enabled);
      assert.equal((await getSessionFinalNotificationPreference('developer2', 'real-chat')).enabled, true);
    }

    const invalid = await fetch(`${origin}/notifications`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'developer', sessionKey: 'real-chat', enabled: 'false' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await getSessionFinalNotificationPreference('developer', 'real-chat')).enabled, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetCodexFinalNotificationRuntimeForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
});
