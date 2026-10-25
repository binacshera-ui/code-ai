import fs from 'node:fs';
import path from 'node:path';

/** Pinned CLI diagnostic format, not arbitrary assistant/tool error prose. */
export function parseCodexRetryDiagnostic(row, turnId, now = Date.now()) {
  if (row?.target !== 'codex_core::responses_retry' || row.level !== 'WARN' || typeof row.body !== 'string') return null;
  const prefix = row.body.lastIndexOf('}: ');
  const text = prefix >= 0 ? row.body.slice(prefix + 3) : row.body;
  const match = /^stream disconnected - retrying sampling request \(\d+\/\d+ in ([\d.]+)s\)\.\.\. turn_id=([A-Za-z0-9._:-]+) retries=\d+ max_retries=\d+ sampling_error=exceeded retry limit, last status: 429 Too Many Requests(?:, request id: [A-Za-z0-9-]+)?$/.exec(text);
  const at = Number(row.ts) * 1000;
  if (!match || match[2] !== turnId || !Number.isFinite(at) || at > now + 1000
      || at + Number(match[1]) * 1000 <= now) return null;
  return { turnId, kind: 'rate_limit', observedAt: new Date(at).toISOString() };
}

/** Recover missed native retry notices after API reconnect. Read-only, indexed,
 * bounded by profile, exact thread/turn and still-active native backoff.
 * The caller must prove native protocol custody before interrupting.
 */
export async function readCodexRetryObservation(codexHome, threadId, turnId) {
  const file = path.join(codexHome, 'logs_2.sqlite');
  if (!fs.existsSync(file)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
    const rows = db.prepare(`SELECT ts, level, target, substr(feedback_log_body,1,8000) AS body FROM logs
      WHERE thread_id=? AND ts>=? AND target IN ('codex_core::responses_retry','codex_core::stream_events_utils')
      ORDER BY ts DESC, ts_nanos DESC, id DESC LIMIT 64`).all(threadId, Math.floor(Date.now()/1000)-660);
    for (const row of rows) {
      // Later output proves sampling recovered: do not interrupt healthy work
      // based on an older warning still present in this profile's log database.
      if (row.target === 'codex_core::stream_events_utils' && row.body?.includes(`turn.id=${turnId}`)
          && row.body.includes('Output item item_type=')) return null;
      const retry = parseCodexRetryDiagnostic(row, turnId);
      if (retry) return retry;
    }
    return null;
  } catch { return null; } finally { db?.close(); }
}
