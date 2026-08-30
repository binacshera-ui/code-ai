import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a TCP server address'));
        return;
      }
      resolve(address.port);
    });
  });
}

test('reverse-tunnel host is validated, health-checked, and redacted for clients', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'code-ai-remote-host-test-'));
  const registryPath = path.join(temporaryRoot, 'remote-hosts.json');
  const token = 'test-token-with-at-least-twenty-four-characters';
  const fakeAgent = http.createServer((request, response) => {
    const tokenMatches = request.headers['x-code-ai-remote-token'] === token;
    if (request.url === '/api/codex/remote-agent/health' && tokenMatches) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        hostname: 'personal-computer',
        version: '1.0.0',
        codexVersion: 'codex-cli 0.145.0',
        checkedAt: new Date().toISOString(),
        profiles: [{
          id: 'personal-codex',
          label: 'Personal Codex',
          provider: 'codex',
          mode: 'standard',
          authenticated: true,
        }],
      }));
      return;
    }
    if (tokenMatches) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        method: request.method,
        url: request.url,
        tokenAccepted: true,
        proxiedBy: request.headers['x-code-ai-proxied-by'] || null,
        proxiedOwner: request.headers['x-code-ai-proxied-owner'] || null,
        authorizationReceived: Boolean(request.headers.authorization),
      }));
      return;
    }
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'unauthorized' }));
  });
  const localPort = await listen(fakeAgent);

  process.env.CODEX_REMOTE_HOSTS_FILE = registryPath;
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    hosts: [{
      id: 'personal',
      label: 'המחשב האישי',
      transport: 'reverse-tunnel',
      enabled: true,
      token,
      localHost: '127.0.0.1',
      localPort,
    }],
  }));

  const registry = await import('./remoteHostRegistry.js');
  const servers = await registry.listCodeAiServers({ refresh: true });
  const personal = servers.find((server) => server.id === 'personal');
  assert.ok(personal);
  assert.equal(personal.status, 'online');
  assert.equal(personal.profileCount, 1);
  assert.equal(personal.authenticatedProfileCount, 1);
  assert.equal(personal.hostname, 'personal-computer');
  assert.equal('token' in personal, false);

  const { createRemoteHostProxyMiddleware } = await import('./remoteHostProxy.js');
  const controlApp = express();
  controlApp.use(express.json());
  let accessChecks = 0;
  controlApp.use('/api/codex', createRemoteHostProxyMiddleware((_req, _res, next) => {
    accessChecks += 1;
    next();
  }));
  controlApp.use('/api/codex', (_req, response) => {
    response.json({ local: true });
  });
  const controlServer = http.createServer(controlApp);
  const controlPort = await listen(controlServer);

  const proxiedResponse = await fetch(`http://127.0.0.1:${controlPort}/api/codex/profiles`, {
    headers: {
      'x-code-ai-server-id': 'personal',
      'x-code-ai-remote-token': 'client-must-not-control-this-token',
      'x-code-ai-proxied-owner': 'client-must-not-control-this-owner',
      authorization: 'Bearer client-credential-must-not-be-forwarded',
    },
  });
  assert.equal(proxiedResponse.status, 200);
  const proxiedBody = await proxiedResponse.json() as Record<string, unknown>;
  assert.equal(proxiedBody.url, '/api/codex/profiles');
  assert.equal(proxiedBody.tokenAccepted, true);
  assert.equal(proxiedBody.proxiedBy, 'code-ai-control-plane');
  assert.match(String(proxiedBody.proxiedOwner), /^[a-f0-9]{64}$/);
  assert.notEqual(proxiedBody.proxiedOwner, 'client-must-not-control-this-owner');
  assert.equal(proxiedBody.authorizationReceived, false);
  assert.equal(accessChecks, 1);

  const triggerResponse = await fetch(
    `http://127.0.0.1:${controlPort}/api/codex/session-triggers/trigger-1/fire?token=public-trigger-token&server=personal`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'wake the remote session' }),
    }
  );
  assert.equal(triggerResponse.status, 200);
  const triggerBody = await triggerResponse.json() as Record<string, unknown>;
  assert.equal(
    triggerBody.url,
    '/api/codex/session-triggers/trigger-1/fire?token=public-trigger-token'
  );
  assert.equal(triggerBody.tokenAccepted, true);
  assert.equal(accessChecks, 1, 'public trigger auth must be delegated to the remote trigger token');

  registry.shutdownRemoteHostTunnels();
  await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  await new Promise<void>((resolve) => fakeAgent.close(() => resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
});
