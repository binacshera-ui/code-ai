import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { walkJsonlFiles } from './codexSessionFiles.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-linked-sessions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('linked archive directories and files retain logical paths; aliases and cycles are bounded', async t => {
  const root = await fixture(t);
  const home = path.join(root, 'home');
  const archive = path.join(root, 'hdd');
  await fs.mkdir(home);
  await fs.mkdir(archive);
  await fs.writeFile(path.join(home, 'local.jsonl'), '{}\n');
  await fs.writeFile(path.join(archive, 'archived.jsonl'), '{}\n');
  await fs.writeFile(path.join(archive, 'not-a-session.txt'), '{}\n');
  await fs.symlink(archive, path.join(home, 'day'), 'dir');
  await fs.symlink(archive, path.join(home, 'day-alias'), 'dir');
  await fs.symlink(home, path.join(archive, 'cycle'), 'dir');
  await fs.symlink(path.join(home, 'local.jsonl'), path.join(home, 'alias.jsonl'), 'file');
  await fs.symlink(path.join(root, 'missing'), path.join(home, 'broken'), 'dir');
  await fs.symlink('self-loop', path.join(home, 'self-loop'), 'dir');
  const files = await walkJsonlFiles(home);
  assert.equal(files.length, 2);
  assert.ok(files.includes(path.join(home, 'local.jsonl')));
  assert.ok(files.every(file => file.startsWith(home + path.sep)));
  assert.equal(new Set(await Promise.all(files.map(file => fs.realpath(file)))).size, 2);
  assert.deepEqual(await walkJsonlFiles(path.join(root, 'absent')), []);
  assert.deepEqual(await walkJsonlFiles(path.join(home, 'local.jsonl')), []);
});

test('a linked root and standalone linked rollout are discoverable on every scan', async t => {
  const root = await fixture(t);
  const archive = path.join(root, 'archive');
  const home = path.join(root, 'sessions');
  await fs.mkdir(archive);
  await fs.symlink(archive, home, 'dir');
  const external = path.join(root, 'external.jsonl');
  await fs.writeFile(external, '{}\n');
  await fs.symlink(external, path.join(archive, 'linked.jsonl'), 'file');
  assert.deepEqual(await walkJsonlFiles(home), [path.join(home, 'linked.jsonl')]);
  await fs.writeFile(path.join(archive, 'new.jsonl'), '{}\n');
  assert.equal((await walkJsonlFiles(home)).length, 2);
});

test('HDD-linked live session resolves from its rollout, including cache, pagination and appended events', async t => {
  const root = await fixture(t);
  const codexHome = path.join(root, 'home');
  const parent = path.join(codexHome, 'sessions', '2026', '08');
  const archive = path.join(root, 'hdd', '23');
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(archive, { recursive: true });
  await fs.symlink(archive, path.join(parent, '23'), 'dir');
  const sessionId = '11111111-2222-4333-8444-999999999991';
  const logical = path.join(parent, '23', `rollout-${sessionId}.jsonl`);
  const event = (seconds: number, payload: unknown) => ({ type: 'event_msg', timestamp: `2026-09-06T18:00:${String(seconds).padStart(2, '0')}.000Z`, payload });
  const rows = [
    { type: 'session_meta', timestamp: '2026-08-23T18:00:00.000Z', payload: { id: sessionId, timestamp: '2026-08-23T18:00:00.000Z', cwd: root, source: 'cli' } },
    event(1, { type: 'task_started' }),
    event(2, { type: 'user_message', message: 'Build the project' }),
    event(3, { type: 'agent_message', message: 'Live progress from HDD', phase: 'commentary' }),
  ];
  await fs.writeFile(logical, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  process.env.CODEX_APP_ROOT = root;
  process.env.CODEX_STORAGE_ROOT = path.join(root, 'state');
  process.env.CODEX_PROFILES_JSON = JSON.stringify([{ id: 'linked', label: 'Linked', provider: 'codex', codexHome, workspaceCwd: root }]);
  const service = await import('./codexService.js');
  const first = await service.getCodexSessionDetail(sessionId, 'linked', { tail: 120 });
  assert.equal(first.source, 'cli');
  assert.equal(first.path, logical);
  assert.ok(first.timeline.some(entry => entry.text === 'Live progress from HDD'));
  const summaries = await service.listCodexSessions('linked');
  assert.equal(summaries.filter(entry => entry.id === sessionId).length, 1);
  assert.equal(summaries.find(entry => entry.id === sessionId)?.source, 'cli');
  const persistedPath = path.join(root, 'state', 'session-read-cache', 'v4', 'linked', sessionId, 'tail-120-before-latest.json');
  const persisted = JSON.parse(await fs.readFile(persistedPath, 'utf8'));
  assert.equal(persisted.detail.path, logical);
  let changed = false;
  const subscription = await service.subscribeCodexSessionChanges(sessionId, 'linked', () => { changed = true; });
  t.after(async () => { subscription.close(); });
  await fs.appendFile(logical, [
    event(4, { type: 'agent_message', message: 'Another live update', phase: 'commentary' }),
    event(5, { type: 'agent_message', message: 'Completed work', phase: 'final' }),
    event(6, { type: 'task_complete', last_agent_message: 'Completed work' }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  for (let attempt = 0; attempt < 40 && !changed; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(changed, true, 'the live revision watcher follows the HDD link');
  const incremental = await service.getCodexSessionDetail(sessionId, 'linked', { tail: 120 });
  const full = await service.getCodexSessionDetail(sessionId, 'linked', { full: true });
  assert.deepEqual(incremental.timeline, full.timeline);
  assert.ok(incremental.timeline.some(entry => entry.text === 'Another live update'));
  assert.equal(full.lastCompletedAt, '2026-09-06T18:00:06.000Z');
  const older = await service.getCodexSessionDetail(sessionId, 'linked', { tail: 2, before: 3 });
  assert.deepEqual(older.timeline, full.timeline.slice(1, 3));
});
