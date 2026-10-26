import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('the real catalog retains older topic conversations beyond 500 without changing history', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-full-catalog-'));
  const home = path.join(root, 'home');
  const sessions = path.join(home, 'sessions', '2026', '10', '26');
  await fs.mkdir(sessions, { recursive: true });
  const oldestId = '11111111-2222-4333-8444-000000000000';
  let oldestBytes = '';
  await Promise.all(Array.from({ length: 551 }, async (_, index) => {
    const id = `11111111-2222-4333-8444-${String(index).padStart(12, '0')}`;
    const timestamp = new Date(Date.UTC(2026, 9, 26, 0, index)).toISOString();
    const bytes = [
      { type: 'session_meta', timestamp, payload: { id, timestamp, cwd: root, source: 'cli', model_provider: 'openai' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: index === 0 ? '02 מנוע ורמיקס' : 'Recent conversation' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    if (index === 0) oldestBytes = bytes;
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    await fs.writeFile(file, bytes);
    await fs.utimes(file, new Date(timestamp), new Date(timestamp));
  }));
  process.env.CODEX_APP_ROOT = root;
  process.env.CODEX_STORAGE_ROOT = path.join(root, 'state');
  process.env.CODEX_QUEUE_DISABLE_EXECUTION = '1';
  process.env.CODEX_PROFILES_JSON = JSON.stringify([{ id: 'catalog', label: 'Catalog', provider: 'codex', codexHome: home, workspaceCwd: root }]);
  delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
  const service = await import('./codexService.js');
  const catalog = await service.listCodexSessions('catalog');
  assert.equal(catalog.length, 551);
  assert.ok(catalog.some(row => row.id === oldestId));
  assert.equal((await service.listCodexSessions('catalog', '', 60)).length, 60);
  assert.equal((await service.listCodexSessions('catalog', '', 551)).length, 500);
  assert.equal((await service.listCodexSessions('catalog', '', 551, true)).length, 551);
  assert.equal((await service.listCodexSessions('catalog', '02 מנוע ורמיקס')).length, 1);
  assert.equal(await fs.readFile(path.join(sessions, `rollout-${oldestId}.jsonl`), 'utf8'), oldestBytes);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
});
