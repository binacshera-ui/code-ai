import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildSessionPersonalChromePromptAdditions,
  deleteSessionPersonalChromeMode,
  getSessionPersonalChromeMode,
  prepareCodexPersonalChromeModeForRun,
  rebindSessionPersonalChromeMode,
  setSessionPersonalChromeMode,
} from './codexPersonalChromeMode.js';

const storageRoot = process.env.CODEX_STORAGE_ROOT || '/tmp/code-ai-personal-chrome-mode-test';
const profileId = 'test-profile';
const draftKey = 'draft:test-personal-chrome';
const sessionKey = 'session:test-personal-chrome';
const codexHome = path.join(storageRoot, 'provider-home');

test('personal Chrome mode persists privately and prepares a session-only MCP overlay', async () => {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "test-model"\n[mcp_servers.keep_me]\ncommand = "true"\n', 'utf8');
  await fs.writeFile(path.join(codexHome, 'auth.json'), '{"test":true}\n', 'utf8');

  const saved = await setSessionPersonalChromeMode(profileId, draftKey, {
    enabled: true,
    deviceId: 'device-1',
    deviceName: 'Test Chrome',
    tabId: 42,
    approvalPolicy: 'risky',
    allowJavascript: true,
    allowUploads: false,
    allowPorts: true,
    bindingId: 'binding-1',
    bindingToken: 'binding-token-must-stay-private',
    controlUrl: 'http://127.0.0.1:4106/',
  });
  assert.equal(saved.enabled, true);
  assert.equal(Object.hasOwn(saved as object, 'bindingToken'), false);

  await rebindSessionPersonalChromeMode(profileId, draftKey, sessionKey);
  assert.equal((await getSessionPersonalChromeMode(profileId, draftKey)).enabled, false);
  const rebound = await getSessionPersonalChromeMode(profileId, sessionKey);
  assert.equal(rebound.deviceName, 'Test Chrome');

  const prepared = await prepareCodexPersonalChromeModeForRun(
    { id: profileId, codexHome }, profileId, sessionKey, rebound,
  );
  assert.ok(prepared);
  const config = await fs.readFile(path.join(prepared.envCodeXHome, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.keep_me\]/);
  assert.match(config, /\[mcp_servers\.personal_chrome\]/);
  assert.match(config, /CODE_AI_PERSONAL_CHROME_BINDING_TOKEN = "binding-token-must-stay-private"/);
  assert.match(config, /CODE_AI_PERSONAL_CHROME_SCOPES = "read,write,javascript,ports"/);
  assert.equal((await fs.lstat(path.join(prepared.envCodeXHome, 'auth.json'))).isSymbolicLink(), true);
  assert.match(buildSessionPersonalChromePromptAdditions(rebound), /קלט לא מהימן/);

  await deleteSessionPersonalChromeMode(profileId, sessionKey);
  assert.equal((await getSessionPersonalChromeMode(profileId, sessionKey)).enabled, false);
});
