import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildSessionPhoneModePromptAdditions,
  closePhoneModeBridgeForTests,
  collectPhoneStatus,
  deleteSessionPhoneMode,
  getSessionPhoneMode,
  prepareCodexPhoneModeForRun,
  rebindSessionPhoneMode,
  setSessionPhoneMode,
} from './codexPhoneMode.js';

test('phone status submits all read-only probes concurrently and isolates failures', async () => {
  let active = 0;
  let maximumActive = 0;
  const calledCommands: string[] = [];

  const result = await collectPhoneStatus('free', async (_tool, command) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calledCommands.push(command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (command === 'getWifiInfo') throw new Error('wifi unavailable');
    return { success: true, command };
  });

  assert.equal(maximumActive, 7);
  assert.equal(calledCommands.length, 7);
  assert.deepEqual(result.device, { success: true, command: 'getDeviceInfo' });
  assert.deepEqual(result.wifi, { success: false, error: 'wifi unavailable' });
  assert.deepEqual(Object.keys(result), [
    'device', 'battery', 'network', 'wifi', 'diagnostics', 'foregroundApp', 'screen',
  ]);
});

const storageRoot = process.env.CODEX_STORAGE_ROOT || '/tmp/code-ai-phone-mode-test';
const profileId = 'test-profile';
const draftKey = 'draft:test-phone';
const sessionKey = 'session:test-phone';
const codexHome = path.join(storageRoot, 'provider-home');

test('phone mode persists privately and prepares a session-scoped MCP and skill overlay', async (context) => {
  context.after(() => closePhoneModeBridgeForTests());
  await fs.mkdir(path.join(codexHome, 'skills'), { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "test-model"\n[mcp_servers.keep_me]\ncommand = "true"\n', 'utf8');
  await fs.writeFile(path.join(codexHome, 'auth.json'), '{"test":true}\n', 'utf8');

  const saved = await setSessionPhoneMode(profileId, draftKey, {
    enabled: true,
    accessPolicy: 'careful',
    includeCallArchive: true,
    verboseLogs: true,
  });
  assert.deepEqual(saved, {
    enabled: true,
    accessPolicy: 'careful',
    includeCallArchive: true,
    verboseLogs: true,
  });

  await rebindSessionPhoneMode(profileId, draftKey, sessionKey);
  assert.equal((await getSessionPhoneMode(profileId, draftKey)).enabled, false);
  const rebound = await getSessionPhoneMode(profileId, sessionKey);
  const prepared = await prepareCodexPhoneModeForRun(
    { id: profileId, provider: 'codex', codexHome, workspaceCwd: storageRoot }, profileId, sessionKey, rebound,
  );
  assert.ok(prepared);

  const config = await fs.readFile(path.join(prepared.envCodeXHome, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.keep_me\]/);
  assert.match(config, /\[mcp_servers\.phone_mode\]/);
  assert.match(config, /CODE_AI_PHONE_BRIDGE_TOKEN = "[^"]+"/);
  assert.equal((await fs.lstat(path.join(prepared.envCodeXHome, 'auth.json'))).isSymbolicLink(), true);
  assert.equal((await fs.lstat(path.join(prepared.envCodeXHome, 'skills', 'reapre-phone-control'))).isSymbolicLink(), true);
  assert.match(buildSessionPhoneModePromptAdditions(rebound), /מדיניות גישה זהירה/);
  assert.match(buildSessionPhoneModePromptAdditions({ ...rebound, accessPolicy: 'free' }), /מדיניות גישה חופשית/);

  const bridgeUrl = /CODE_AI_PHONE_BRIDGE_URL = "([^"]+)"/.exec(config)?.[1];
  const bridgeToken = /CODE_AI_PHONE_BRIDGE_TOKEN = "([^"]+)"/.exec(config)?.[1];
  assert.ok(bridgeUrl && bridgeToken);
  const blockedControl = await fetch(`${bridgeUrl}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone_control', arguments: { tool: 'mobile_ui', command: 'tap', params: { x: 10, y: 10 } } }),
  });
  const blockedPayload = await blockedControl.json() as { error?: { message?: string } };
  assert.equal(blockedControl.status, 400);
  assert.match(String(blockedPayload.error?.message), /CAREFUL_MODE_CONFIRMATION_REQUIRED/);

  const disguisedMutation = await fetch(`${bridgeUrl}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'phone_read',
      arguments: {
        tool: 'mobile_notifications',
        command: 'reply',
        params: { notificationId: 'private-id', text: 'must not be sent' },
      },
    }),
  });
  const disguisedPayload = await disguisedMutation.json() as { error?: { message?: string } };
  assert.equal(disguisedMutation.status, 400);
  assert.match(String(disguisedPayload.error?.message), /MUTATING_COMMAND_REQUIRES_PHONE_CONTROL/);

  await deleteSessionPhoneMode(profileId, sessionKey);
  assert.equal((await getSessionPhoneMode(profileId, sessionKey)).enabled, false);
});
