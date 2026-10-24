import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { listStoredCodexHistories, readStoredCodexHistory, storedHistoryRevision } from './codexStoredHistory.mjs';
import { restoreArchiveLinks } from '../scripts/restore-session-archive-links.mjs';

export async function createHistoryFixture(home, id = '11111111-2222-4333-8444-999999999992') {
  await fs.mkdir(home, { recursive: true });
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
    updated_at INTEGER, cwd TEXT, title TEXT, source TEXT, model_provider TEXT);`);
  state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, path.join(home, 'missing.jsonl'),
    1786823400, 1786823605, home, 'ארזי הלבנון — היסטוריה', 'cli', 'openai');
  state.close();
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
    started_at INTEGER, completed_at INTEGER, final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    created_at_ms INTEGER, item_type TEXT, item_json TEXT);
    CREATE TABLE thread_realtime_items(thread_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    created_at_ms INTEGER, item_type TEXT, item_json TEXT);`);
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'turn1', 1, 'completed', 1786823400, 1786823605, 'final');
  const insert = db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)');
  const items = [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'בדוק את הפרויקט' }] },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'בודק את הקבצים' },
    { id: 'exec', type: 'commandExecution', command: 'rg --files', aggregatedOutput: 'README.md', exitCode: 0, status: 'completed' },
    { id: 'patch', type: 'fileChange', changes: [{ path: 'app.ts', diff: '+updated' }] },
    { id: 'mcp', type: 'mcpToolCall', server: 'personal_chrome', tool: 'browser_snapshot', arguments: { tabId: 1 }, result: { text: 'snapshot' } },
    { id: 'search', type: 'webSearch', query: 'architecture' },
    { id: 'reasoning', type: 'reasoning', text: 'DO_NOT_EXPOSE' },
    { id: 'final', type: 'agentMessage', text: 'הבדיקה הסתיימה' },
  ];
  items.forEach((item, ordinal) => insert.run(id, 'turn1', item.id, ordinal + 2, 1786823400000 + ordinal * 1000, item.type, JSON.stringify(item)));
  insert.run(id, 'turn1', 'malformed', 12, 1786823409000, 'agentMessage', '{broken');
  insert.run('different-profile-thread', 'turn1', 'private', 1, 1786823400000, 'agentMessage', JSON.stringify({ type: 'agentMessage', text: 'DO_NOT_EXPOSE_OTHER_THREAD' }));
  db.close();
  return id;
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-stored-history-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const id = await createHistoryFixture(home);
  const [record] = await listStoredCodexHistories(home);
  return { home, id, record };
}

test('missing databases are not created and no other profile is searched', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-empty-history-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.deepEqual(await listStoredCodexHistories(home), []);
  assert.deepEqual(await fs.readdir(home), []);
});

test('read-only projection preserves prompts, commentary, final answers and tools, not internal reasoning', async t => {
  const { home, id, record } = await fixture(t);
  const hash = async name => createHash('sha256').update(await fs.readFile(path.join(home, name))).digest('hex');
  const before = await hash('thread_history_1.sqlite');
  const parsed = await readStoredCodexHistory(record);
  assert.equal(record.id, id);
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[1].kind, 'commentary');
  assert.equal(parsed.messages[2].kind, 'final');
  assert.equal(parsed.timeline.filter(entry => entry.entryType === 'tool').length, 4);
  assert.equal(parsed.timeline.find(entry => entry.toolName === 'exec_command').toolOutputText, 'README.md');
  assert.match(JSON.stringify(parsed), /משוחזרת/);
  assert.doesNotMatch(JSON.stringify(parsed), /DO_NOT_EXPOSE/);
  assert.equal(parsed.lastCompletedAt, new Date(1786823605000).toISOString());
  assert.equal(await hash('thread_history_1.sqlite'), before, 'provider database is unchanged');
});

test('streaming replacements are deduplicated, final markers survive and revisions change', async t => {
  const { home, id, record } = await fixture(t);
  const revision = storedHistoryRevision(record).revision;
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  const insert = db.prepare('INSERT INTO thread_realtime_items VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(id, 'final', 20, 1786823605000, 'agentMessage', JSON.stringify({ type: 'agentMessage', text: 'עודכן' }));
  insert.run(id, 'new', 21, 1786823606000, 'commandExecution', JSON.stringify({ type: 'commandExecution', command: 'pwd', aggregatedOutput: 'x'.repeat(210000) }));
  db.close();
  const parsed = await readStoredCodexHistory(record);
  assert.notEqual(storedHistoryRevision(record).revision, revision);
  assert.equal(parsed.messages.filter(entry => entry.id.endsWith('-final')).length, 1);
  assert.equal(parsed.messages.at(-1).kind, 'final');
  assert.equal(parsed.messages.at(-1).text, 'עודכן');
  assert.ok(parsed.timeline.at(-1).toolOutputText.length < 201000);
});

test('archive repair is dry-run by default, profile-scoped, non-overwriting and repeatable', async t => {
  const { home, id } = await fixture(t);
  const archive = path.join(home, 'archive');
  await fs.mkdir(archive);
  const name = `rollout-2026-08-15T15-50-00-${id}.jsonl`;
  const target = path.join(archive, name);
  await fs.writeFile(target, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  await fs.writeFile(path.join(archive, 'rollout-2026-08-15T15-50-00-11111111-2222-4333-8444-999999999994.jsonl'), '{}\n');
  const [missing] = await restoreArchiveLinks({ codexHome: home, archiveRoot: archive });
  assert.equal(missing.id, id);
  await assert.rejects(() => fs.lstat(missing.logical), { code: 'ENOENT' });
  const repaired = await restoreArchiveLinks({ codexHome: home, archiveRoot: archive, apply: true });
  assert.equal(repaired.length, 1);
  assert.equal(await fs.realpath(missing.logical), target);
  assert.deepEqual(await restoreArchiveLinks({ codexHome: home, archiveRoot: archive, apply: true }), []);
  await fs.unlink(missing.logical);
  await fs.writeFile(missing.logical, 'existing session');
  assert.deepEqual(await restoreArchiveLinks({ codexHome: home, archiveRoot: archive, apply: true }), []);
  assert.equal(await fs.readFile(missing.logical, 'utf8'), 'existing session');
});
