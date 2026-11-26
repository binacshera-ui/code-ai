import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { subscriptionAccountKey, subscriptionTransportBlocked } from './subscriptionQuotaFence.mjs';
import http from 'node:http';
import { createInferenceRouter } from './codexInferenceRouter.mjs';

test('transport fences confirmed breaches, not observation age, while preserving account and API isolation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'policy.json'), now = Date.now();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now), false);
  const entry = { settings: { enabled: true }, latch: null, snapshot: { state: 'armed', observedAt: new Date(now).toISOString() } };
  const state = { format: 'code-ai-subscription-quota-stop', version: 1, accounts: { [subscriptionAccountKey('fixture-account')]: entry } };
  const save = () => writeFile(file, JSON.stringify(state));
  await save();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now), false);
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now + 31000), false);
  entry.snapshot.observedAt = new Date(now - 120000).toISOString();
  entry.snapshot.state = 'unavailable'; await save();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol'), false);
  entry.snapshot.state = 'blocked'; await save();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now), true);
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gemini-4-carbon', now), false);
  for (const model of ['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']) {
    assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', model), false);
  }
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'deepseek-unknown'), true);
  assert.equal(await subscriptionTransportBlocked(file, null, 'gpt-6.1-sol', now), false);
  assert.equal(await subscriptionTransportBlocked(file, 'other-account', 'gpt-6.1-sol', now), false);
  entry.latch = { stoppedAt: new Date(now).toISOString() }; entry.snapshot.state = 'unavailable'; await save();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol'), true, 'a real breach survives missing later observations');
  entry.settings.enabled = false; await save();
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now), false);
  await writeFile(file, 'invalid');
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'gpt-6.1-sol', now), true);
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'deepseek-v4.1-flash-venice'), false);
  assert.equal(await subscriptionTransportBlocked(file, 'fixture-account', 'deepseek-v4.1-flash-experiential'), false);
});

test('live transport stops streaming subscription requests and fences models/images without stopping API billing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-transport-'));
  const file = path.join(root, 'state.json'), auth = path.join(root, 'auth.json');
  await writeFile(auth, JSON.stringify({ tokens: { account_id: 'fixture-subscription', access_token: 'fixture-sub-token' }, OPENAI_API_KEY: 'fixture-api-token' }));
  const entry = { settings: { enabled: true }, latch: null, snapshot: { state: 'armed', observedAt: new Date().toISOString() } };
  const state = { format: 'code-ai-subscription-quota-stop', version: 1, accounts: { [subscriptionAccountKey('fixture-subscription')]: entry } };
  await writeFile(file, JSON.stringify(state));
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: fixture\n\n');
    if (body.includes('gemini-') || req.headers.authorization === 'Bearer fixture-api-token') res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}/v1`;
  const router = createInferenceRouter({ authFiles: [auth], quotaStopStateFile: file,
    geminiBaseUrl: url, openaiBaseUrl: url, geminiGatewayKey: 'fixture-gateway' }, { logger() {} });
  await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
  t.after(async () => { router.closeAllConnections(); upstream.closeAllConnections(); router.close(); upstream.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${router.address().port}/v1`;
  const headers = { authorization: 'Bearer fixture-sub-token', 'content-type': 'application/json' };
  const body = JSON.stringify({ model: 'gpt-6.1-sol', input: [] });
  const response = await fetch(base + '/responses', { method: 'POST', headers, body });
  const reader = response.body.getReader(); await reader.read();
  entry.snapshot.state = 'unavailable'; entry.snapshot.observedAt = new Date(Date.now() - 60000).toISOString();
  await writeFile(file, JSON.stringify(state));
  const pendingRead = reader.read();
  const survived = await Promise.race([pendingRead.then(() => false, () => false), new Promise(resolve => setTimeout(() => resolve(true), 650))]);
  assert.equal(survived, true, 'temporary missing data must not kill an in-flight model stream');
  entry.snapshot.state = 'blocked'; await writeFile(file, JSON.stringify(state));
  const ended = await Promise.race([pendingRead.then(() => true, () => true), new Promise(resolve => { const timer = setTimeout(() => resolve(false), 2000); timer.unref(); })]);
  assert.equal(ended, true, 'an already running stream must stop, not merely its next request');
  assert.equal((await fetch(base + '/responses', { method: 'POST', headers, body })).status, 423);
  assert.equal((await fetch(base + '/images/generations', { method: 'POST', headers, body: '{}' })).status, 423);
  assert.equal((await fetch(base + '/images/edits', { method: 'POST', headers, body: 'fixture multipart bytes' })).status, 423);
  assert.equal(calls, 1, 'blocked requests never reach the provider');
  const api = await fetch(base + '/responses', { method: 'POST', headers: { ...headers, authorization: 'Bearer fixture-api-token' }, body });
  assert.equal(api.status, 200); await api.text();
  const gemini = await fetch(base + '/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'gemini-4-neon', input: [] }) });
  assert.equal(gemini.status, 200); await gemini.text();
});
