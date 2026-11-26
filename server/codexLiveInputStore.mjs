/** Durable delivery receipts, not a work queue. Rows never execute themselves. */
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, open, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const states = new Set(['pending', 'delivered', 'not-delivered', 'unconfirmed']);
function record(row) {
  return row ? {
    id: row.id, profileId: row.profile_id, sessionId: row.session_id,
    clientRequestId: row.request_id, payloadHash: row.payload_hash,
    turnId: row.turn_id, status: row.status, errorCode: row.error_code,
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

export async function createCodexLiveInputStore({ filename, now = () => new Date().toISOString() }) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new TypeError('Absolute live input receipt filename required');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try { const handle = await open(filename, 'wx', 0o600); await handle.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o077
      || typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('Private live input receipt store is unavailable');
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(`CREATE TABLE IF NOT EXISTS live_input_receipts (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, session_id TEXT NOT NULL,
      request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','delivered','not-delivered','unconfirmed')),
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(profile_id, request_id)
    ) STRICT;`);
    await chmod(filename, 0o600);
  } catch (error) { db.close(); throw error; }
  const get = db.prepare('SELECT * FROM live_input_receipts WHERE profile_id = ? AND request_id = ?');
  const byId = db.prepare('SELECT * FROM live_input_receipts WHERE id = ?');
  const insert = db.prepare(`INSERT INTO live_input_receipts
    (id,profile_id,session_id,request_id,payload_hash,turn_id,status,error_code,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',NULL,?,?) ON CONFLICT(profile_id,request_id) DO NOTHING`);
  const delivered = db.prepare(`UPDATE live_input_receipts SET status='delivered',error_code=NULL,updated_at=?
    WHERE id=? AND turn_id=? AND status IN ('pending','unconfirmed')`);
  const rejected = db.prepare(`UPDATE live_input_receipts SET status='not-delivered',error_code=?,updated_at=?
    WHERE id=? AND status IN ('pending','unconfirmed')`);
  const unknown = db.prepare(`UPDATE live_input_receipts SET status='unconfirmed',error_code='LIVE_INPUT_UNCONFIRMED',updated_at=?
    WHERE id=? AND status IN ('pending','unconfirmed')`);
  const required = id => {
    const value = record(byId.get(id));
    if (!value || !states.has(value.status)) throw new Error('Live input receipt is unavailable');
    return value;
  };
  return {
    get(profileId, requestId) { return record(get.get(profileId, requestId)); },
    reserve(value) {
      const at = now(), id = randomUUID();
      const result = insert.run(id, value.profileId, value.sessionId, value.clientRequestId,
        value.payloadHash, value.turnId, at, at);
      return { created: Number(result.changes) === 1, row: record(get.get(value.profileId, value.clientRequestId)) };
    },
    markDelivered(id, turnId) {
      const previous = required(id);
      if (previous.turnId !== turnId || previous.status === 'not-delivered') throw new Error('Live input receipt target changed');
      delivered.run(now(), id, turnId); return required(id);
    },
    markNotDelivered(id, code = 'LIVE_TURN_ENDED') { rejected.run(code, now(), id); return required(id); },
    markUnconfirmed(id) { unknown.run(now(), id); return required(id); },
    close() { db.close(); },
  };
}
