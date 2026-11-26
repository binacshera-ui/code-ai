import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('account stop fences all pending/scheduled/recurring conversations and direct runs without replay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-integration-'));
  const profiles = ['first', 'same-account', 'other-account'].map((id, index) => ({
    id, label: id, provider: 'codex', codexHome: path.join(root, id),
    workspaceCwd: root, defaultProfile: index === 0,
  }));
  for (const [index, profile] of profiles.entries()) {
    await mkdir(profile.codexHome);
    await writeFile(path.join(profile.codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
      tokens: { account_id: index === 2 ? 'fixture-other' : 'fixture-shared', access_token: 'fixture-token' } }));
  }
  Object.assign(process.env, { CODEX_STORAGE_ROOT: root, CODEX_QUEUE_ROOT: path.join(root, 'queue'),
    CODEX_QUEUE_DISABLE_EXECUTION: '1', CODEX_NTFY_STATE_FILE: path.join(root, 'notifications.json'),
    CODEX_PROFILES_JSON: JSON.stringify(profiles) });
  delete process.env.CODEX_QUEUE_STORAGE;
  delete process.env.CODE_AI_QUOTA_STOP_STATE_FILE;
  delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    plan_type: 'pro', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Date.now() / 1000 + 5000 },
      secondary_window: { used_percent: 91.25, limit_window_seconds: 604800, reset_at: Date.now() / 1000 + 500000 } },
    credits: [],
  }), { status: 200 });
  const quota = await import('./subscriptionQuotaStop.js');
  const queue = await import('./codexQueue.js');
  t.after(async () => { globalThis.fetch = originalFetch; quota.stopSubscriptionQuotaStopMonitor(); await queue.shutdownCodexQueueWorker(); await rm(root, { recursive: true, force: true }); });
  const create = (profileId: string, name: string, extra = {}) => queue.enqueueCodexQueueItem({
    profileId, queueKey: 'draft:' + name, prompt: 'Synthetic quota test ' + name, ...extra,
  });
  const waiting = await create('first', 'waiting');
  const scheduled = await create('same-account', 'scheduled', { scheduledAt: new Date(Date.now() + 60000).toISOString() });
  const recurring = await create('first', 'recurring', { scheduledAt: new Date(Date.now() + 60000).toISOString(), recurrence: { frequency: 'daily', timeZone: 'UTC' } });
  const api = await create('first', 'api', { model: 'gemini-4-neon' });
  const deepseek = await Promise.all(['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']
    .map(model => create('first', model, { model })));
  const other = await create('other-account', 'other');
  const draft = await create('first', 'draft', { saveAsDraft: true });
  const settings = { enabled: true, stopAtUsedPercent: 90.5, window: 'secondary' as const };
  const snapshot = await quota.updateSubscriptionQuotaStop(profiles[0], settings);
  assert.equal(snapshot.state, 'blocked');
  for (const item of [waiting, scheduled, recurring]) {
    const stopped = await queue.getCodexQueueItem(item.id);
    assert.equal(stopped?.status, 'cancelled');
    assert.equal(stopped?.scheduleMode, 'once');
    assert.match(stopped?.error || '', /מכסת המנוי/);
    assert.equal(stopped?.prompt, item.prompt, 'unfinished input stays available');
  }
  for (const item of [api, ...deepseek, other]) assert.equal((await queue.getCodexQueueItem(item.id))?.status, 'queued');
  assert.equal((await queue.getCodexQueueItem(draft.id))?.status, 'draft');
  await assert.rejects(create('same-account', 'blocked'), error => (error as any).code === 'SUBSCRIPTION_QUOTA_STOP');
  await assert.rejects(queue.retryCodexQueueItem(waiting.id), error => (error as any).statusCode === 423);
  for (const model of ['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']) {
    const admitted = await create('same-account', model + '-after-stop', { model });
    assert.equal(admitted.status, 'queued', 'subscription stop must not reject independently billed DeepSeek');
  }
  const agent = await import('./agentService.js');
  await assert.rejects(agent.runAgentPrompt('No model must run', undefined, 'first'), error => (error as any).statusCode === 423);
  await quota.updateSubscriptionQuotaStop(profiles[0], { ...settings, enabled: false });
  for (const item of [waiting, scheduled, recurring]) assert.equal((await queue.getCodexQueueItem(item.id))?.status, 'cancelled', 'release cannot replay old inputs');
  await queue.retryCodexQueueItem(waiting.id);
  assert.equal((await queue.getCodexQueueItem(waiting.id))?.status, 'queued', 'only explicit retry resumes stopped input');
});
