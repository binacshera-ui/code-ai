import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareOwnerStore } from './codexQueueStoreHot.mjs';
import { readCodexQueueStoreSnapshot } from './codexQueueStore.mjs';

test('live handoff waits old barrier, retains raw active closures and acknowledges only durable deltas', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-queue-hot-test-'));
  const legacyFile = path.join(root, 'state.json');
  const at = '2026-10-29T12:00:00.000Z';
  const active = { id: 'active', profileId: 'developer', sessionId: 'one', prompt: 'work',
    status: 'running', createdAt: at, updatedAt: at, nativeSubmission: { clientUserMessageId: 'stable-original-id' } };
  let state = { items: [active], sessionBindings: {} };
  let releaseOld; let tail = new Promise((resolve) => { releaseOld = resolve; });
  let persist; let recovered; let pending = 0;
  const scope = { queueRoot: root, legacyFile, getState: () => state, setState: (next) => { state = next; },
    getActiveIds: () => ['active'], getPersistTail: () => tail, setPersistTail: (next) => { tail = next; },
    replacePersist: (next) => { persist = next; }, onPersistStart: () => { pending += 1; }, onPersistEnd: () => { pending -= 1; },
    replaceRecoveredLoader: (next) => { recovered = next; }, sanitizeRecoveredQueueItem: (item) => item };
  const installation = prepareOwnerStore(scope);
  try {
    assert.equal(prepareOwnerStore(scope), installation);
    active.nativeSubmission.deliveryPhase = 'running';
    let acknowledged = false;
    const write = persist().then(() => { acknowledged = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(acknowledged, false); assert.equal(pending, 1);
    await writeFile(legacyFile, JSON.stringify({ items: [active], sessionBindings: {} }));
    releaseOld(); await installation.ready; await write;
    assert.equal(pending, 0); assert.equal(installation.status().initialized, true);
    assert.equal((await readCodexQueueStoreSnapshot({ queueRoot: root })).items[0].nativeSubmission.deliveryPhase, 'running');
    active.status = 'completed'; active.finalMessage = 'original closure completed successfully';
    await persist();
    assert.equal((await readCodexQueueStoreSnapshot({ queueRoot: root })).items[0].status, 'completed');
    const entries = await recovered({ id: 'developer' });
    assert.equal(entries.get('one').items[0].finalMessage, 'original closure completed successfully');
    assert.equal((await readCodexQueueStoreSnapshot({ queueRoot: root })).items[0].nativeSubmission.clientUserMessageId, 'stable-original-id');
    await Promise.all(Array.from({ length: 100 }, (_, index) => {
      state.items.push({ ...active, id: `draft:${index}`, status: 'draft', sessionId: `draft:${index}` });
      return persist();
    }));
    assert.equal((await readCodexQueueStoreSnapshot({ queueRoot: root })).items.length, 101);
    assert.equal(pending, 0);
    const legacy = JSON.parse(await readFile(legacyFile, 'utf8'));
    assert.equal(legacy.items.length, 1); assert.equal(legacy.items[0].status, 'running');
    const exported = path.join(root, 'explicit-rollback.json'); await installation.rollbackExport(exported);
    assert.equal(JSON.parse(await readFile(exported, 'utf8')).items.length, 101);
  } finally { await installation.close(); await rm(root, { recursive: true, force: true }); }
});
