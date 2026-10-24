import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { createCodexDeploymentDrain } from '../server/codexDeploymentDrain.mjs';
import os from 'node:os';
import path from 'node:path';

// An isolated passive HTTP candidate: no production queue, provider auth,
// background agents, notifications or provider execution are available.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'code-ai-history-api-'));
const storage = path.join(temporary, 'storage');
const home = path.join(temporary, 'home');
const archive = path.join(temporary, 'archive');
await mkdir(home); await mkdir(archive);
const rawId = '11111111-2222-4333-8444-999999999991';
const orphanId = '11111111-2222-4333-8444-999999999992';
const rawPath = path.join(archive, `rollout-${rawId}.jsonl`);
const event = (type, fields) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, ...fields } });
await writeFile(rawPath, [
  JSON.stringify({ type: 'session_meta', payload: { id: rawId, timestamp: new Date().toISOString(), source: 'cli', cwd: temporary } }),
  event('user_message', { message: 'הודעת משתמש' }),
  event('agent_message', { message: 'התקדמות מהארכיון', phase: 'commentary' }),
].join('\n') + '\n');
const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, source TEXT, model_provider TEXT)');
state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(orphanId, 'missing.jsonl', 1786823400, 1786823605, temporary, 'שיחה משוחזרת', 'cli', 'openai');
state.close();
const historyPath = path.join(home, 'thread_history_1.sqlite');
const history = new DatabaseSync(historyPath);
history.exec('CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_type TEXT, item_json TEXT)');
for (const [ordinal, item] of [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'בקשה ישנה' }] },
  { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'בדיקה ישנה' },
  { id: 'tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/fixture', status: 'completed' },
  { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'תשובה ישנה' },
].entries()) history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)').run(orphanId, 'turn', item.id, ordinal, 1786823400000 + ordinal * 1000, item.type, JSON.stringify(item));
history.close();
const before = await readFile(historyPath);
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
// The passive HTTP candidate needs a synthetic admission owner; it never executes provider work.
const admission = createCodexDeploymentDrain({ queueRoot: path.join(storage, 'queue'), requiredParticipants: [] });
let child, log = '', cookie = '';
const env = {
  ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
  CODEX_APP_ROOT: process.cwd(), CODEX_STORAGE_ROOT: storage, CODEX_WORKSPACE_ROOT: temporary,
  CODEX_QUEUE_ROOT: path.join(storage, 'queue'), CODEX_LOG_ROOT: path.join(storage, 'logs'),
  CODEX_PROFILES_JSON: JSON.stringify([
    { id: 'developer', label: 'Fixture', provider: 'codex', codexHome: home, sessionArchiveRoots: [archive], workspaceCwd: temporary },
    { id: 'other', label: 'Other', provider: 'codex', codexHome: path.join(temporary, 'other'), workspaceCwd: temporary },
  ]), CODEX_PROFILES_JSON_BASE64: '', CODEX_OPEN_ACCESS: 'true',
  CODEX_DEVICE_ADMIN_PASSWORD: 'history-test-only', SESSION_SECRET: 'history-api-test-only',
  DATABASE_URL: '', CODEX_REMOTE_AGENT_TOKEN: '', CODEX_REMOTE_HOSTS_FILE: path.join(storage, 'no-remotes.json'),
  CODE_AI_PASSIVE_HTTP_NODE: '1', CODEX_QUEUE_DISABLE_EXECUTION: '1', CODEX_CLI_AUTO_UPDATE: 'false',
  CODEX_NTFY_ENABLED: 'false', CODEX_NTFY_URL: '',
};
async function request(route, expected = 200, method = 'GET', body) {
  const response = await fetch(origin + route, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, expected, `${method} ${route}`);
  assert.match(response.headers.get('content-type'), /application\/json/);
  if (route.endsWith('/device-unlock')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
try {
  await admission.startController();
  child = spawn(process.execPath, ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-5000); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Candidate exited: ${log}`);
    try { await request('/api/auth/check-session'); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  await request('/api/codex/device-unlock', 200, 'POST', { password: 'history-test-only' });
  const route = id => `/api/codex/sessions/${id}?profile=developer`;
  const raw = (await request(route(rawId) + '&tail=120')).session;
  assert.equal(raw.source, 'cli'); assert.equal(raw.path, rawPath);
  assert.ok(raw.timeline.some(entry => entry.text === 'התקדמות מהארכיון'));
  const recovered = (await request(route(orphanId) + '&full=1')).session;
  assert.equal(recovered.source, 'history-db');
  assert.ok(recovered.timeline.some(entry => entry.toolName === 'exec_command'));
  assert.ok(recovered.timeline.some(entry => entry.kind === 'commentary'));
  assert.ok(recovered.timeline.some(entry => entry.kind === 'final'));
  const older = (await request(route(orphanId) + '&tail=2&before=3')).session;
  assert.deepEqual(older.timeline, recovered.timeline.slice(1, 3));
  await request(`/api/codex/sessions/${orphanId}?profile=other`, 404);
  await request(route(orphanId), 400, 'DELETE');
  assert.deepEqual(await readFile(historyPath), before);
  await appendFile(rawPath, event('agent_message', { message: 'עדכון חי חדש', phase: 'final' }) + '\n');
  const updated = (await request(route(rawId) + '&tail=120')).session;
  assert.ok(updated.timeline.some(entry => entry.text === 'עדכון חי חדש'));
  console.log(JSON.stringify({ ok: true, checks: ['detached HDD archive', 'SQL projection', 'visible tools and messages', 'pagination', 'profile isolation', 'blocked mutation', 'provider data unchanged', 'live append'] }));
} finally {
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
  await admission.stopController();
  await rm(temporary, { recursive: true, force: true });
}
