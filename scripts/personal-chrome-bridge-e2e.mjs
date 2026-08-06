import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const baseUrl = String(process.env.CODE_AI_E2E_BASE_URL || 'http://127.0.0.1:4106').replace(/\/+$/, '');
const storageRoot = process.env.CODEX_STORAGE_ROOT || '';

async function requestJson(pathname, init = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  assert.equal(response.status, expectedStatus, `${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}

function createMessageInbox(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  return {
    next(predicate, timeoutMs = 5000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error('Timed out waiting for extension bridge message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function main() {
  const health = await requestJson('/api/codex/browser-extension/health');
  assert.equal(health.protocolVersion, 1);

  const pairing = await requestJson('/api/codex/browser-extension/pairing/start', {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'x-code-ai-proxied-owner': 'a'.repeat(64),
    }, body: '{}',
  });
  assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const claim = await requestJson('/api/codex/browser-extension/pairing/claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, deviceName: 'E2E Chrome', extensionId: 'e2e-extension', platform: 'test' }),
  }, 201);
  assert.ok(claim.deviceId && claim.deviceToken);

  const socketUrl = new URL(baseUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.pathname = '/api/codex/browser-extension/socket';
  const ws = new WebSocket(socketUrl);
  const inbox = createMessageInbox(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', version: 1, deviceId: claim.deviceId, token: claim.deviceToken, extensionId: 'e2e-extension' }));
  assert.equal((await inbox.next((message) => message.type === 'auth_ok')).deviceId, claim.deviceId);
  ws.send(JSON.stringify({ type: 'event', version: 1, name: 'capabilities', payload: ['tabs', 'e2e'] }));

  const devices = await requestJson('/api/codex/browser-extension/devices');
  assert.equal(devices.devices[0].online, true);

  const profilePayload = await requestJson('/api/codex/profiles');
  const profiles = Array.isArray(profilePayload) ? profilePayload : profilePayload.profiles;
  const profile = profiles.find((candidate) => candidate.provider === 'codex') || profiles[0];
  assert.ok(profile?.id, 'staging server must expose at least one profile');
  const sessionKey = `draft:e2e-personal-chrome-${Date.now()}`;

  const binding = await requestJson('/api/codex/browser-extension/bindings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: claim.deviceId, profileId: profile.id, sessionKey,
      scopes: ['read', 'write', 'javascript', 'upload', 'ports'], approvalPolicy: 'risky',
    }),
  }, 201);
  const bearer = { authorization: `Bearer ${binding.bindingToken}`, 'content-type': 'application/json' };

  const invalidArguments = await requestJson('/api/codex/browser-extension/tool-call', {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ toolName: 'browser_key', arguments: { key: 'Enter', repeat: 21 } }),
  }, 400);
  assert.equal(invalidArguments.error.code, 'INVALID_ARGUMENT');

  const statusPromise = requestJson('/api/codex/browser-extension/tool-call', {
    method: 'POST', headers: bearer, body: JSON.stringify({ toolName: 'browser_status', arguments: {} }),
  });
  const statusCommand = await inbox.next((message) => message.type === 'command' && message.toolName === 'browser_status');
  ws.send(JSON.stringify({ type: 'result', version: 1, commandId: statusCommand.commandId, ok: true, result: { online: true, activeTab: { id: 7 } } }));
  assert.equal((await statusPromise).result.activeTab.id, 7);

  const secret = `e2e-secret-${Date.now()}`;
  const secretPromise = requestJson('/api/codex/browser-extension/tool-call', {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ toolName: 'browser_type', arguments: { text: secret, secret: true, target: { selector: '#password' } } }),
  });
  const secretCommand = await inbox.next((message) => message.type === 'command' && message.toolName === 'browser_type');
  assert.equal(secretCommand.arguments.text, secret);
  ws.send(JSON.stringify({ type: 'result', version: 1, commandId: secretCommand.commandId, ok: true, result: { typed: true } }));
  await secretPromise;

  const networkPromise = requestJson('/api/codex/browser-extension/tool-call', {
    method: 'POST', headers: bearer,
    body: JSON.stringify({ toolName: 'browser_network', arguments: { includeBodies: true } }),
  });
  const approval = await inbox.next((message) => message.type === 'approval_request' && message.toolName === 'browser_network');
  ws.send(JSON.stringify({ type: 'approval_response', version: 1, approvalId: approval.approvalId, approved: true }));
  const networkCommand = await inbox.next((message) => message.type === 'command' && message.toolName === 'browser_network');
  ws.send(JSON.stringify({ type: 'result', version: 1, commandId: networkCommand.commandId, ok: true, result: { entries: [] } }));
  assert.deepEqual((await networkPromise).result.entries, []);

  await requestJson('/api/codex/session-personal-chrome-mode', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profileId: profile.id, sessionKey,
      personalChromeMode: {
        enabled: true, deviceId: claim.deviceId, deviceName: 'E2E Chrome', tabId: null,
        approvalPolicy: 'risky', allowJavascript: true, allowUploads: true, allowPorts: true,
        bindingId: binding.binding.id, bindingToken: binding.bindingToken, controlUrl: baseUrl,
      },
    }),
  });
  const savedMode = await requestJson(`/api/codex/session-personal-chrome-mode?profileId=${encodeURIComponent(profile.id)}&sessionKey=${encodeURIComponent(sessionKey)}`);
  assert.equal(savedMode.personalChromeMode.enabled, true);
  assert.equal(Object.hasOwn(savedMode.personalChromeMode, 'bindingToken'), false);

  const extensionAuth = await fetch(`${baseUrl}/api/codex/profiles`, {
    headers: { 'x-code-ai-extension-device': claim.deviceId, 'x-code-ai-extension-token': claim.deviceToken },
  });
  assert.equal(extensionAuth.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 100));
  if (storageRoot) {
    const audit = await fs.readFile(path.join(storageRoot, 'local/personal-chrome-bridge/audit.jsonl'), 'utf8');
    assert.doesNotMatch(audit, new RegExp(secret));
    assert.match(audit, /\[REDACTED\]/);
  }

  await requestJson(`/api/codex/browser-extension/bindings/${encodeURIComponent(binding.binding.id)}`, { method: 'DELETE' });
  await requestJson('/api/codex/browser-extension/tool-call', {
    method: 'POST', headers: bearer, body: JSON.stringify({ toolName: 'browser_status', arguments: {} }),
  }, 401);
  await requestJson(`/api/codex/browser-extension/devices/${encodeURIComponent(claim.deviceId)}`, { method: 'DELETE' });
  ws.close(1000, 'E2E complete');
  console.log(JSON.stringify({ ok: true, deviceId: claim.deviceId, profileId: profile.id, testedTools: ['browser_status', 'browser_type', 'browser_network'] }));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
