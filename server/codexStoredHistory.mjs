import fs from 'node:fs';
import path from 'node:path';

// This is a read-only compatibility adapter for orphaned Codex history
// projections. Never recreate a provider rollout from these display items:
// they are not the complete model context. Prefer the original JSONL always.
const TEXT_LIMIT = 200_000;
const VISIBLE_TYPES = new Set([
  'userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange',
  'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch', 'imageView',
  'contextCompaction', 'functionCallOutput',
]);

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

async function openReadOnly(filename, requiredTable) {
  if (!fs.existsSync(filename)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch (error) {
    // Legacy Node installations retain their existing JSONL support.
    if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return null;
    throw error;
  }
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    if (!columns(db, requiredTable).size) {
      db.close();
      return null;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function date(value, fallback = '') {
  if (typeof value === 'string' && value && Number.isNaN(Number(value))) {
    return Number.isNaN(Date.parse(value)) ? fallback : new Date(value).toISOString();
  }
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  const ms = numeric > 100_000_000_000 ? numeric : numeric * 1000;
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())
    ? new Date(ms).toISOString() : fallback;
}

function clip(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}\n… [תוכן כלי קוצר לתצוגה]`;
}

/** All reads are scoped to this profile's own databases, never a shared index. */
export async function listStoredCodexHistories(codexHome) {
  const historyPath = path.join(codexHome, 'thread_history_1.sqlite');
  const statePath = path.join(codexHome, 'state_5.sqlite');
  const history = await openReadOnly(historyPath, 'thread_items');
  if (!history) return [];
  let state;
  try {
    const ids = new Set(history.prepare('SELECT DISTINCT thread_id FROM thread_items').all().map(row => row.thread_id));
    state = await openReadOnly(statePath, 'threads');
    if (!state || !ids.size) return [];
    const available = columns(state, 'threads');
    const optional = name => available.has(name) ? name : `NULL AS ${name}`;
    const rows = state.prepare(`SELECT id, rollout_path, created_at, updated_at, cwd, title, source, model_provider,
      ${optional('name')}, ${optional('preview')}, ${optional('first_user_message')} FROM threads`).all();
    return rows.filter(row => ids.has(row.id)).map(row => ({
      id: row.id,
      historyPath,
      statePath,
      rolloutPath: row.rollout_path,
      title: row.name || row.title || `שיחת Codex ${row.id.slice(0, 8)}`,
      preview: row.preview || row.first_user_message || row.title || '',
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
      cwd: row.cwd || null,
      modelProvider: row.model_provider || null,
      originalSource: row.source,
      nativeSubagent: nativeSubagent(row.source),
    }));
  } finally {
    state?.close();
    history.close();
  }
}

function nativeSubagent(source) {
  let parsed;
  try { parsed = typeof source === 'string' ? JSON.parse(source) : source; } catch { return null; }
  const spawn = parsed?.subagent?.thread_spawn;
  if (!spawn?.parent_thread_id) return null;
  return {
    parentSessionId: spawn.parent_thread_id,
    depth: Number.isFinite(spawn.depth) ? Math.max(1, Math.trunc(spawn.depth)) : 1,
    agentPath: spawn.agent_path || null,
    nickname: spawn.agent_nickname || null,
    role: spawn.agent_role || null,
  };
}

export function storedHistoryRevision(record) {
  const files = [record.statePath, `${record.statePath}-wal`, record.historyPath, `${record.historyPath}-wal`];
  let size = 0;
  let modifiedAt = record.updatedAt;
  const parts = files.map(file => {
    try {
      const s = fs.statSync(file);
      size += s.size;
      const timestamp = s.mtime.toISOString();
      if (timestamp > modifiedAt) modifiedAt = timestamp;
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return 'missing';
    }
  });
  return { revision: parts.join('|'), size, modifiedAt };
}

function mapItem(sessionId, row, turn) {
  let item;
  try { item = JSON.parse(row.item_json); } catch { return null; }
  const type = item.type || row.item_type;
  // In particular, do not surface raw internal reasoning or world state.
  if (!VISIBLE_TYPES.has(type)) return null;
  const base = {
    id: `${sessionId}-history-${row.item_id}`,
    timestamp: date(row.created_at_ms, date(turn?.started_at)),
  };
  if (type === 'userMessage') {
    const text = (item.content || []).map(part => part.type === 'text' ? part.text || ''
      : part.type === 'image' || part.type === 'localImage' ? '[תמונה מצורפת]' : '').filter(Boolean).join('\n');
    return { ...base, entryType: 'message', role: 'user', kind: 'prompt', text };
  }
  if (type === 'agentMessage' || type === 'plan') {
    const kind = item.phase === 'final_answer' || item.phase === 'final'
      || !item.phase && turn?.final_agent_item_id === row.item_id ? 'final' : 'commentary';
    return { ...base, entryType: 'message', role: 'assistant', kind, text: item.text || '' };
  }
  if (type === 'contextCompaction') {
    return { ...base, entryType: 'status', status: 'compacted', title: 'השיחה סוכמה אוטומטית' };
  }
  const entry = { ...base, entryType: 'tool', callId: item.id || row.item_id, status: item.status || 'completed', exitCode: item.exitCode ?? null };
  if (type === 'commandExecution') {
    return { ...entry, toolName: 'exec_command', title: 'הרצת פקודה', toolInputText: clip(item.command), toolInputLanguage: 'bash', toolOutputText: clip(item.aggregatedOutput), toolOutputLanguage: 'text' };
  }
  if (type === 'fileChange') {
    return { ...entry, toolName: 'apply_patch', title: 'שינוי קבצים', toolInputText: clip(item.changes), toolInputLanguage: 'json' };
  }
  if (type === 'mcpToolCall') {
    return { ...entry, toolName: `${item.server || 'mcp'}.${item.tool || 'tool'}`, title: item.tool || 'כלי MCP', toolInputText: clip(item.arguments), toolInputLanguage: 'json', toolOutputText: clip(item.error || item.result), toolOutputLanguage: 'json' };
  }
  if (type === 'webSearch') {
    return { ...entry, toolName: 'web.search', title: 'חיפוש באינטרנט', toolInputText: clip(item.action || item.query), toolInputLanguage: 'json' };
  }
  return { ...entry, toolName: item.tool || item.name || type, title: item.tool || item.name || type,
    toolInputText: clip(item.arguments || item.prompt || item.path), toolInputLanguage: 'json',
    toolOutputText: clip(item.output || item.contentItems || item.agentStatus), toolOutputLanguage: 'json' };
}

export async function readStoredCodexHistory(record) {
  const db = await openReadOnly(record.historyPath, 'thread_items');
  if (!db) return null;
  try {
    db.exec('BEGIN'); // One consistent read snapshot, released before returning.
    const turns = columns(db, 'thread_turns').size
      ? db.prepare('SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal').all(record.id) : [];
    const byTurn = new Map(turns.map(turn => [turn.turn_id, turn]));
    const finalTurns = new Map(turns.filter(turn => turn.final_agent_item_id).map(turn => [turn.final_agent_item_id, turn]));
    const timeline = [{
      id: `${record.id}-history-source`, entryType: 'status', timestamp: record.createdAt,
      status: 'history-recovered', title: 'היסטוריה משוחזרת ממסד Codex',
      subtitle: 'הודעות וכלים שנשמרו במסד. קובץ המקור חסר; זו תצוגה בלבד ולא תחליף להקשר הסוכן.',
    }];
    const rows = db.prepare('SELECT * FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal, created_at_ms, item_id').all(record.id);
    const positions = new Map();
    for (const row of rows) {
      const entry = mapItem(record.id, row, byTurn.get(row.turn_id));
      if (entry) { positions.set(row.item_id, timeline.length); timeline.push(entry); }
    }
    // Active streaming items may not yet have been projected into thread_items.
    if (columns(db, 'thread_realtime_items').size) {
      const realtime = db.prepare('SELECT * FROM thread_realtime_items WHERE thread_id = ? ORDER BY rollout_ordinal, created_at_ms').all(record.id);
      for (const row of realtime) {
        const entry = mapItem(record.id, row, finalTurns.get(row.item_id));
        if (!entry) continue;
        if (positions.has(row.item_id)) timeline[positions.get(row.item_id)] = entry;
        else { positions.set(row.item_id, timeline.length); timeline.push(entry); }
      }
    }
    const messages = timeline.filter(entry => entry.entryType === 'message');
    const lastCompletedAt = turns.filter(turn => turn.status === 'completed' && turn.completed_at)
      .map(turn => date(turn.completed_at)).sort().at(-1) || null;
    return {
      title: record.title, preview: messages.at(-1)?.text || record.preview,
      timeline, messages, totalTimelineEntries: timeline.length, messageCount: messages.length,
      firstMessage: messages[0] || null, lastMessage: messages.at(-1) || null, lastCompletedAt,
      isCompactClone: false, compactSourceSessionId: null,
    };
  } finally {
    // Closing a read-only transaction never writes or checkpoints provider data.
    db.close();
  }
}
