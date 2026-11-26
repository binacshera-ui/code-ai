import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSubscriptionQuotaStopService,
  isSubscriptionQuotaStopError,
  readSubscriptionQuotaIdentity,
} from './subscriptionQuotaStop.js';
import type { CodexAccountUsageSnapshot } from './codexAccountUsage.js';

const epoch = Date.parse('2026-11-24T12:00:00.000Z');
const reset = epoch / 1000 + 100;
const enabled = { enabled: true, stopAtUsedPercent: 90, window: 'secondary' as const };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-quota-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = epoch, reads = 0;
  const profile = { id: 'main', provider: 'codex', codexHome: path.join(root, 'home') };
  const twin = { id: 'derived', provider: 'codex', codexHome: path.join(root, 'derived') };
  const other = { id: 'other', provider: 'codex', codexHome: path.join(root, 'other') };
  const file = path.join(root, 'state', 'subscription-quota-stop.json');
  const auth = async (p = profile, account = 'synthetic-account', api = false) => {
    await mkdir(p.codexHome, { recursive: true });
    await writeFile(path.join(p.codexHome, 'auth.json'), JSON.stringify(api
      ? { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-provider-key' }
      : { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-private-access-token', account_id: account } }));
  };
  await auth(); await auth(twin); await auth(other, 'synthetic-different-account');
  const usage = (primary = 10, secondary = 20, resetsAt: number | null = reset): CodexAccountUsageSnapshot => ({
    source: 'chatgpt-wham', fetchedAt: new Date(now).toISOString(), account: {
      authenticated: true, email: null, accountIdMasked: null,
    }, planType: 'pro', rateLimitReachedType: null, billingCredits: null, resetCredits: null, error: null,
    quotaGroups: [{ id: 'codex-standard', label: 'Codex', meteredFeature: null, normalModelSlug: null,
      allowed: true, limitReached: false,
      primary: { usedPercent: primary, windowMinutes: 300, resetsAt, resetsAtIso: null },
      secondary: { usedPercent: secondary, windowMinutes: 10080, resetsAt, resetsAtIso: null },
    }],
  });
  let next: CodexAccountUsageSnapshot | Error = usage();
  const serviceOptions = { storageFile: file, now: () => now, profiles: [profile, twin, other],
    loadUsage: async () => { reads++; if (next instanceof Error) throw next; return structuredClone(next); } };
  const create = () => createSubscriptionQuotaStopService(serviceOptions);
  return { profile, twin, other, file, root, usage, auth, create,
    set: (value: CodexAccountUsageSnapshot | Error) => { next = value; },
    advance: (ms = 5_001) => { now += ms; }, reads: () => reads,
  };
}

test('disabled guard and API profiles never fetch quota or enforce an invented default', async t => {
  const f = await fixture(t), guard = f.create();
  const snapshot = await guard.read(f.profile);
  assert.equal(snapshot.enabled, false); assert.equal(snapshot.state, 'disabled');
  assert.equal(snapshot.stopAtUsedPercent, 90); assert.equal(snapshot.window, 'secondary');
  assert.equal(f.reads(), 0);
  await guard.assertAllowed(f.profile);
  await f.auth(f.profile, '', true);
  assert.equal((await guard.read(f.profile)).state, 'unsupported');
  assert.equal(f.reads(), 0);
});

test('fractional thresholds use authoritative weekly usage, not five-hour or context percentages', async t => {
  const f = await fixture(t), guard = f.create();
  f.set(f.usage(99, 90.49));
  const armed = await guard.update(f.profile, { ...enabled, stopAtUsedPercent: 90.5 });
  assert.equal(armed.state, 'armed'); assert.equal(armed.remainingUntilStopPercent, 0.01);
  f.advance(); f.set(f.usage(1, 90.5));
  const blocked = await guard.read(f.profile);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.remainingUntilStopPercent, 0);
  await assert.rejects(guard.assertAllowed(f.profile), error => isSubscriptionQuotaStopError(error)
    && error.statusCode === 423 && error.code === 'SUBSCRIPTION_QUOTA_STOP');
});

test('policy is per subscription across derived homes, not per tab, profile, model or different account', async t => {
  const f = await fixture(t), guard = f.create(), events: string[][] = [];
  guard.subscribe(event => { events.push(event.profileIds); });
  f.set(f.usage(2, 95)); await guard.update(f.profile, enabled);
  assert.equal(await guard.blocked(f.twin, 'gpt-6.1-sol'), true);
  assert.equal(await guard.blocked(f.twin, 'gemini-4-neon'), false);
  for (const model of ['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']) {
    const reads = f.reads();
    assert.equal(await guard.blocked(f.twin, model), false);
    await guard.assertAllowed(f.twin, { model });
    assert.equal(f.reads(), reads, 'API model admission must not fetch subscription quota');
  }
  assert.equal(await guard.blocked(f.twin, 'deepseek-unknown'), true);
  assert.equal(await guard.blocked(f.other, 'gpt-6.1-sol'), false);
  assert.ok(events.every(ids => ids.includes('main') && ids.includes('derived') && !ids.includes('other')));
  const bytes = await readFile(f.file, 'utf8');
  assert.ok(!bytes.includes('synthetic-account') && !bytes.includes('fixture-private-access-token'));
  const stored = JSON.parse(bytes);
  assert.equal(stored.format, 'code-ai-subscription-quota-stop');
  assert.match(Object.keys(stored.accounts)[0], /^[a-f0-9]{64}$/);
});

test('threshold latch survives restart and cannot be released by elapsed wall-clock or lower unproven sample', async t => {
  const f = await fixture(t), first = f.create();
  f.set(f.usage(1, 95)); await first.update(f.profile, enabled);
  f.advance(120_000); f.set(f.usage(1, 5, reset));
  const restarted = f.create();
  assert.equal((await restarted.read(f.profile)).state, 'blocked', 'local reset timer is not provider evidence');
  f.advance(); f.set(f.usage(1, 5, reset + 604_800));
  assert.equal((await restarted.read(f.profile)).state, 'armed', 'newer provider window proves reset');
});

test('manual higher limit or disabling clears the latch, but saving the same settings does not', async t => {
  const f = await fixture(t), guard = f.create();
  f.set(f.usage(1, 95)); await guard.update(f.profile, enabled);
  f.set(f.usage(1, 10)); assert.equal((await guard.update(f.profile, enabled)).state, 'blocked');
  assert.equal((await guard.update(f.profile, { ...enabled, stopAtUsedPercent: 99 })).state, 'armed');
  f.set(f.usage(1, 100)); assert.equal((await guard.update(f.profile, enabled)).state, 'blocked');
  assert.equal((await guard.update(f.profile, { ...enabled, enabled: false })).state, 'disabled');
});

test('missing, stale or failed observations cannot manufacture a quota breach or cancel work', async t => {
  const f = await fixture(t), guard = f.create();
  let stops = 0; guard.subscribe(() => { stops++; });
  await guard.update(f.profile, enabled);
  f.advance(); f.set(new Error('private upstream credential must not leak'));
  const unavailable = await guard.read(f.profile);
  assert.equal(unavailable.state, 'unavailable'); assert.equal(await guard.blocked(f.profile), false);
  assert.equal(unavailable.usedPercent, 20, 'retain the last real observation, labelled as last known');
  await guard.assertAllowed(f.profile); assert.equal(stops, 0);
  assert.ok(!JSON.stringify(unavailable).includes('private upstream'));
  f.advance(); const stale = f.usage(); stale.fetchedAt = new Date(epoch - 20_000).toISOString(); f.set(stale);
  assert.equal((await guard.read(f.profile)).state, 'unavailable');
  await guard.assertAllowed(f.profile); assert.equal(stops, 0);
  f.advance(); f.set(f.usage()); assert.equal((await guard.read(f.profile)).state, 'armed');
});

test('unreadable auth is not a measured breach; account rotation never inherits another subscription policy', async t => {
  const f = await fixture(t), guard = f.create();
  await guard.update(f.profile, enabled);
  await writeFile(path.join(f.profile.codexHome, 'auth.json'), 'unreadable auth');
  assert.equal((await guard.read(f.profile)).state, 'unavailable');
  assert.equal(await guard.blocked(f.profile), false);
  await f.auth(f.profile, 'new-synthetic-account');
  assert.equal((await guard.read(f.profile)).state, 'disabled');
  await f.auth(f.profile, '', true); assert.equal(await guard.blocked(f.profile), false);
});

test('API mode wins over stale stored ChatGPT tokens and non-Codex providers are unsupported', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.profile.codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey',
    OPENAI_API_KEY: 'fixture-api-key', tokens: { account_id: 'synthetic-account', access_token: 'old-token' } }));
  assert.deepEqual(await readSubscriptionQuotaIdentity(f.profile), { kind: 'api' });
  assert.deepEqual(await readSubscriptionQuotaIdentity({ ...f.profile, provider: 'claude' }), { kind: 'unsupported' });
  const guard = f.create();
  await assert.rejects(guard.update(f.profile, enabled), /מנוי/);
});

test('any-window policy observes model-specific groups without requiring optional windows', async t => {
  const f = await fixture(t), guard = f.create(), usage = f.usage(5, 6);
  usage.quotaGroups.push({ ...usage.quotaGroups[0], id: 'codex-special', primary: { ...usage.quotaGroups[0].primary!, usedPercent: 96 } });
  f.set(usage);
  assert.equal((await guard.update(f.profile, { ...enabled, window: 'any' })).state, 'blocked');
  await guard.update(f.profile, { ...enabled, enabled: false });
  const incomplete = f.usage(); incomplete.quotaGroups[0].secondary = null; f.set(incomplete);
  assert.equal((await guard.update(f.profile, { ...enabled, window: 'any' })).state, 'armed');
});

test('real promax shape: weekly primary at 87%, null secondary and a 95% limit is armed, not stopped', async t => {
  const f = await fixture(t), guard = f.create(); let stops = 0;
  guard.subscribe(() => { stops++; });
  const weeklyOnly = f.usage(87);
  weeklyOnly.planType = 'promax';
  weeklyOnly.quotaGroups[0].primary!.windowMinutes = 10080;
  weeklyOnly.quotaGroups[0].secondary = null;
  f.set(weeklyOnly);
  for (const window of ['any', 'secondary'] as const) {
    const s = await guard.update(f.profile, { enabled: true, stopAtUsedPercent: 95, window });
    assert.equal(s.state, 'armed'); assert.equal(s.usedPercent, 87);
    assert.equal(s.remainingUntilStopPercent, 8); assert.equal(s.message, null);
    await guard.assertAllowed(f.profile);
  }
  assert.equal(stops, 0);
  f.advance(); const reached = structuredClone(weeklyOnly);
  reached.fetchedAt = f.usage().fetchedAt; reached.quotaGroups[0].primary!.usedPercent = 95;
  f.set(reached);
  assert.equal((await guard.read(f.profile)).state, 'blocked');
  await assert.rejects(guard.assertAllowed(f.profile), isSubscriptionQuotaStopError);
  assert.ok(stops > 0);
  f.advance(); f.set(new Error('network outage after a real breach'));
  assert.equal((await guard.read(f.profile)).state, 'blocked', 'confirmed stops survive later observation failures');
});

test('window duration selects short and weekly limits even when provider slot order changes', async t => {
  const f = await fixture(t), guard = f.create(), usage = f.usage(96, 12);
  usage.quotaGroups[0].primary!.windowMinutes = 10080;
  usage.quotaGroups[0].secondary!.windowMinutes = 300;
  f.set(usage);
  assert.equal((await guard.update(f.profile, { ...enabled, window: 'primary' })).usedPercent, 12);
  assert.equal((await guard.update(f.profile, { ...enabled, window: 'secondary' })).state, 'blocked');
});

test('durable threshold state exists before stop effects; callbacks can reenter reads without deadlocking', async t => {
  const f = await fixture(t), guard = f.create();
  let called = 0;
  guard.subscribe(async event => {
    const record = JSON.parse(await readFile(f.file, 'utf8')).accounts[event.accountKey];
    assert.equal(record.settings.enabled, true); assert.ok(record.latch?.stoppedAt);
    called++;
    if (called === 1) {
      assert.equal((await guard.read(f.other)).state, 'disabled');
      assert.equal(await guard.blocked(f.profile), true, 'native stop recheck cannot recursively emit its own event');
    }
  });
  f.set(f.usage(1, 95)); await guard.update(f.profile, enabled);
  assert.equal(called, 1);
});

test('a stale settings dialog cannot modify the replacement account after credential rotation', async t => {
  const f = await fixture(t), guard = f.create();
  const initial = await guard.read(f.profile);
  assert.match(initial.accountScope!, /^[a-f0-9]{64}$/);
  await f.auth(f.profile, 'newly-selected-subscription');
  await assert.rejects(guard.update(f.profile, enabled, { expectedAccountScope: initial.accountScope }),
    (error: any) => error.statusCode === 409 && error.code === 'SUBSCRIPTION_ACCOUNT_CHANGED');
  const replacement = await guard.read(f.profile);
  assert.equal(replacement.state, 'disabled'); assert.notEqual(replacement.accountScope, initial.accountScope);
  assert.equal((await guard.update(f.profile, enabled, { expectedAccountScope: replacement.accountScope })).state, 'armed');
});

test('bound expected scope can disable during unreadable auth but cannot enable an unidentified account', async t => {
  const f = await fixture(t), guard = f.create();
  const armed = await guard.update(f.profile, enabled);
  await writeFile(path.join(f.profile.codexHome, 'auth.json'), 'temporarily unavailable auth');
  const unavailable = await guard.read(f.profile);
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.accountScope, armed.accountScope);
  const disabled = await guard.update(f.profile, { ...enabled, enabled: false },
    { expectedAccountScope: unavailable.accountScope });
  assert.equal(disabled.state, 'disabled'); assert.equal(disabled.enabled, false);
  await assert.rejects(guard.update(f.profile, enabled, { expectedAccountScope: armed.accountScope }), /להתחבר/);
  const unbound = { ...f.profile, id: 'unbound-without-history' };
  await assert.rejects(guard.update(unbound, enabled, { expectedAccountScope: null }), /להתחבר/);
  assert.equal((await guard.read(unbound)).state, 'unsupported');
});

test('parallel polls share one active quota observation and cannot overlap provider calls', async t => {
  const f = await fixture(t); let reads = 0, active = 0, peak = 0;
  const guard = createSubscriptionQuotaStopService({ storageFile: f.file, profiles: [f.profile, f.twin],
    now: () => epoch, pollMs: 1, loadUsage: async () => {
      reads++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--; return f.usage();
    } });
  await guard.update(f.profile, enabled);
  await Promise.all([guard.poll(), guard.poll(), guard.read(f.profile), guard.read(f.twin)]);
  assert.equal(peak, 1); assert.equal(reads, 1);
});

test('failed policy write cannot acknowledge enabling or perform any stop side effect', async t => {
  const f = await fixture(t); let effects = 0;
  const guard = createSubscriptionQuotaStopService({ storageFile: f.file, profiles: [f.profile],
    now: () => epoch, loadUsage: async () => f.usage(1, 95), persist: async () => { throw new Error('private-path'); } });
  guard.subscribe(() => { effects++; });
  await assert.rejects(guard.update(f.profile, enabled), error => isSubscriptionQuotaStopError(error)
    && !error.message.includes('private-path'));
  assert.equal(effects, 0);
});

test('corrupt policy cannot silently disable a saved guard; independent API billing remains exempt', async t => {
  const f = await fixture(t); await mkdir(path.dirname(f.file), { recursive: true });
  await writeFile(f.file, '{broken-policy');
  const guard = f.create(); await assert.rejects(guard.assertAllowed(f.profile), isSubscriptionQuotaStopError);
  await f.auth(f.profile, '', true); await guard.assertAllowed(f.profile);
});

test('poll coalesces shared accounts, repeats blocked enforcement, and persists armed freshness', async t => {
  const f = await fixture(t), guard = f.create(); let effects = 0;
  guard.subscribe(() => { effects++; });
  await guard.update(f.profile, enabled); assert.equal(f.reads(), 1);
  f.advance(); f.set(f.usage(1, 30)); await guard.poll(); assert.equal(f.reads(), 2);
  const armed = Object.values(JSON.parse(await readFile(f.file, 'utf8')).accounts)[0] as any;
  assert.equal(armed.snapshot.state, 'armed'); assert.equal(armed.snapshot.observedAt, f.usage().fetchedAt);
  f.advance(); f.set(f.usage(1, 90)); await guard.poll(); assert.equal(effects, 1);
  f.advance(); f.set(f.usage(1, 91)); await guard.poll(); assert.equal(effects, 2);
});

test('settings are bounded and accepted-input reconciliation is distinct from new model work', async t => {
  const f = await fixture(t), guard = f.create();
  for (const settings of [{ ...enabled, stopAtUsedPercent: NaN }, { ...enabled, stopAtUsedPercent: 101 },
    { ...enabled, stopAtUsedPercent: 0 }, { ...enabled, window: 'unknown' }, { ...enabled, enabled: 'true' }]) {
    assert.throws(() => guard.update(f.profile, settings), /סף/);
  }
  f.set(f.usage(1, 100)); await guard.update(f.profile, enabled);
  await guard.assertAllowed(f.profile, { recovery: true });
  await guard.assertAllowed(f.profile, { model: 'gemini-4-carbon' });
  await assert.rejects(guard.assertAllowed(f.profile, { model: 'gpt-6.1-sol' }), isSubscriptionQuotaStopError);
});
