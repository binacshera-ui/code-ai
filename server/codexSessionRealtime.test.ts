import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('session detail cache is reusable and live subscription invalidates it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-session-live-'));
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  const storage = path.join(root, 'storage');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '07');
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const sessionPath = path.join(sessionDir, `rollout-2026-08-07T10-00-00-${sessionId}.jsonl`);

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(sessionPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-07T10:00:00.000Z',
      payload: {
        id: sessionId,
        forked_from_id: 'source-session-for-incremental-cache',
        timestamp: '2026-08-07T10:00:00.000Z',
        cwd: workspace,
        source: 'cli',
        model_provider: 'openai',
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:00:01.000Z', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:00:02.000Z', payload: { type: 'user_message', message: 'Initial prompt' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:00:03.000Z', payload: { type: 'agent_message', phase: 'final', message: 'Initial answer' } }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-08-07T10:00:03.100Z',
      payload: {
        type: 'custom_tool_call',
        name: 'structured_tool',
        call_id: 'structured-call',
        input: { command: 'inspect', options: ['full', 'readable'] },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-08-07T10:00:03.200Z',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'structured-call',
        output: [{ type: 'text', text: 'visible structured output' }, { tokens: 42 }],
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:00:04.000Z', payload: { type: 'task_complete', last_agent_message: 'Initial answer' } }),
    '',
  ].join('\n'), 'utf-8');
  await fs.writeFile(
    path.join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: sessionId, thread_name: 'Realtime test' })}\n`,
    'utf-8'
  );

  process.env.CODEX_APP_ROOT = root;
  process.env.CODEX_STORAGE_ROOT = storage;
  process.env.CODEX_SESSION_CATALOG_CACHE_TTL_MS = '250';
  process.env.CODEX_PROFILES_JSON = JSON.stringify([{
    id: 'test-codex',
    label: 'Test Codex',
    provider: 'codex',
    codexHome,
    workspaceCwd: workspace,
    defaultProfile: true,
  }]);

  const service = await import('./codexService.js');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 120 });
  assert.equal(first.timeline.some((entry) => entry.text === 'Initial answer'), true);
  const structuredTool = first.timeline.find((entry) => entry.toolName === 'structured_tool');
  assert.ok(structuredTool, 'structured tool call was parsed');
  assert.match(structuredTool.toolInputText || '', /"command": "inspect"/);
  assert.match(structuredTool.toolOutputText || '', /"text": "visible structured output"/);
  assert.equal(structuredTool.toolOutputText?.includes('[object Object]'), false);
  assert.equal(structuredTool.toolOutputLanguage, 'json');

  const firstCatalog = await service.listCodexSessions('test-codex');
  assert.equal(firstCatalog.some((session) => session.id === sessionId), true);
  const warmCatalogStartedAt = performance.now();
  const warmCatalog = await service.listCodexSessions('test-codex');
  const warmCatalogDurationMs = performance.now() - warmCatalogStartedAt;
  assert.deepEqual(warmCatalog, firstCatalog);
  assert.ok(
    warmCatalogDurationMs < 100,
    `expected a warm catalog read under 100ms, got ${warmCatalogDurationMs.toFixed(1)}ms`
  );

  const catalogCachePath = path.join(
    storage,
    'session-catalog-cache',
    'v1',
    'test-codex.json'
  );
  assert.equal(await fs.stat(catalogCachePath).then(() => true).catch(() => false), true);

  const warmStartedAt = performance.now();
  const warm = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 120 });
  const warmDurationMs = performance.now() - warmStartedAt;
  assert.deepEqual(warm, first);
  assert.ok(warmDurationMs < 100, `expected a warm detail read under 100ms, got ${warmDurationMs.toFixed(1)}ms`);

  const persistedCacheDirectory = path.join(
    storage,
    'session-read-cache',
    'v2',
    'test-codex',
    sessionId
  );
  const persistedCachePath = path.join(persistedCacheDirectory, 'tail-120-before-latest.json');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await fs.stat(persistedCachePath).then(() => true).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const cacheFileMode = (await fs.stat(persistedCachePath)).mode & 0o777;
  const cacheDirectoryMode = (await fs.stat(persistedCacheDirectory)).mode & 0o777;
  assert.equal(cacheFileMode, 0o600);
  assert.equal(cacheDirectoryMode, 0o700);

  const secondSessionId = '99999999-8888-4777-8666-555555555555';
  const secondSessionPath = path.join(sessionDir, `rollout-2026-08-07T10-02-00-${secondSessionId}.jsonl`);
  await fs.writeFile(secondSessionPath, [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-07T10:02:00.000Z',
      payload: {
        id: secondSessionId,
        timestamp: '2026-08-07T10:02:00.000Z',
        cwd: workspace,
        source: 'cli',
        model_provider: 'openai',
      },
    }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:02:01.000Z', payload: { type: 'user_message', message: 'New session' } }),
    '',
  ].join('\n'), 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const staleReadStartedAt = performance.now();
  await service.listCodexSessions('test-codex');
  const staleReadDurationMs = performance.now() - staleReadStartedAt;
  assert.ok(
    staleReadDurationMs < 100,
    `expected stale-while-revalidate catalog read under 100ms, got ${staleReadDurationMs.toFixed(1)}ms`
  );
  let refreshedCatalog = await service.listCodexSessions('test-codex');
  for (let attempt = 0; attempt < 100 && !refreshedCatalog.some((session) => session.id === secondSessionId); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    refreshedCatalog = await service.listCodexSessions('test-codex');
  }
  assert.equal(refreshedCatalog.some((session) => session.id === secondSessionId), true);

  let resolveChange!: (revision: { sessionId: string; size: number }) => void;
  let rejectChange!: (error: Error) => void;
  const changePromise = new Promise<{ sessionId: string; size: number }>((resolve, reject) => {
    resolveChange = resolve;
    rejectChange = reject;
  });
  const changeTimeout = setTimeout(() => rejectChange(new Error('live session change was not emitted')), 2_000);
  const changeSubscription = await service.subscribeCodexSessionChanges(sessionId, 'test-codex', (revision) => {
    clearTimeout(changeTimeout);
    resolveChange(revision);
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.appendFile(sessionPath, [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:01:00.000Z', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:01:01.000Z', payload: { type: 'user_message', message: 'Live prompt' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-07T10:01:02.000Z', payload: { type: 'agent_message', phase: 'commentary', message: 'Live answer' } }),
    '',
  ].join('\n'), 'utf-8');

  const revision = await changePromise;
  changeSubscription.close();
  assert.equal(revision.sessionId, sessionId);
  assert.ok(revision.size > 0);

  const incrementalStartedAt = performance.now();
  const refreshed = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 120 });
  const incrementalDurationMs = performance.now() - incrementalStartedAt;
  assert.equal(refreshed.timeline.some((entry) => entry.text === 'Live answer'), true);
  assert.ok(refreshed.totalTimelineEntries > first.totalTimelineEntries);
  assert.ok(
    incrementalDurationMs < 100,
    `expected an append-only refresh under 100ms, got ${incrementalDurationMs.toFixed(1)}ms`
  );

  const fullParseControl = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 121 });
  assert.equal(refreshed.totalTimelineEntries, fullParseControl.totalTimelineEntries);
  assert.equal(refreshed.messageCount, fullParseControl.messageCount);
  assert.deepEqual(refreshed.timeline, fullParseControl.timeline.slice(-120));

  const splitLine = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-07T10:01:03.000Z',
    payload: { type: 'agent_message', phase: 'commentary', message: 'Split write answer' },
  });
  const splitPoint = Math.floor(splitLine.length / 2);
  const sizeBeforeSplitWrite = (await fs.stat(sessionPath)).size;
  const expectedFinalSize = sizeBeforeSplitWrite + Buffer.byteLength(`${splitLine}\n`);
  const splitWriteStartedAt = performance.now();
  let resolveSplitRevision!: (revision: { sessionId: string; size: number }) => void;
  let rejectSplitRevision!: (error: Error) => void;
  const finalSplitRevision = new Promise<{ sessionId: string; size: number }>((resolve, reject) => {
    resolveSplitRevision = resolve;
    rejectSplitRevision = reject;
  });
  const splitTimeout = setTimeout(() => {
    rejectSplitRevision(new Error('final split-write revision was not emitted promptly'));
  }, 500);
  const splitSubscription = await service.subscribeCodexSessionChanges(sessionId, 'test-codex', (nextRevision) => {
    if (nextRevision.size >= expectedFinalSize) {
      clearTimeout(splitTimeout);
      resolveSplitRevision(nextRevision);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.appendFile(sessionPath, splitLine.slice(0, splitPoint), 'utf-8');
  await new Promise((resolve) => setTimeout(resolve, 8));
  await fs.appendFile(sessionPath, `${splitLine.slice(splitPoint)}\n`, 'utf-8');
  await finalSplitRevision;
  splitSubscription.close();
  const splitWriteLatencyMs = performance.now() - splitWriteStartedAt - 30;
  assert.ok(
    splitWriteLatencyMs < 200,
    `expected the final split-write revision without the 1s fallback, got ${splitWriteLatencyMs.toFixed(1)}ms`
  );

  const splitRefreshed = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 120 });
  assert.equal(splitRefreshed.timeline.some((entry) => entry.text === 'Split write answer'), true);

  const boundedRows = Array.from({ length: 1_000 }, (_, index) => JSON.stringify({
    type: 'event_msg',
    timestamp: `2026-08-07T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    payload: { type: 'agent_message', phase: 'commentary', message: `bounded-${index}` },
  }));
  await fs.appendFile(sessionPath, `${boundedRows.join('\n')}\n`, 'utf-8');
  const bounded = await service.getCodexSessionDetail(sessionId, 'test-codex', { tail: 5 });
  assert.equal(bounded.timeline.length, 5);
  assert.equal(bounded.timeline.at(-1)?.text, 'bounded-999');
  assert.equal(bounded.timeline[0]?.text, 'bounded-995');
  assert.equal(bounded.startPreview, 'Initial prompt');
  assert.equal(bounded.totalTimelineEntries, splitRefreshed.totalTimelineEntries + 1_000);
  assert.equal(bounded.messageCount, splitRefreshed.messageCount + 1_000);
});
