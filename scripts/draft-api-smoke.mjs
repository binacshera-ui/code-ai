import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Run only against an isolated candidate, never a production queue or home.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'code-ai-draft-api-'));
const storage = path.join(temporary, 'storage');
const home = path.join(temporary, 'provider');
const upload = path.join(storage, 'uploads', 'question.zip');
await mkdir(path.dirname(upload), { recursive: true });
await mkdir(home);
await writeFile(upload, 'draft attachment fixture');
const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let child;
let log = '';
let cookie = '';
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
  CODEX_APP_ROOT: process.cwd(), CODEX_STORAGE_ROOT: storage,
  CODEX_WORKSPACE_ROOT: temporary, CODEX_UPLOAD_ROOT: path.dirname(upload),
  CODEX_QUEUE_ROOT: path.join(storage, 'queue'), CODEX_LOG_ROOT: path.join(storage, 'logs'),
  CODEX_PROFILES_JSON: JSON.stringify([{ id: 'developer', label: 'Fixture', provider: 'codex', codexHome: home, workspaceCwd: temporary }]),
  CODEX_PROFILES_JSON_BASE64: '', CODEX_OPEN_ACCESS: 'true',
  CODEX_DEVICE_ADMIN_PASSWORD: 'draft-test-only', SESSION_SECRET: 'draft-api-test-only',
  DATABASE_URL: '', CODEX_REMOTE_AGENT_TOKEN: '',
  CODEX_REMOTE_HOSTS_FILE: path.join(storage, 'no-remotes.json'),
  CODE_AI_PASSIVE_HTTP_NODE: '1', CODEX_QUEUE_DISABLE_EXECUTION: '1',
  CODEX_CLI_AUTO_UPDATE: 'false', CODEX_NTFY_ENABLED: 'false', CODEX_NTFY_URL: '',
};

async function request(route, method = 'GET', body, expected = 200) {
  const response = await fetch(`${origin}${route}`, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, `${method} ${route} returned ${response.status}`);
  if (expected === 204) {
    assert.equal(await response.text(), '');
    return;
  }
  assert.match(response.headers.get('content-type'), /application\/json/);
  if (route.endsWith('/device-unlock')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}

async function start() {
  child = spawn(process.execPath, ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-5000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-5000); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${log}`);
    try { await request('/api/auth/check-session'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  await request('/api/codex/device-unlock', 'POST', { password: 'draft-test-only' });
}

async function stop() {
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

try {
  await start();
  const input = {
    profileId: 'developer', queueKey: 'draft-api-question',
    prompt: 'השאלה שלי להמשך\nעם הפרטים שלה', promptPreview: 'השאלה שלי להמשך',
    clientRequestId: 'long-press-1', cwd: temporary,
    saveAsDraft: false, // the distinct endpoint must still force draft semantics
    scheduledAt: '2099-01-01T00:00:00.000Z',
    attachments: [{ id: 'zip', name: 'question.zip', path: upload, size: 24, mimeType: 'application/zip', isImage: false }],
  };
  const first = (await request('/api/codex/queue/drafts', 'POST', input, 201)).item;
  assert.equal(first.status, 'draft');
  assert.equal(first.attempts, 0);
  assert.equal(first.startedAt, null);
  assert.equal(first.completedAt, null);
  assert.equal(first.attachments[0].path, upload);
  assert.equal(first.prompt, input.prompt);
  assert.equal((await request('/api/codex/queue/drafts', 'POST', input, 201)).item.id, first.id);
  const state = JSON.parse(await readFile(path.join(storage, 'queue/state.json'), 'utf8'));
  assert.equal(state.items.length, 1);
  await request(`/api/codex/queue/items/${first.id}/retry`, 'POST', {}, 400);
  await request(`/api/codex/queue/items/${first.id}/cancel`, 'POST', {}, 400);
  await stop();
  await start();
  const restored = await request(`/api/codex/queue/items/${first.id}`);
  assert.equal(restored.item.status, 'draft');
  assert.equal(restored.item.prompt, input.prompt);
  assert.equal(restored.item.attempts, 0);
  await request(`/api/codex/queue/items/${first.id}`, 'DELETE', undefined, 204);
  assert.equal(JSON.parse(await readFile(path.join(storage, 'queue/state.json'), 'utf8')).items.length, 0);
  console.log(JSON.stringify({ ok: true, checks: ['draft endpoint', 'attachment persistence', 'idempotency', 'no execution', 'no retry/cancel', 'restart persistence', 'delete'] }));
} finally {
  if (child && child.exitCode === null) await stop();
  await rm(temporary, { recursive: true, force: true });
}
