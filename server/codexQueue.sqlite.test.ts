import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// esbuild bundles application modules into this test, but the SQLite worker is
// intentionally a separate file in both the real release and the fixture.
const sourceWorker = path.resolve('server/codexQueueStoreWorker.mjs');
const bundledWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codexQueueStoreWorker.mjs');
if (sourceWorker !== bundledWorker) await copyFile(sourceWorker, bundledWorker);

const execFileAsync = promisify(execFile);
function configure(root: string, enableMigration = true) {
  process.env.CODEX_STORAGE_ROOT = root;
  process.env.CODEX_QUEUE_DISABLE_EXECUTION = '1';
  process.env.CODEX_NTFY_STATE_FILE = path.join(root, 'notifications.json');
  process.env.CODEX_PROFILES_JSON = JSON.stringify([{ id: 'developer', label: 'Synthetic queue test', provider: 'codex',
    codexHome: path.join(root, 'home'), workspaceCwd: root, defaultProfile: true }]);
  if (enableMigration) process.env.CODEX_QUEUE_STORAGE = 'sqlite';
  else delete process.env.CODEX_QUEUE_STORAGE;
  delete process.env.CODE_AI_CODEX_SHARED_OWNER_PROFILES;
}

if (process.argv[2] === '--queue-reopen') {
  configure(process.argv[3], false);
  const queue = await import('./codexQueue.js');
  const items = await queue.listCodexQueueItems('developer');
  const binding = await queue.resolveCodexQueueSessionId('draft:persisted-binding');
  await queue.shutdownCodexQueueWorker();
  process.stdout.write(JSON.stringify({ items, binding }));
} else {
  test('actual queue SQLite migration, durable dedupe, mutations and restart preserve history and custody', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-sqlite-queue-integration-'));
    const queueRoot = path.join(root, 'queue');
    await mkdir(queueRoot, { recursive: true });
    configure(root);
    const old = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    const seed = (id: string, status = 'completed', extra = {}) => ({
      id, profileId: 'developer', queueKey: `session-${id}`, sessionId: `session-${id}`,
      cwd: root, prompt: `Original ${id}`, promptPreview: `Original ${id}`, attachments: [], status,
      createdAt: old, updatedAt: old, scheduledAt: old, startedAt: old, completedAt: old,
      finalMessage: status === 'completed' ? `Done ${id}` : null,
      error: status === 'failed' ? `Original failure ${id}` : null,
      attempts: 1, scheduleMode: 'once', ...extra,
    });
    const archive = Array.from({ length: 80 }, (_, index) => seed(`archive-${String(index).padStart(3, '0')}`,
      index % 3 === 0 ? 'failed' : index % 3 === 1 ? 'cancelled' : 'completed'));
    const uncertain = seed('native-uncertain', 'failed', {
      nativeRunId: 'native-uncertain',
      nativeSubmission: { clientUserMessageId: 'code-ai:native-uncertain', queuedSubmissionId: 'queued-uncertain',
        turnId: null, deliveryPhase: 'prepared' },
    });
    const frozenSnapshot = JSON.stringify({ items: [...archive, uncertain], sessionBindings: { legacy: 'session-legacy' } });
    const legacyPath = path.join(queueRoot, 'state.json');
    await writeFile(legacyPath, frozenSnapshot);
    const queue = await import('./codexQueue.js');
    let connection: DatabaseSync | null = null;
    let stopped = false;
    t.after(async () => {
      connection?.close();
      if (!stopped) await queue.shutdownCodexQueueWorker();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    await t.test('startup imports archives older than 21 days and retains exact native submission identity', async () => {
      const items = await queue.listCodexQueueItems('developer');
      assert.equal(items.length, 81);
      assert.ok(items.some(item => item.id === archive[0].id && item.error === archive[0].error));
      assert.deepEqual(items.find(item => item.id === uncertain.id)?.nativeSubmission, uncertain.nativeSubmission);
      assert.equal(await readFile(legacyPath, 'utf8'), frozenSnapshot, 'migration rewrote original JSON evidence');
      connection = new DatabaseSync(path.join(queueRoot, 'queue.sqlite'));
      assert.equal(connection.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(connection.prepare('SELECT count(*) count FROM queue_items').get()?.count, 81);
    });

    await t.test('both concurrent deduped requests wait for the same durable commit before acknowledgement', async () => {
      connection!.exec('BEGIN IMMEDIATE');
      let firstSettled = false;
      let repeatedSettled = false;
      const input = { profileId: 'developer', queueKey: 'draft:concurrent', clientRequestId: 'concurrent-request',
        saveAsDraft: true, prompt: 'Synthetic concurrent durable input' };
      const first = queue.enqueueCodexQueueItem(input).finally(() => { firstSettled = true; });
      const repeated = queue.enqueueCodexQueueItem({ ...input, prompt: 'Retried after an ambiguous response' })
        .finally(() => { repeatedSettled = true; });
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(firstSettled, false);
        assert.equal(repeatedSettled, false, 'dedupe acknowledged an in-memory item before durable persistence');
      } finally {
        connection!.exec('COMMIT');
      }
      const [accepted, deduped] = await Promise.all([first, repeated]);
      assert.equal(accepted.id, deduped.id);
      assert.equal(deduped.prompt, input.prompt);
      const persisted = connection!.prepare("SELECT payload FROM queue_items WHERE json_extract(payload,'$.clientRequestId')=?")
        .all(input.clientRequestId);
      assert.equal(persisted.length, 1);
      assert.equal(JSON.parse(String(persisted[0].payload)).id, accepted.id);
    });

    await t.test('failed commit cannot acknowledge either original or deduped request; safe retry persists one item', async () => {
      connection!.exec(`CREATE TRIGGER refuse_test_input BEFORE INSERT ON queue_items
        WHEN json_extract(NEW.payload,'$.clientRequestId')='synthetic-storage-failure'
        BEGIN SELECT RAISE(ABORT,'synthetic queue storage refusal'); END;`);
      const input = { profileId: 'developer', queueKey: 'draft:storage-failure', clientRequestId: 'synthetic-storage-failure',
        saveAsDraft: true, prompt: 'Synthetic recoverable persistence failure' };
      const results = await Promise.allSettled([queue.enqueueCodexQueueItem(input), queue.enqueueCodexQueueItem(input)]);
      assert.ok(results.every(result => result.status === 'rejected'), 'a failed commit was reported as accepted');
      assert.equal(connection!.prepare("SELECT count(*) count FROM queue_items WHERE json_extract(payload,'$.clientRequestId')=?")
        .get(input.clientRequestId)?.count, 0);
      connection!.exec('DROP TRIGGER refuse_test_input');
      const accepted = await queue.enqueueCodexQueueItem(input);
      assert.equal(connection!.prepare('SELECT id FROM queue_items WHERE id=?').get(accepted.id)?.id, accepted.id);
      assert.equal((await queue.listCodexQueueItems('developer')).filter(item => item.clientRequestId === input.clientRequestId).length, 1);
    });

    let boundItemId: string;
    let deletedItemId: string;
    await t.test('enqueue, session binding and draft deletion update SQLite without changing archived attempts', async () => {
      const bound = await queue.enqueueCodexQueueItem({ profileId: 'developer', queueKey: 'draft:persisted-binding',
        prompt: 'Synthetic scheduled input', scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
      boundItemId = bound.id;
      const rebound = await queue.bindCodexQueueItemToStartedSession(bound.id, 'session-persisted-binding');
      assert.equal(rebound?.queueKey, 'draft:persisted-binding');
      assert.equal(await queue.resolveCodexQueueSessionId('draft:persisted-binding'), 'session-persisted-binding');
      const removable = await queue.enqueueCodexQueueItem({ profileId: 'developer', queueKey: 'draft:deleted',
        saveAsDraft: true, prompt: 'Synthetic unsent draft to remove' });
      deletedItemId = removable.id;
      await queue.deleteCodexQueueItem(removable.id);
      assert.equal(await queue.getCodexQueueItem(removable.id), null);
      assert.equal(connection!.prepare('SELECT id FROM queue_items WHERE id=?').get(removable.id), undefined);
      assert.equal(connection!.prepare('SELECT session_id FROM queue_bindings WHERE key=?')
        .get('draft:persisted-binding')?.session_id, 'session-persisted-binding');
      assert.equal(await readFile(legacyPath, 'utf8'), frozenSnapshot);
      const latestArchived = JSON.parse(String(connection!.prepare('SELECT payload FROM queue_items WHERE id=?').get(archive[0].id)?.payload));
      assert.equal(latestArchived.error, archive[0].error);
      assert.equal(latestArchived.status, archive[0].status);
    });

    await t.test('compact polling bounds terminal history while paginated history and current failure remain available', async () => {
      const compact = await queue.listCodexQueueWorkspaceItems('developer', `session-${archive[0].id}`, { compact: true });
      assert.equal(compact.history?.totalTerminal, 81);
      assert.ok((compact.history?.returnedTerminal || 0) < 81);
      assert.ok(compact.items.some(item => item.id === archive[0].id));
      assert.ok(compact.items.some(item => item.id === uncertain.id), 'uncertain custody was hidden');
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await queue.listCodexQueueHistory('developer', { limit: 13, cursor });
        for (const item of page.items) { assert.equal(ids.has(item.id), false); ids.add(item.id); }
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(ids.size, 81);
    });

    await t.test('fresh process reopens SQLite without opt-in flag, preserving bindings and ignoring frozen JSON', async () => {
      connection!.close(); connection = null;
      await queue.shutdownCodexQueueWorker(); stopped = true;
      // This deliberately stale JSON must not become authoritative on restart.
      await writeFile(legacyPath, JSON.stringify({ items: [seed('stale-after-migration')], sessionBindings: {} }));
      const { stdout } = await execFileAsync(process.execPath, [process.argv[1], '--queue-reopen', root],
        { cwd: process.cwd(), timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      const reopened = JSON.parse(stdout);
      assert.equal(reopened.binding, 'session-persisted-binding');
      assert.ok(reopened.items.some((item: { id: string }) => item.id === boundItemId));
      assert.equal(reopened.items.some((item: { id: string }) => item.id === deletedItemId), false);
      assert.equal(reopened.items.some((item: { id: string }) => item.id === 'stale-after-migration'), false);
      assert.ok(reopened.items.some((item: { id: string }) => item.id === archive[0].id));
      assert.deepEqual(reopened.items.find((item: { id: string }) => item.id === uncertain.id)?.nativeSubmission,
        uncertain.nativeSubmission);
    });
  });
}
