import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createServerStatusRouter } from './serverStatusRoutes.js';

test('host telemetry is authenticated, non-cacheable, read-only and sanitizes failures', async t => {
  const app = express();
  let calls = 0;
  app.use('/api/codex', createServerStatusRouter((req, res, next) => {
    if (req.headers.authorization !== 'test-session') { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  }, async () => {
    calls++;
    if (calls > 1) throw new Error('private-path secret-value');
    return { version: 1, hostname: 'fixture-host', sampledAt: '2026-10-21T00:00:00Z' } as any;
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/codex/server-status`;
  assert.equal((await fetch(url)).status, 401); assert.equal(calls, 0);
  const headers = { authorization: 'test-session' };
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /private, no-store/);
  assert.equal((await response.json()).hostname, 'fixture-host');
  const failed = await fetch(url, { headers });
  assert.equal(failed.status, 503); const text = await failed.text();
  assert.ok(!text.includes('private-path') && !text.includes('secret-value'));
  assert.equal((await fetch(url, { headers, method: 'POST' })).status, 404);
  assert.equal(calls, 2);
});
