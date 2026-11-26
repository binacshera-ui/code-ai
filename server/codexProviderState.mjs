/** Opaque provider state is not portable conversation history. Never store its contents. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const digest = value => createHash('sha256').update(value).digest('hex');
const opaque = item => item && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;

export function providerStateScope({ provider, endpoint, accountId, accountHeader, credential }) {
  // OAuth refreshes retain the same account scope. API-key rotation deliberately
  // does not inherit another key's sealed state. Never persist a credential.
  return digest(JSON.stringify([provider, endpoint.replace(/\/+$/, ''),
    accountId || digest(credential || ''), accountHeader || accountId || null]));
}

export class ProviderStateStore {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS provider_state (
        fingerprint TEXT NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, item_id TEXT, first_seen TEXT NOT NULL,
        PRIMARY KEY (fingerprint, scope)
      );`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO provider_state VALUES (?, ?, ?, ?, ?, ?)');
    this.lookup = this.db.prepare('SELECT 1 FROM provider_state WHERE fingerprint = ? AND scope = ?');
  }
  record(item, { scope, provider, model }) {
    if (!opaque(item)) return;
    this.insert.run(digest(item.encrypted_content), scope, provider, model || '',
      typeof item.id === 'string' ? item.id.slice(0, 256) : null, new Date().toISOString());
  }
  owns(item, scope) {
    return opaque(item) && !!this.lookup.get(digest(item.encrypted_content), scope);
  }
  close() { this.db.close(); }
}

export function filterProviderState(body, store, scope) {
  if (!Array.isArray(body?.input)) return { body, removed: 0 };
  let removed = 0;
  const input = body.input.filter(item => {
    if (!opaque(item) || store.owns(item, scope)) return true;
    if (item.type !== 'reasoning') {
      // A compacted encrypted checkpoint can be the ONLY remaining history.
      // Do not silently discard it, invent a summary, or send it to another account.
      const error = new Error('Encrypted conversation checkpoint belongs to an unverified provider/account; native text compaction is required before this model switch.');
      error.code = 'provider_state_checkpoint_mismatch';
      throw error;
    }
    removed++;
    return false;
  });
  return { body: removed ? { ...body, input } : body, removed };
}

/** Observe native JSON/SSE output without rewriting a single response byte. */
export function providerStateObserver(contentType, onItem, maxBytes = 64 * 1024 * 1024) {
  const sse = contentType?.includes('text/event-stream');
  const decoder = new StringDecoder('utf8');
  let pending = '', event = [], size = 0, oversized = false;
  const inspect = text => {
    let value;
    try { value = JSON.parse(text); } catch { return; }
    const items = [value.item, ...(Array.isArray(value.output) ? value.output : []),
      ...(Array.isArray(value.response?.output) ? value.response.output : [])];
    for (const item of items) if (opaque(item)) onItem(item);
  };
  const line = text => {
    if (text === '') {
      if (!oversized && event.length) inspect(event.join('\n'));
      event = []; size = 0; oversized = false;
    } else if (text.startsWith('data:')) {
      size += Buffer.byteLength(text);
      if (size > maxBytes) { oversized = true; event = []; }
      if (!oversized) event.push(text.slice(5).replace(/^ /, ''));
    }
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      if (!sse) {
        if (Buffer.byteLength(pending) > maxBytes) { oversized = true; pending = ''; }
        return;
      }
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
      }
      if (Buffer.byteLength(pending) > maxBytes) { oversized = true; pending = ''; event = []; }
    },
    end() {
      pending += decoder.end();
      if (sse) { if (pending) line(pending.replace(/\r$/, '')); line(''); }
      else if (!oversized) inspect(pending);
    },
  };
}
