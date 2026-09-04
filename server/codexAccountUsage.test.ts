import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  consumeCodexRateLimitResetCredit,
  loadCodexAccountUsage,
  parseCodexResetCreditsPayload,
  parseCodexUsagePayload,
} from './codexAccountUsage.js';

const usageFixture = {
  account_id: 'account-example-1234567890',
  email: 'developer@example.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 604_800,
      reset_at: 1_800_000_000,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      normal_model_slug: null,
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_100,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604_800,
          reset_at: 1_800_000_200,
        },
      },
    },
  ],
  credits: {
    has_credits: true,
    unlimited: false,
    overage_limit_reached: false,
    balance: '4.50',
    approx_local_messages: [2, 4],
    approx_cloud_messages: [1, 3],
  },
  rate_limit_reset_credits: {
    available_count: 1,
    applicable_available_count: 1,
  },
};

const resetCreditsFixture = {
  available_count: 1,
  total_earned_count: 2,
  immediate_reset_purchase_eligible: false,
  history_enabled: true,
  credits: [
    {
      id: 'reset-1',
      reset_type: 'codex_rate_limits',
      title: 'Full reset',
      status: 'available',
      granted_at: '2026-09-01T00:00:00.000Z',
      expires_at: '2026-09-30T00:00:00.000Z',
      description: 'Resets the current Codex rate limit.',
    },
  ],
};

test('parses the current weekly quota and every additional model quota without a legacy 5-hour assumption', () => {
  const parsed = parseCodexUsagePayload(usageFixture);

  assert.equal(parsed.planType, 'pro');
  assert.equal(parsed.quotaGroups.length, 2);
  assert.equal(parsed.quotaGroups[0]?.label, 'Codex רגיל');
  assert.equal(parsed.quotaGroups[0]?.primary?.windowMinutes, 10_080);
  assert.equal(parsed.quotaGroups[0]?.secondary, null);
  assert.equal(parsed.quotaGroups[1]?.label, 'GPT-5.3-Codex-Spark');
  assert.equal(parsed.quotaGroups[1]?.primary?.windowMinutes, 300);
  assert.equal(parsed.quotaGroups[1]?.secondary?.windowMinutes, 10_080);
  assert.deepEqual(parsed.billingCredits?.approximateLocalMessages, [2, 4]);
});

test('keeps all Full Reset metadata as read-only display data', () => {
  const usage = parseCodexUsagePayload(usageFixture);
  const parsed = parseCodexResetCreditsPayload(resetCreditsFixture, usage.resetCreditCounts);

  assert.equal(parsed?.availableCount, 1);
  assert.equal(parsed?.applicableAvailableCount, 1);
  assert.equal(parsed?.totalEarnedCount, 2);
  assert.equal(parsed?.credits[0]?.title, 'Full reset');
  assert.equal(parsed?.credits[0]?.status, 'available');
  assert.equal(parsed?.credits[0]?.expiresAt, '2026-09-30T00:00:00.000Z');
});

test('account refresh performs exactly the two documented read-only GET requests', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-codex-usage-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
      account_id: 'account-example-1234567890',
    },
  }));

  const requests: Array<{ url: string; method: string; beta: string | undefined }> = [];
  const snapshot = await loadCodexAccountUsage(
    { id: 'test-profile', codexHome },
    {
      forceRefresh: true,
      now: () => 1_780_000_000_000,
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init.method, beta: init.headers['OpenAI-Beta'] });
        return {
          ok: true,
          status: 200,
          json: async () => url.endsWith('/usage') ? usageFixture : resetCreditsFixture,
        };
      },
    }
  );

  assert.deepEqual(
    requests.map(({ url, method, beta }) => ({ path: new URL(url).pathname, method, beta })),
    [
      { path: '/backend-api/wham/usage', method: 'GET', beta: 'codex-1' },
      { path: '/backend-api/wham/rate-limit-reset-credits', method: 'GET', beta: 'codex-1' },
    ]
  );
  assert.equal(snapshot.account.email, 'developer@example.com');
  assert.equal(snapshot.account.accountIdMasked, 'account…7890');
  assert.equal(snapshot.resetCredits?.availableCount, 1);
  assert.equal(requests.some(({ url }) => /consume|purchase|reset$/.test(url)), false);
});

test('Full Reset consumption requires an available selected credit and sends the official idempotent body', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-codex-reset-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
      account_id: 'account-example-1234567890',
    },
  }));

  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const result = await consumeCodexRateLimitResetCredit(
    { id: 'consume-profile', codexHome },
    {
      creditId: 'reset-1',
      redeemRequestId: '12345678-1234-4234-9234-123456789012',
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init.method, body: init.body });
        if (init.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: 'reset', windows_reset: 2 }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => url.endsWith('/usage') ? usageFixture : resetCreditsFixture,
        };
      },
    }
  );

  const post = requests.find(({ method }) => method === 'POST');
  assert.ok(post);
  assert.equal(new URL(post.url).pathname, '/backend-api/wham/rate-limit-reset-credits/consume');
  assert.deepEqual(JSON.parse(post.body || '{}'), {
    redeem_request_id: '12345678-1234-4234-9234-123456789012',
    credit_id: 'reset-1',
  });
  assert.deepEqual(result, { outcome: 'reset', windowsReset: 2 });
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
});
