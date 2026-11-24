import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { createSubscriptionQuotaStopRouter } from './subscriptionQuotaStopRoutes.js';
import { DEFAULT_SUBSCRIPTION_QUOTA_STOP } from '../shared/subscriptionQuotaStop.js';

test('quota settings API enforces access, profile scope, validation and optimistic account binding', async t => {
  let calls = 0;
  const app = express(); app.use(express.json());
  const snapshot = { ...DEFAULT_SUBSCRIPTION_QUOTA_STOP, supported: true, state: 'disabled' as const,
    accountScope: 'fixture-account-scope', usedPercent: null, remainingUntilStopPercent: null,
    resetsAt: null, observedAt: null, stoppedAt: null, message: null };
  app.use('/api/codex', createSubscriptionQuotaStopRouter((req, res, next) => {
    if (req.headers.authorization !== 'fixture-access') { res.status(401).end(); return; } next();
  }, {
    profiles: [{ id: 'fixture', provider: 'codex', defaultProfile: true, codexHome: '/synthetic', label: 'Fixture', workspaceCwd: '/synthetic', mode: 'standard' }],
    read: async profile => { assert.equal(profile.id, 'fixture'); return snapshot; },
    update: async (_profile, settings, options) => {
      calls++;
      if (options?.expectedAccountScope !== snapshot.accountScope) throw Object.assign(new Error('Account changed'), { statusCode: 409 });
      return { ...snapshot, ...settings };
    },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/codex/subscription-quota-stop`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: 'fixture-access', 'content-type': 'application/json' };
  const r = await fetch(base + '?profile=fixture', { headers }); assert.equal(r.status, 200); assert.match(r.headers.get('cache-control')!, /no-store/);
  assert.equal((await fetch(base + '?profile=wrong', { headers })).status, 404);
  const put = (value: unknown) => fetch(base, { method: 'PUT', headers, body: JSON.stringify(value) });
  assert.equal((await put({ enabled: true, window: 'secondary', stopAtUsedPercent: 101 })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await put({ profileId: 'fixture', ...DEFAULT_SUBSCRIPTION_QUOTA_STOP, accountScope: 'old-account' })).status, 409);
  const saved = await put({ profileId: 'fixture', ...DEFAULT_SUBSCRIPTION_QUOTA_STOP, stopAtUsedPercent: 88.25, accountScope: snapshot.accountScope });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).quotaStop.stopAtUsedPercent, 88.25);
});
