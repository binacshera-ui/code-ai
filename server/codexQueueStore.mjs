import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';

const writerStores = new Map();
const readerStores = new Map();
export const CODEX_QUEUE_SQLITE_FILENAME = 'queue.sqlite';
export function queueStoreExists(queueRoot) {
  return existsSync(path.join(queueRoot, CODEX_QUEUE_SQLITE_FILENAME));
}

function createWorkerClient({ queueRoot, workerUrl, readOnly = false }) {
  const worker = new Worker(workerUrl || new URL('./codexQueueStoreWorker.mjs', import.meta.url), {
    workerData: { queueRoot, readOnly },
    // This plain-JS worker needs no CLI loaders. Forwarding execArgv can pass
    // unsupported process/V8 flags (including expanded Node 24 test defaults),
    // or --input-type intended for an eval launcher rather than this .mjs file.
    execArgv: [],
  });
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  let closed = false;
  function fail(error) {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker.unref();
  }
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!closed || pending.size) fail(new Error(`Codex queue store worker exited (${code})`));
  });
  worker.on('message', ({ id, result, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (!pending.size) worker.unref();
    if (error) {
      const remote = Object.assign(new Error(error.message), { name: error.name || 'Error', code: error.code });
      request.reject(remote);
    } else request.resolve(result);
  });
  worker.unref();
  function call(operation, value) {
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.reject(new Error('Codex queue store is closed'));
    const id = ++nextId;
    worker.ref();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, value }); }
      catch (error) { pending.delete(id); if (!pending.size) worker.unref(); reject(error); }
    });
  }
  return {
    call,
    async close() {
      if (closed) return;
      try { await call('close'); } finally { closed = true; await worker.terminate(); }
    },
  };
}

/** One process-owned writer. The caller serializes mutations using its existing
 * persistence barrier. It must not acknowledge input before commit resolves.
 */
export function createCodexQueueStore({ queueRoot, workerUrl } = {}) {
  if (typeof queueRoot !== 'string' || !queueRoot) throw new TypeError('queueRoot is required');
  const root = path.resolve(queueRoot);
  if (writerStores.has(root)) throw new Error('A Codex SQLite queue writer already exists in this process');
  const client = createWorkerClient({ queueRoot: root, workerUrl });
  const store = {
    loadState: () => client.call('load', { allowUninitialized: true }),
    initialize: (state) => client.call('initialize', state),
    initializeFromLegacyFile: (file) => client.call('initializeFile', path.resolve(file)),
    commit: (changes) => client.call('commit', changes),
    readRecoveredQueueItems: (filter) => client.call('recover', filter),
    exportLegacySnapshot: (file) => client.call('export', path.resolve(file)),
    async close() { try { await client.close(); } finally { writerStores.delete(root); } },
  };
  writerStores.set(root, store);
  return store;
}

function readClient(queueRoot) {
  const root = path.resolve(queueRoot);
  if (!existsSync(path.join(root, CODEX_QUEUE_SQLITE_FILENAME))) return null;
  const writer = writerStores.get(root);
  if (writer) return { recover: (filter) => writer.readRecoveredQueueItems(filter), load: () => writer.loadState().then((state) => {
    if (!state) throw new Error('Codex SQLite queue migration is not complete; refusing stale JSON fallback');
    return state;
  }) };
  let reader = readerStores.get(root);
  if (!reader) {
    reader = createWorkerClient({ queueRoot: root, readOnly: true });
    readerStores.set(root, reader);
  }
  return { recover: (filter) => reader.call('recover', filter), load: () => reader.call('load') };
}

/** null means absent SQLite only. Never fall back to a stale JSON archive after
 * a migration has started, even when an old process lacks the opt-in env var.
 */
export async function readRecoveredQueueItems({ queueRoot, profileId, sessionId, summary = false } = {}) {
  const reader = readClient(queueRoot);
  return reader ? reader.recover({ profileId, sessionId, summary }) : null;
}

export async function readCodexQueueStoreSnapshot({ queueRoot } = {}) {
  const reader = readClient(queueRoot);
  return reader ? reader.load() : null;
}

export async function closeCodexQueueStoreReaders() {
  const readers = [...readerStores.values()];
  readerStores.clear();
  await Promise.all(readers.map((reader) => reader.close()));
}
