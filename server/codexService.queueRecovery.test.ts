import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCodexQueueStore, closeCodexQueueStoreReaders } from './codexQueueStore.mjs';

test('queue-recovered history uses the authoritative incremental store without reviving frozen JSON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-queue-history-projection-'));
  const queueRoot = path.join(root, 'state', 'queue');
  await mkdir(queueRoot, { recursive: true });
  const profileIds = ['legacy', 'incremental', 'other'];
  await Promise.all(profileIds.map(id => mkdir(path.join(root, id, 'sessions'), { recursive: true })));
  process.env.CODEX_APP_ROOT = root;
  process.env.CODEX_STORAGE_ROOT = path.join(root, 'state');
  process.env.CODEX_QUEUE_DISABLE_EXECUTION = '1';
  process.env.CODEX_PROFILES_JSON = JSON.stringify(profileIds.map(id => ({
    id, label: id, provider: 'codex', codexHome: path.join(root, id), workspaceCwd: root,
    defaultProfile: id === 'legacy',
  })));
  delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
  const session = (number: number) => `11111111-2222-4333-8444-${String(number).padStart(12, '0')}`;
  const longOriginalPrompt = `Original input failed-attempt ${'original-history '.repeat(2000)}END_OF_FULL_ORIGINAL_INPUT`;
  const row = (id: string, profileId: string, sessionId: string, extra = {}) => ({
    id, profileId, sessionId, queueKey: sessionId, cwd: root,
    prompt: `Original input ${id}`, promptPreview: `Original input ${id}`,
    status: 'failed', scheduleMode: 'once', recurringFrequency: null,
    createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:01:00Z',
    scheduledAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z',
    completedAt: '2026-10-28T09:01:00Z', finalMessage: null, error: 'Original failure retained',
    ...extra,
  });
  const frozen = JSON.stringify({ items: [
    row('legacy-only', 'legacy', session(1)),
    row('stale-json-only', 'incremental', session(2)),
  ], sessionBindings: {} });
  await writeFile(path.join(queueRoot, 'state.json'), frozen);
  const service = await import('./codexService.js');
  let store: ReturnType<typeof createCodexQueueStore> | null = null;
  t.after(async () => {
    await closeCodexQueueStoreReaders();
    await store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  await t.test('legacy history still loads before migration', async () => {
    const detail = await service.getCodexSessionDetail(session(1), 'legacy', { tail: 40 });
    assert.equal(detail.source, 'queue-recovered');
    assert.ok(detail.path.endsWith(`state.json#${session(1)}`));
    assert.ok(detail.messages.some(message => message.text === 'Original input legacy-only'));
  });

  store = createCodexQueueStore({
    queueRoot,
    workerUrl: pathToFileURL(path.resolve('server/codexQueueStoreWorker.mjs')),
  });
  await store.initialize({ items: [
    row('failed-attempt', 'incremental', session(3), { prompt: longOriginalPrompt }),
    row('successful-retry', 'incremental', session(3), {
      prompt: 'Continue after original failure', status: 'completed',
      createdAt: '2026-10-28T09:02:00Z', updatedAt: '2026-10-28T09:03:00Z',
      completedAt: '2026-10-28T09:03:00Z', finalMessage: 'Recovered successfully', error: null,
    }),
    row('private-other-profile', 'other', session(4)),
    row('unsent-draft', 'incremental', session(5), { status: 'draft' }),
  ], sessionBindings: { 'draft:original': session(3) } });

  await t.test('catalog and full detail retain original failures and later retry from SQLite', async () => {
    const catalog = await service.listCodexSessions('incremental');
    assert.deepEqual(catalog.map(entry => entry.id), [session(3)]);
    const detail = await service.getCodexSessionDetail(session(3), 'incremental', { full: true });
    assert.ok(detail.path.endsWith(`queue.sqlite#${session(3)}`));
    assert.deepEqual(detail.messages.filter(message => message.role === 'user').map(message => message.text),
      [longOriginalPrompt, 'Continue after original failure']);
    assert.ok(detail.messages.some(message => message.text === 'Recovered successfully'));
    assert.ok(detail.timeline.some(entry => entry.subtitle?.includes('Original failure retained')));
  });

  await t.test('stale legacy-only session, wrong-profile session, and unsent draft cannot reappear', async () => {
    await assert.rejects(service.getCodexSessionDetail(session(2), 'incremental'), /was not found/);
    await assert.rejects(service.getCodexSessionDetail(session(4), 'incremental'), /was not found/);
    await assert.rejects(service.getCodexSessionDetail(session(5), 'incremental'), /was not found/);
    assert.equal(await readFile(path.join(queueRoot, 'state.json'), 'utf8'), frozen);
  });

  await t.test('uninitialized or corrupt authoritative SQLite does not fall back to legacy JSON', async () => {
    await store!.close();
    store = null;
    const originalQueue = queueRoot;
    const database = path.join(originalQueue, 'queue.sqlite');
    // A new uncached session exists in JSON, so this rejects only if recovery
    // actually checks the authoritative database instead of ignoring its error.
    await writeFile(database, '');
    store = createCodexQueueStore({ queueRoot, workerUrl: pathToFileURL(path.resolve('server/codexQueueStoreWorker.mjs')) });
    await assert.rejects(service.getCodexSessionDetail(session(2), 'incremental'), /migration is not complete/);
    await store.close();
    store = null;
    await writeFile(database, 'not a SQLite database');
    store = createCodexQueueStore({ queueRoot, workerUrl: pathToFileURL(path.resolve('server/codexQueueStoreWorker.mjs')) });
    await assert.rejects(service.getCodexSessionDetail(session(2), 'incremental'),
      error => error instanceof Error && !/was not found/.test(error.message));
    assert.equal(await readFile(path.join(queueRoot, 'state.json'), 'utf8'), frozen);
  });
});
