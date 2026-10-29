import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// All SQLite calls, legacy import/export and payload JSON work stay off the HTTP
// event loop. SQLite owns journaling and atomicity; this is not another journal.
const SCHEMA_VERSION = 1;
const readOnly = Boolean(workerData.readOnly);
const databaseFile = path.join(workerData.queueRoot, 'queue.sqlite');
let database;

function openDatabase() {
  if (database) return database;
  if (!readOnly) fs.mkdirSync(workerData.queueRoot, { recursive: true });
  const db = new DatabaseSync(databaseFile, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    if (readOnly) {
      db.exec('PRAGMA query_only=ON;');
    } else {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version !== 0 && version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported Codex queue schema version: ${version}`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS queue_items (
          ordinal INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          profile_id TEXT NOT NULL,
          session_id TEXT,
          payload TEXT NOT NULL,
          recovery TEXT NOT NULL,
          summary TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS queue_items_profile_session ON queue_items(profile_id,session_id);
        CREATE TABLE IF NOT EXISTS queue_order (ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS queue_bindings (key TEXT PRIMARY KEY, session_id TEXT NOT NULL) STRICT;
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      fs.chmodSync(databaseFile, 0o660);
    }
    database = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function initialized(db = openDatabase()) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported Codex queue schema version: ${version}`);
  return db.prepare("SELECT value FROM queue_meta WHERE key='initialized'").get()?.value === '1';
}

function requireInitialized() {
  const db = openDatabase();
  if (!initialized(db)) throw new Error('Codex SQLite queue migration is not complete; refusing stale JSON fallback');
  return db;
}

function transaction(operation) {
  if (readOnly) throw new Error('Codex queue reader cannot write');
  const db = openDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation(db);
    db.exec('COMMIT'); // FULL WAL commit is the durable acknowledgement boundary.
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

const recoveryFields = [
  'id', 'profileId', 'sessionId', 'cwd', 'prompt', 'status', 'scheduleMode',
  'recurringFrequency', 'createdAt', 'updatedAt', 'scheduledAt', 'startedAt',
  'completedAt', 'finalMessage', 'error',
];

function itemRow(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
    throw new TypeError('Codex queue item must have a nonempty stable id');
  }
  const projection = {};
  for (const field of recoveryFields) if (item[field] !== undefined) projection[field] = item[field];
  const summary = { ...projection };
  for (const field of ['prompt', 'finalMessage', 'error']) {
    if (typeof summary[field] === 'string') summary[field] = summary[field].slice(0, 2000);
  }
  return [item.id, typeof item.profileId === 'string' ? item.profileId : '',
    typeof item.sessionId === 'string' ? item.sessionId : null,
    JSON.stringify(item), JSON.stringify(projection), JSON.stringify(summary)];
}

function initialize(state, sourceFile) {
  const db = openDatabase();
  if (initialized(db)) throw new Error('Codex SQLite queue is already initialized');
  if (!state || !Array.isArray(state.items) || !state.sessionBindings
      || typeof state.sessionBindings !== 'object' || Array.isArray(state.sessionBindings)) {
    throw new TypeError('Invalid Codex queue migration snapshot');
  }
  const result = transaction((connection) => {
    const insert = connection.prepare('INSERT INTO queue_items(id,profile_id,session_id,payload,recovery,summary) VALUES(?,?,?,?,?,?)');
    const order = connection.prepare('INSERT INTO queue_order(ordinal,id) VALUES(?,?)');
    const bind = connection.prepare('INSERT INTO queue_bindings(key,session_id) VALUES(?,?)');
    const expectedItems = createHash('sha256');
    state.items.forEach((item, index) => {
      const row = itemRow(item);
      insert.run(...row); order.run(index + 1, item.id);
      expectedItems.update(JSON.stringify([item.id, row[3]])).update('\n');
    });
    for (const [key, sessionId] of Object.entries(state.sessionBindings)) {
      if (typeof sessionId !== 'string') throw new TypeError('Invalid Codex queue session binding');
      bind.run(key, sessionId);
    }
    const rows = Number(connection.prepare('SELECT count(*) count FROM queue_items').get().count);
    if (rows !== state.items.length) throw new Error('Codex queue migration row count mismatch');
    const actualItems = createHash('sha256');
    for (const row of connection.prepare('SELECT id,payload FROM queue_items JOIN queue_order USING(id) ORDER BY queue_order.ordinal').iterate()) {
      actualItems.update(JSON.stringify([row.id, row.payload])).update('\n');
    }
    const itemHash = expectedItems.digest('hex');
    if (itemHash !== actualItems.digest('hex')) throw new Error('Codex queue migration payload verification failed');
    const expectedBindings = createHash('sha256'); const actualBindings = createHash('sha256');
    // Query keys use SQLite's own binary ordering on both sides, avoiding a
    // JavaScript UTF-16 versus UTF-8 ordering difference for unusual keys.
    for (const row of connection.prepare('SELECT key,session_id FROM queue_bindings ORDER BY key').iterate()) {
      expectedBindings.update(JSON.stringify([row.key, state.sessionBindings[row.key]])).update('\n');
      actualBindings.update(JSON.stringify([row.key, row.session_id])).update('\n');
    }
    const bindingsHash = expectedBindings.digest('hex');
    const bindingsCount = Number(connection.prepare('SELECT count(*) count FROM queue_bindings').get().count);
    if (bindingsCount !== Object.keys(state.sessionBindings).length || bindingsHash !== actualBindings.digest('hex')) {
      throw new Error('Codex queue migration binding verification failed');
    }
    const metadata = connection.prepare('INSERT INTO queue_meta(key,value) VALUES(?,?)');
    metadata.run('initialized', '1');
    metadata.run('imported_items', String(rows));
    metadata.run('imported_at', new Date().toISOString());
    metadata.run('imported_items_sha256', itemHash);
    metadata.run('imported_bindings_sha256', bindingsHash);
    if (sourceFile) metadata.run('source_file', sourceFile);
    return { itemCount: rows, bindingCount: Object.keys(state.sessionBindings).length };
  });
  // Sync directory creation as well as SQLite's FULL WAL commit. Never rename,
  // truncate or rewrite the legacy snapshot: it remains the migration evidence.
  let directory;
  try { directory = fs.openSync(workerData.queueRoot, 'r'); fs.fsyncSync(directory); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error; }
  finally { if (directory !== undefined) fs.closeSync(directory); }
  return result;
}

function loadState({ allowUninitialized = false } = {}) {
  const db = openDatabase();
  if (!initialized(db)) {
    if (allowUninitialized) return null;
    throw new Error('Codex SQLite queue migration is not complete; refusing stale JSON fallback');
  }
  const items = Array.from(db.prepare('SELECT payload FROM queue_items JOIN queue_order USING(id) ORDER BY queue_order.ordinal').iterate(), (row) => JSON.parse(row.payload));
  const sessionBindings = {};
  for (const row of db.prepare('SELECT key,session_id FROM queue_bindings').all()) {
    Object.defineProperty(sessionBindings, row.key, { value: row.session_id, enumerable: true, configurable: true, writable: true });
  }
  return { items, sessionBindings };
}

function commit(changes) {
  requireInitialized();
  return transaction((db) => {
    const put = db.prepare(`INSERT INTO queue_items(id,profile_id,session_id,payload,recovery,summary) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,session_id=excluded.session_id,
        payload=excluded.payload,recovery=excluded.recovery,summary=excluded.summary`);
    const remove = db.prepare('DELETE FROM queue_items WHERE id=?');
    const removeOrder = db.prepare('DELETE FROM queue_order WHERE id=?');
    const appendOrder = db.prepare('INSERT INTO queue_order(id) VALUES(?) ON CONFLICT(id) DO NOTHING');
    const bind = db.prepare('INSERT INTO queue_bindings(key,session_id) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id');
    const unbind = db.prepare('DELETE FROM queue_bindings WHERE key=?');
    for (const id of changes.deletedIds || []) { remove.run(id); removeOrder.run(id); }
    for (const item of changes.upserts || []) { put.run(...itemRow(item)); appendOrder.run(item.id); }
    for (const key of changes.bindingDeletes || []) unbind.run(key);
    for (const [key, sessionId] of Object.entries(changes.bindingUpserts || {})) {
      if (typeof sessionId !== 'string') throw new TypeError('Invalid Codex queue session binding');
      bind.run(key, sessionId);
    }
    if (changes.orderIds) {
      const count = Number(db.prepare('SELECT count(*) count FROM queue_items').get().count);
      if (changes.orderIds.length !== count || new Set(changes.orderIds).size !== count) {
        throw new Error('Invalid Codex queue item order');
      }
      // Order is small metadata in a separate table. A splice/filter/reorder
      // must never rewrite historical prompt/fork payload pages.
      db.exec('UPDATE queue_order SET ordinal=-ordinal');
      const order = db.prepare('UPDATE queue_order SET ordinal=? WHERE id=?');
      changes.orderIds.forEach((id, index) => {
        if (Number(order.run(index + 1, id).changes) !== 1) throw new Error('Unknown queue id in order');
      });
    }
    return { upserted: (changes.upserts || []).length, deleted: (changes.deletedIds || []).length };
  });
}

function readRecoveredItems({ profileId, sessionId, summary = false }) {
  const db = requireInitialized();
  const column = summary ? 'summary' : 'recovery';
  const rows = sessionId === undefined
    ? db.prepare(`SELECT ${column} result FROM queue_items JOIN queue_order USING(id) WHERE profile_id=? ORDER BY queue_order.ordinal`).all(profileId)
    : db.prepare(`SELECT ${column} result FROM queue_items JOIN queue_order USING(id) WHERE profile_id=? AND session_id=? ORDER BY queue_order.ordinal`).all(profileId, sessionId);
  return rows.map((row) => JSON.parse(row.result));
}

function exportLegacySnapshot(targetFile) {
  const db = requireInitialized();
  if (path.resolve(targetFile) === path.resolve(databaseFile)) throw new Error('Cannot export over SQLite database');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const temporary = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o660);
    fs.writeFileSync(handle, '{"items":[');
    let first = true;
    for (const row of db.prepare('SELECT payload FROM queue_items JOIN queue_order USING(id) ORDER BY queue_order.ordinal').iterate()) {
      fs.writeFileSync(handle, `${first ? '' : ','}${row.payload}`);
      first = false;
    }
    fs.writeFileSync(handle, '],"sessionBindings":{');
    first = true;
    for (const row of db.prepare('SELECT key,session_id FROM queue_bindings').iterate()) {
      fs.writeFileSync(handle, `${first ? '' : ','}${JSON.stringify(row.key)}:${JSON.stringify(row.session_id)}`);
      first = false;
    }
    fs.writeFileSync(handle, '}}');
    fs.fsyncSync(handle);
    fs.closeSync(handle); handle = undefined;
    fs.renameSync(temporary, targetFile);
    let directory;
    try { directory = fs.openSync(path.dirname(targetFile), 'r'); fs.fsyncSync(directory); }
    catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error; }
    finally { if (directory !== undefined) fs.closeSync(directory); }
    return { file: targetFile };
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

parentPort.on('message', ({ id, operation, value }) => {
  try {
    let result;
    switch (operation) {
      case 'load': result = loadState(value); break;
      case 'initialize': result = initialize(value); break;
      case 'initializeFile': result = initialize(JSON.parse(fs.readFileSync(value, 'utf8')), value); break;
      case 'commit': result = commit(value); break;
      case 'recover': result = readRecoveredItems(value); break;
      case 'export': result = exportLegacySnapshot(value); break;
      case 'close': database?.close(); database = undefined; result = null; break;
      default: throw new Error(`Unknown Codex queue store operation: ${operation}`);
    }
    parentPort.postMessage({ id, result });
    if (operation === 'close') parentPort.close();
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error?.message || String(error), code: error?.code, name: error?.name } });
  }
});
