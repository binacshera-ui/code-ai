import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SUBSCRIPTION_QUOTA_STOP,
  validateSubscriptionQuotaStopSettings,
  type SubscriptionQuotaStopSettings,
  type SubscriptionQuotaStopSnapshot,
} from '../shared/subscriptionQuotaStop.js';
import { isGeminiCodexModel } from '../shared/codexGeminiModels.mjs';
import { loadCodexAccountUsage, type CodexAccountUsageSnapshot } from './codexAccountUsage.js';
import { CODEX_APP_CONFIG } from './config.js';

export interface SubscriptionQuotaProfile { id: string; codexHome: string; provider?: string }
type Identity = { kind: 'subscription'; accountKey: string } | { kind: 'api' | 'unavailable' | 'unsupported' };
interface WindowReading { id: string; usedPercent: number; resetsAt: number | null }
interface ThresholdLatch { stoppedAt: string; observedAt: string; windowId: string; resetsAt: number | null }
interface PolicyRecord { settings: SubscriptionQuotaStopSettings; latch: ThresholdLatch | null; snapshot: SubscriptionQuotaStopSnapshot | null }
interface PolicyStore { format: 'code-ai-subscription-quota-stop'; version: 1; accounts: Record<string, PolicyRecord>; bindings: Record<string, string> }
export interface SubscriptionQuotaStopEvent {
  accountKey: string;
  profileIds: string[];
  snapshot: SubscriptionQuotaStopSnapshot;
}
type Listener = (event: SubscriptionQuotaStopEvent) => void | Promise<void>;
const ACCOUNT_KEY = /^[a-f0-9]{64}$/;
const unavailableMessage = 'הגבלת המכסה פעילה, אך נתון שימוש עדכני אינו זמין. שיחות המנוי מושהות עד לאימות המכסה.';

export class SubscriptionQuotaStopError extends Error {
  readonly code = 'SUBSCRIPTION_QUOTA_STOP';
  readonly statusCode = 423;
  constructor(public readonly snapshot: SubscriptionQuotaStopSnapshot | null = null) {
    super(snapshot?.message || unavailableMessage);
    this.name = 'SubscriptionQuotaStopError';
  }
}
export function isSubscriptionQuotaStopError(error: unknown): error is SubscriptionQuotaStopError {
  return error instanceof SubscriptionQuotaStopError || Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'SUBSCRIPTION_QUOTA_STOP');
}
export class SubscriptionQuotaStopAccountChangedError extends Error {
  readonly code = 'SUBSCRIPTION_ACCOUNT_CHANGED';
  readonly statusCode = 409;
  constructor() {
    super('חשבון המנוי השתנה מאז פתיחת ההגדרה. יש לרענן את המכסה לפני השמירה.');
    this.name = 'SubscriptionQuotaStopAccountChangedError';
  }
}

/** No account credential, email or raw account ID leaves this identity boundary. */
export async function readSubscriptionQuotaIdentity(profile: SubscriptionQuotaProfile): Promise<Identity> {
  if (profile.provider && profile.provider !== 'codex') return { kind: 'unsupported' };
  try {
    const auth = JSON.parse(await fs.readFile(path.join(profile.codexHome, 'auth.json'), 'utf8'));
    const mode = String(auth.auth_mode || '').toLowerCase();
    if (['apikey', 'api_key', 'api-key'].includes(mode)) return { kind: 'api' };
    const accountId = auth.tokens?.account_id;
    if (typeof accountId === 'string' && accountId.trim()
        && typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token.trim()) {
      return { kind: 'subscription', accountKey: createHash('sha256').update('codex\0' + accountId.trim()).digest('hex') };
    }
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return { kind: 'api' };
    return { kind: 'unavailable' };
  } catch { return { kind: 'unavailable' }; }
}

function emptyStore(): PolicyStore { return { format: 'code-ai-subscription-quota-stop', version: 1, accounts: {}, bindings: {} }; }
function parseStore(value: unknown): PolicyStore {
  const store = value as PolicyStore;
  if (!store || store.format !== 'code-ai-subscription-quota-stop' || store.version !== 1 || !store.accounts || !store.bindings
      || Array.isArray(store.accounts) || Array.isArray(store.bindings)) throw new Error();
  for (const [key, record] of Object.entries(store.accounts)) {
    if (!ACCOUNT_KEY.test(key) || !record || typeof record !== 'object') throw new Error();
    record.settings = validateSubscriptionQuotaStopSettings(record.settings);
    if (record.snapshot !== null && (!record.snapshot || typeof record.snapshot !== 'object'
      || !['disabled', 'armed', 'blocked', 'unavailable', 'unsupported'].includes(record.snapshot.state))) throw new Error();
    const l = record.latch;
    if (l !== null && (!l || !Number.isFinite(Date.parse(l.stoppedAt))
      || !Number.isFinite(Date.parse(l.observedAt)) || typeof l.windowId !== 'string'
      || !(l.resetsAt === null || Number.isFinite(l.resetsAt)))) throw new Error();
  }
  for (const key of Object.values(store.bindings)) if (!ACCOUNT_KEY.test(key)) throw new Error();
  return store;
}
function unsupported(): SubscriptionQuotaStopSnapshot {
  return { ...DEFAULT_SUBSCRIPTION_QUOTA_STOP, supported: false, state: 'unsupported', usedPercent: null,
    remainingUntilStopPercent: null, resetsAt: null, observedAt: null, stoppedAt: null,
    accountScope: null,
    message: 'ההגבלה מיועדת למנוי ChatGPT מחובר. חיובי API אינם חלק ממכסת המנוי.' };
}
function windows(usage: CodexAccountUsageSnapshot, selected: SubscriptionQuotaStopSettings['window']): WindowReading[] {
  const names = selected === 'any' ? ['primary', 'secondary'] as const : [selected];
  return usage.quotaGroups.flatMap(group => names.flatMap(name => {
    const w = group[name];
    return w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      && w.usedPercent >= 0 && w.usedPercent <= 100
      ? [{ id: `${group.id}:${name}`, usedPercent: w.usedPercent,
        resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null }] : [];
  }));
}

/** One singleton policy owner alongside the existing queue; no model loop. */
export function createSubscriptionQuotaStopService(options: {
  storageFile: string;
  profiles?: SubscriptionQuotaProfile[] | (() => SubscriptionQuotaProfile[]);
  readIdentity?: (profile: SubscriptionQuotaProfile) => Promise<Identity>;
  loadUsage?: (profile: SubscriptionQuotaProfile) => Promise<CodexAccountUsageSnapshot>;
  now?: () => number;
  pollMs?: number;
  maxUsageAgeMs?: number;
  persist?: (store: PolicyStore) => Promise<void>;
}) {
  const now = options.now || Date.now;
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const maxAge = options.maxUsageAgeMs ?? 15_000;
  const identify = options.readIdentity || readSubscriptionQuotaIdentity;
  const loadUsage = options.loadUsage || (profile => loadCodexAccountUsage(profile, { forceRefresh: true }));
  const listeners = new Set<Listener>();
  const notifyingAccounts = new Set<string>();
  const knownProfiles = new Map<string, SubscriptionQuotaProfile>();
  const samples = new Map<string, { checkedAt: number; usage: CodexAccountUsageSnapshot | null }>();
  let store: PolicyStore | null = null;
  let initializing: Promise<void> | null = null;
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  async function initialize() {
    if (store) return;
    if (!initializing) initializing = (async () => {
      try { store = parseStore(JSON.parse(await fs.readFile(options.storageFile, 'utf8'))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') store = emptyStore();
        else throw new SubscriptionQuotaStopError();
      }
    })().finally(() => { initializing = null; });
    await initializing;
  }
  async function persist(next: PolicyStore) {
    if (options.persist) await options.persist(structuredClone(next));
    else {
      await fs.mkdir(path.dirname(options.storageFile), { recursive: true, mode: 0o700 });
      const temporary = options.storageFile + '.' + randomUUID() + '.tmp';
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next) + '\n'); await file.sync(); }
        finally { await file.close(); }
        await fs.rename(temporary, options.storageFile);
        const directory = await fs.open(path.dirname(options.storageFile), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }
    store = next;
  }
  function profiles() {
    const supplied = typeof options.profiles === 'function' ? options.profiles() : options.profiles || [];
    return [...new Map([...supplied, ...knownProfiles.values()].map(p => [p.id, p])).values()];
  }
  async function matchingProfiles(accountKey: string, bindings: Record<string, string>) {
    const ids: string[] = [];
    for (const p of profiles()) {
      const identity = await identify(p);
      if (identity.kind === 'subscription' && identity.accountKey === accountKey
          || identity.kind === 'unavailable' && bindings[p.id] === accountKey) ids.push(p.id);
    }
    return ids;
  }
  async function serialized<T>(operation: (events: SubscriptionQuotaStopEvent[]) => Promise<T>): Promise<T> {
    const events: SubscriptionQuotaStopEvent[] = [];
    const result = chain.then(() => operation(events));
    chain = result.then(() => {}, () => {});
    const value = await result;
    // Listeners may inspect the guard too. Never hold the policy lock while
    // cancelling native work or acquiring the queue's persistence barrier.
    for (const event of events) {
      // Enforcement may recheck the same account immediately before a native
      // mutation. That predicate must not recursively invoke enforcement.
      if (notifyingAccounts.has(event.accountKey)) continue;
      notifyingAccounts.add(event.accountKey);
      try { for (const listener of listeners) {
        try { await listener(event); } catch { /* The next blocked poll retries enforcement. */ }
      } } finally { notifyingAccounts.delete(event.accountKey); }
    }
    return value;
  }

  async function evaluate(profile: SubscriptionQuotaProfile, events: SubscriptionQuotaStopEvent[],
    update?: SubscriptionQuotaStopSettings,
    updateOptions?: { expectedAccountScope?: string | null }): Promise<SubscriptionQuotaStopSnapshot> {
    knownProfiles.set(profile.id, profile);
    const identity = await identify(profile);
    // A temporarily unreadable credential file is not an account switch. A
    // bound guard must remain disableable using its last known opaque scope.
    // Only a positively identified replacement account invalidates that scope.
    if (identity.kind === 'unavailable') await initialize();
    const currentScope = identity.kind === 'subscription' ? identity.accountKey
      : identity.kind === 'unavailable' ? store!.bindings[profile.id] || null : null;
    if (updateOptions && Object.hasOwn(updateOptions, 'expectedAccountScope')
        && updateOptions.expectedAccountScope !== currentScope) {
      throw new SubscriptionQuotaStopAccountChangedError();
    }
    if (identity.kind === 'api' || identity.kind === 'unsupported') {
      if (update?.enabled) throw new Error('הגבלת מכסת מנוי זמינה רק לחשבון ChatGPT המחובר באמצעות מנוי.');
      return unsupported();
    }
    if (identity.kind === 'unavailable' && update?.enabled) {
      throw new Error('יש להתחבר למנוי ChatGPT לפני הפעלת ההגבלה. ניתן לכבות את ההגבלה הקיימת גם בלי נתוני התחברות זמינים.');
    }
    await initialize();
    const draft = structuredClone(store!);
    const key = identity.kind === 'subscription' ? identity.accountKey : draft.bindings[profile.id];
    if (!key) {
      if (update?.enabled) throw new Error('יש להתחבר למנוי ChatGPT לפני הפעלת ההגבלה.');
      return unsupported();
    }
    const old = draft.accounts[key] || { settings: { ...DEFAULT_SUBSCRIPTION_QUOTA_STOP }, latch: null, snapshot: null };
    const record = structuredClone(old);
    const settingsChanged = update && JSON.stringify(record.settings) !== JSON.stringify(update);
    if (update) record.settings = update;
    if (!record.settings.enabled) record.latch = null;
    draft.bindings[profile.id] = key;
    draft.accounts[key] = record;
    let readings: WindowReading[] = [], observedAt: string | null = null;
    let available = false;
    if (record.settings.enabled && identity.kind === 'subscription') {
      let sample = samples.get(key);
      if (!sample || now() - sample.checkedAt >= pollMs || now() < sample.checkedAt || update) {
        let usage: CodexAccountUsageSnapshot | null = null;
        try { usage = await loadUsage(profile); } catch { /* unavailable is fail-closed */ }
        // A logout/login during the request must not apply the old account's
        // usage to either the replacement identity or this profile binding.
        const after = await identify(profile);
        if (after.kind !== 'subscription' || after.accountKey !== key) usage = null;
        sample = { checkedAt: now(), usage }; samples.set(key, sample);
      }
      if (sample.usage?.account.authenticated) {
        const age = now() - Date.parse(sample.usage.fetchedAt);
        if (Number.isFinite(age) && age >= -1_000 && age <= maxAge) {
          readings = windows(sample.usage, record.settings.window);
          available = readings.length > 0 && (record.settings.window !== 'any'
            || ['primary', 'secondary'].every(name => readings.some(w => w.id.endsWith(':' + name))));
          if (available) observedAt = sample.usage.fetchedAt;
        }
      }
    }
    const leading = [...readings].sort((a, b) => b.usedPercent - a.usedPercent)[0] || null;
    const thresholdReached = leading !== null && leading.usedPercent >= record.settings.stopAtUsedPercent;
    if (available && !thresholdReached && record.latch) {
      const previousWindow = readings.find(w => w.id === record.latch!.windowId);
      const provenReset = previousWindow && record.latch.resetsAt !== null
        && previousWindow.resetsAt !== null && previousWindow.resetsAt > record.latch.resetsAt
        && Date.parse(observedAt!) > Date.parse(record.latch.observedAt);
      if (settingsChanged || provenReset) record.latch = null;
    }
    if (record.settings.enabled && thresholdReached && !record.latch) {
      record.latch = { stoppedAt: new Date(now()).toISOString(), observedAt: observedAt!,
        windowId: leading!.id, resetsAt: leading!.resetsAt };
    }
    const state: SubscriptionQuotaStopSnapshot['state'] = !record.settings.enabled ? 'disabled'
      : record.latch ? 'blocked' : !available ? 'unavailable' : 'armed';
    const snapshot: SubscriptionQuotaStopSnapshot = {
      ...record.settings, supported: true, state,
      accountScope: key,
      usedPercent: leading?.usedPercent ?? null,
      remainingUntilStopPercent: leading ? Math.max(0, Math.round((record.settings.stopAtUsedPercent - leading.usedPercent) * 100) / 100) : null,
      resetsAt: leading?.resetsAt ?? record.latch?.resetsAt ?? null,
      observedAt, stoppedAt: record.latch?.stoppedAt ?? null,
      message: state === 'blocked' ? `הושג סף העצירה של ${record.settings.stopAtUsedPercent}%. כל שיחות המנוי נעצרות; ההגבלה אינה חלה על חיובי API.`
        : state === 'unavailable' ? unavailableMessage : null,
    };
    record.snapshot = snapshot;
    // The durable policy and threshold latch precede every cancellation effect.
    if (JSON.stringify(draft) !== JSON.stringify(store)) {
      try { await persist(draft); } catch { throw new SubscriptionQuotaStopError(); }
    }
    if (state === 'blocked' || state === 'unavailable') {
      events.push({ accountKey: key, profileIds: await matchingProfiles(key, draft.bindings), snapshot });
    }
    return snapshot;
  }
  function read(profile: SubscriptionQuotaProfile) { return serialized(events => evaluate(profile, events)); }
  function update(profile: SubscriptionQuotaProfile, value: unknown,
    updateOptions?: { expectedAccountScope?: string | null }) {
    const settings = validateSubscriptionQuotaStopSettings(value);
    return serialized(events => evaluate(profile, events, settings, updateOptions));
  }
  async function blocked(profile: SubscriptionQuotaProfile, model?: string | null) {
    if (isGeminiCodexModel(model)) return false;
    const snapshot = await read(profile);
    return snapshot.enabled && ['blocked', 'unavailable'].includes(snapshot.state);
  }
  async function assertAllowed(profile: SubscriptionQuotaProfile,
    execution: { model?: string | null; recovery?: boolean } = {}) {
    if (execution.recovery || isGeminiCodexModel(execution.model)) return;
    const snapshot = await read(profile);
    if (snapshot.enabled && ['blocked', 'unavailable'].includes(snapshot.state)) throw new SubscriptionQuotaStopError(snapshot);
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await initialize();
      if (!Object.values(store!.accounts).some(record => record.settings.enabled)) return;
      const seen = new Set<string>();
      for (const p of profiles()) {
        const identity = await identify(p);
        const key = identity.kind === 'subscription' ? identity.accountKey
          : identity.kind === 'unavailable' ? store!.bindings[p.id] : null;
        if (!key || seen.has(key) || !store!.accounts[key]?.settings.enabled) continue;
        seen.add(key); await read(p);
      }
    } finally { polling = false; }
  }
  return {
    read, update, blocked, assertAllowed, poll,
    subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (timer) return;
      void poll().catch(() => {});
      timer = setInterval(() => { void poll().catch(() => {}); }, pollMs); timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

const subscriptionQuotaStop = createSubscriptionQuotaStopService({
  storageFile: process.env.CODE_AI_QUOTA_STOP_STATE_FILE
    || path.join(CODEX_APP_CONFIG.storageRoot, 'subscription-quota-stop.json'),
  profiles: () => CODEX_APP_CONFIG.profiles.filter(profile => profile.provider === 'codex'),
});
export const readSubscriptionQuotaStop = subscriptionQuotaStop.read;
export const updateSubscriptionQuotaStop = subscriptionQuotaStop.update;
export const assertSubscriptionQuotaAllowed = subscriptionQuotaStop.assertAllowed;
export const isProfileSubscriptionBlocked = subscriptionQuotaStop.blocked;
export const registerSubscriptionQuotaStopListener = subscriptionQuotaStop.subscribe;
export const startSubscriptionQuotaStopMonitor = subscriptionQuotaStop.start;
export const stopSubscriptionQuotaStopMonitor = subscriptionQuotaStop.stop;
export const pollSubscriptionQuotaStop = subscriptionQuotaStop.poll;
