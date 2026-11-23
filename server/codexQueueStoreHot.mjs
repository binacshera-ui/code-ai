import { createCodexQueueStore, queueStoreExists } from './codexQueueStore.mjs';
import { createQueueStateTracker } from './codexQueueStoreTracking.mjs';

const installations = new Map();

function groupRecoveredItems(entries, profile, sanitize) {
  const recovered = new Map();
  for (const entry of entries) {
    const item = sanitize(entry);
    if (!item || item.profileId !== profile.id) continue;
    const current = recovered.get(item.sessionId) || {
      id: item.sessionId, profileId: item.profileId, cwd: item.cwd,
      createdAt: item.createdAt, updatedAt: item.updatedAt, items: [],
    };
    current.items.push(item);
    current.cwd ||= item.cwd;
    current.createdAt = !current.createdAt || item.createdAt < current.createdAt ? item.createdAt : current.createdAt;
    if (item.updatedAt > current.updatedAt) current.updatedAt = item.updatedAt;
    recovered.set(item.sessionId, current);
  }
  for (const session of recovered.values()) {
    session.items.sort((left, right) => {
      const leftAnchor = left.createdAt || left.scheduledAt || left.updatedAt;
      const rightAnchor = right.createdAt || right.scheduledAt || right.updatedAt;
      return leftAnchor.localeCompare(rightAnchor) || left.updatedAt.localeCompare(right.updatedAt);
    });
    session.createdAt = session.items[0]?.createdAt || session.createdAt;
    session.updatedAt = session.items.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, session.updatedAt);
  }
  return recovered;
}

/** Called synchronously in the exact existing owner scope. No restart, forked
 * queue runner, native owner change or prompt replay. Async work starts only
 * once V8 resumes. Existing active-item closures retain their raw references;
 * explicitly marking the small active set on each persist bridges those aliases.
 */
export function prepareOwnerStore(scope) {
  const { queueRoot, legacyFile } = scope;
  if (installations.has(queueRoot)) return installations.get(queueRoot);
  const required = ['getState', 'setState', 'getActiveIds', 'getPersistTail', 'setPersistTail',
    'replacePersist', 'onPersistStart', 'onPersistEnd', 'replaceRecoveredLoader', 'sanitizeRecoveredQueueItem'];
  for (const name of required) if (typeof scope[name] !== 'function') throw new TypeError(`Missing owner bridge: ${name}`);
  if (queueStoreExists(queueRoot)) throw new Error('Existing SQLite queue requires normal recovery, not a second live migration');
  const previousTail = scope.getPersistTail();
  const tracker = createQueueStateTracker(scope.getState());
  const store = createCodexQueueStore({ queueRoot });
  let flushActive = false;
  let waiters = [];
  let lastError = null;
  let initialized = false;
  let commits = 0;
  let importedItems = 0;
  let lastCommitMs = null;
  let lastUpserts = 0;
  scope.setState(tracker.state);

  const ready = (async () => {
    await previousTail;
    const imported = await store.initializeFromLegacyFile(legacyFile);
    importedItems = imported.itemCount;
    initialized = true;
  })().catch((error) => { lastError = error?.message || String(error); throw error; });
  // Retain a failed status even if the process is otherwise idle at migration.
  ready.catch(() => undefined);

  async function flush() {
    await Promise.resolve();
    try {
      while (waiters.length) {
        const batch = waiters; waiters = [];
        let changes;
        try {
          await ready;
          for (const id of scope.getActiveIds()) tracker.markItem(id);
          changes = tracker.takeChanges();
          const started = performance.now();
          await store.commit(changes);
          commits += 1; lastCommitMs = performance.now() - started; lastUpserts = changes.upserts.length;
          lastError = null;
          for (const waiter of batch) waiter.resolve();
        } catch (error) {
          if (changes) tracker.restoreChanges(changes);
          lastError = error?.message || String(error);
          for (const waiter of batch) waiter.reject(error);
        }
      }
    } finally { flushActive = false; }
  }

  async function persist() {
    scope.onPersistStart();
    const operation = new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      if (!flushActive) {
        flushActive = true;
        scope.setPersistTail(flush());
      }
    });
    try { await operation; } finally { scope.onPersistEnd(); }
  }
  scope.replacePersist(persist);
  scope.replaceRecoveredLoader(async (profile, options = {}) => {
    await ready;
    const entries = await store.readRecoveredQueueItems({ profileId: profile.id,
      sessionId: options.sessionId, summary: options.summary === true });
    return groupRecoveredItems(entries, profile, scope.sanitizeRecoveredQueueItem);
  });
  const installation = {
    ready,
    status: () => ({ initialized, importedItems, commits, lastCommitMs, lastUpserts, lastError, pending: waiters.length, storage: 'sqlite-wal-full-worker' }),
    rollbackExport: async (targetFile) => { await ready; await scope.getPersistTail(); return store.exportLegacySnapshot(targetFile); },
    async close() { await ready; await scope.getPersistTail(); await store.close(); },
  };
  installations.set(queueRoot, installation);
  return installation;
}
