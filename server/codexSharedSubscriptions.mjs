/** Release only incidental native subscriptions, never threads or their history.
 * Native automatically subscribes initialized connections to newly created
 * threads. A long-lived recovery/run connection must not pin unrelated idle
 * subagents forever. Unsubscription leaves native's inactivity grace period,
 * active-turn checks and all other clients' subscriptions intact.
 */
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const terminalGoals = new Set(['complete', 'completed', 'paused', 'blocked']);
const subscribedMethods = new Set(['thread/start', 'thread/resume', 'thread/fork']);

export function trackExplicitSubscription(channel, method, result) {
  if (!subscribedMethods.has(method) || !id(result?.thread?.id)) return;
  channel.subscriptionRoots ??= new Set();
  channel.subscriptionRoots.add(result.thread.id);
}

export function changesSubscription(method) { return subscribedMethods.has(method); }

export class CodexSharedSubscriptions {
  constructor({ broker, channels, recovery, intervalMs = 300_000, debounceMs = 1_000, releaseIdle = true }) {
    this.broker = broker;
    this.channels = channels;
    this.recovery = recovery;
    this.releaseIdle = releaseIdle;
    this.debounceMs = debounceMs;
    this.closed = false;
    this.pending = null;
    this.running = null;
    this.interval = setInterval(() => this.schedule(), intervalMs);
    this.interval.unref();
  }

  schedule() {
    if (this.closed || this.pending || this.running) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      // Missing/older native inspection APIs retain subscriptions. Cleanup
      // failure must never become a failed turn or replay accepted input.
      void this.sweep().catch(() => {});
    }, this.debounceMs);
    this.pending.unref();
  }

  sweep() {
    if (this.closed) return Promise.resolve({ unsubscribed: 0 });
    if (this.running) return this.running;
    this.running = this.inspectAndRelease().finally(() => { this.running = null; });
    return this.running;
  }

  async inspectAndRelease() {
    const metadata = new Map(), loaded = new Set();
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; page < 64; page++) {
      const result = await this.recovery.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || !result.data.every(id)) throw Error('Invalid loaded-thread metadata');
      for (const value of result.data) loaded.add(value);
      if (loaded.size > 2_048) throw Error('Subscription inspection capacity reached');
      if (!result.nextCursor) break;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor) || page === 63) {
        throw Error('Invalid loaded-thread pagination');
      }
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    const readMetadata = async threadId => {
      if (metadata.has(threadId)) return metadata.get(threadId);
      const result = await this.recovery.call('thread/read', { threadId, includeTurns: false });
      const thread = result?.thread;
      if (!thread || thread.id !== threadId) throw Error('Invalid thread metadata');
      const source = thread.source;
      const parent = source?.subAgent?.thread_spawn?.parent_thread_id;
      // Unknown/ephemeral sources are never treated as disposable.
      const knownSource = typeof source === 'string' && ['cli', 'vscode', 'exec', 'appServer'].includes(source)
        || id(parent);
      const value = { threadId, parent: id(parent) ? parent : null,
        status: thread.status?.type, persistent: thread.ephemeral === false, knownSource };
      metadata.set(threadId, value);
      return value;
    };
    const ancestry = async threadId => {
      const chain = [], seen = new Set();
      let current = threadId;
      while (current && chain.length < 64 && !seen.has(current)) {
        seen.add(current);
        const value = await readMetadata(current);
        if (!value.knownSource) return null;
        chain.push(current); current = value.parent;
      }
      return current ? null : chain;
    };
    const rows = [], protectedRoots = new Set();
    for (const threadId of loaded) {
      if (this.closed) return { unsubscribed: 0 };
      const chain = await ancestry(threadId);
      if (!chain) continue;
      const value = metadata.get(threadId), root = chain.at(-1);
      const rootStatus = metadata.get(root).status;
      const row = { ...value, chain, root, safe: false, mayResume: false };
      rows.push(row);
      if (value.status !== 'idle' || !value.persistent || !['idle', 'notLoaded'].includes(rootStatus)
          || chain.some(threadId => this.unresolved(threadId))) {
        protectedRoots.add(root);
      }
      if (!value.persistent) continue;
      const queue = await this.recovery.call('thread/queue/list', { threadId, limit: 1 });
      const goal = await this.recovery.call('thread/goal/get', { threadId });
      const emptyQueue = Array.isArray(queue?.data) && queue.data.length === 0 && !queue.nextCursor;
      const inactiveGoal = Object.hasOwn(goal ?? {}, 'goal') && (!goal.goal || terminalGoals.has(goal.goal.status));
      // Native resume can continue an active goal when a thread becomes idle.
      // Never let subscription housekeeping wake a goal or pending input.
      row.mayResume = ['active', 'idle'].includes(value.status) && emptyQueue && inactiveGoal;
      if (!row.mayResume) protectedRoots.add(root);
      if (value.status !== 'idle') continue;
      const terminals = await this.recovery.call('thread/backgroundTerminals/list', { threadId, limit: 1 });
      row.safe = row.mayResume
        && Array.isArray(terminals?.data) && terminals.data.length === 0 && !terminals.nextCursor;
      if (!row.safe) protectedRoots.add(root);
    }
    // Rejoining a root does not subscribe a new connection to already-created
    // descendants. Reattach the still-loaded protected tree after broker-only
    // handoff so its idle children survive beyond native's grace period too.
    // Resume supplies no overrides/input; recheck goal/queue state under the
    // public admission fence before using it to attach this connection.
    for (const row of rows) if (protectedRoots.has(row.root) && row.mayResume) {
      if (this.closed) return { unsubscribed: 0 };
      await this.broker.serialize(row.threadId, async () => {
        const current = await this.recovery.call('thread/read', { threadId: row.threadId, includeTurns: false });
        if (!['active', 'idle'].includes(current?.thread?.status?.type)) return;
        const goal = await this.recovery.call('thread/goal/get', { threadId: row.threadId });
        const queue = await this.recovery.call('thread/queue/list', { threadId: row.threadId, limit: 1 });
        if (!Object.hasOwn(goal ?? {}, 'goal') || goal.goal && !terminalGoals.has(goal.goal.status)
            || !Array.isArray(queue?.data) || queue.data.length || queue.nextCursor) return;
        await this.recovery.call('thread/resume', { threadId: row.threadId, excludeTurns: true });
      });
    }
    if (!this.releaseIdle) return { unsubscribed: 0 };
    let unsubscribed = 0;
    for (const row of rows) {
      if (!row.safe || protectedRoots.has(row.root)) continue;
      // Serialize with public admission, settings restoration and completion.
      await this.broker.serialize(row.threadId, async () => {
        if (this.closed || row.chain.some(threadId => this.unresolved(threadId))) return;
        for (const channel of this.channels) {
          if (this.closed || channel.pendingSubscriptions) continue;
          if (channel !== this.recovery) {
            // Desktop/IDE/unknown clients retain their native subscription semantics.
            if (channel.clientName !== 'code-ai' || !channel.subscriptionRoots?.size
                || row.chain.some(threadId => channel.subscriptionRoots.has(threadId))) continue;
          }
          const result = await channel.call('thread/unsubscribe', { threadId: row.threadId });
          if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result?.status)) {
            throw Error('Invalid native unsubscription acknowledgement');
          }
          if (result.status === 'unsubscribed') unsubscribed++;
        }
      });
    }
    return { unsubscribed };
  }

  unresolved(threadId) {
    const record = this.broker.records.get(threadId);
    return record && (record.phase !== 'released' || !record.turnComplete);
  }

  close() {
    this.closed = true;
    clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }
}
