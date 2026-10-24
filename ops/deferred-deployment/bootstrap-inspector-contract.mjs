import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// Explicitly offline-only feasibility spike. Never accepts a PID, real home,
// credential file or inspector URL from a caller. It starts its own fixture.
const bundles = {
  main: ['/mnt/hdd/code-ai-builds/drafts-panel-live-20261002/dist/server.js',
    '240e9f7e6a5b14a8e0754134cb1b448e051e6580bab0ddafb751bf9a381b07c7'],
  beamAndPci: ['/mnt/hdd/code-ai-builds/draft-unblock-imports-Rslv62/d37ae9ce-e402-4955-b335-f2af6a5d0374/artifact/dist/runtime/main.mjs',
    '4c83ae10e25641a53475312e8cf2e38d0396533bb892b8ce04810b48deaef9e9'],
  ubuntu: ['/mnt/hdd/code-ai-builds/draft-unblock-imports-Rslv62/d37ae9ce-e402-4955-b335-f2af6a5d0374/artifact/dist/runtime/ubuntu.mjs',
    '79d8cd2292b6d420720f0aa5e2976d3d82bea8e22865501ca5a6dbc081c8ed1f'],
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const variant = process.argv[2] || 'main';
assert.ok(Object.hasOwn(bundles, variant), 'Only fixed offline bundle variants are supported');
const [fixedBundlePath, expectedHash] = bundles[variant];
const source = await readFile(fixedBundlePath, 'utf8');
assert.equal(hash(source), expectedHash, 'Exact installed bundle digest changed');
const tickStart = source.lastIndexOf('async function tickWorker');
const selectAt = source.indexOf('const nextItems = pickRunnableItems(availableSlots);', tickStart);
assert.ok(tickStart > 0 && selectAt > tickStart, 'Legacy dispatch breakpoint is absent');
const dispatchLine = source.slice(0, selectAt).split('\n').length - 1;
const heartbeatAt = source.indexOf('heartbeat = setInterval(() => {\n      if (!res.writableEnded && !res.destroyed) {');
assert.ok(heartbeatAt > 0, 'Known read-only SSE heartbeat boundary is absent');
const sseHeartbeatLine = source.slice(0, source.indexOf('if (!res.writableEnded', heartbeatAt)).split('\n').length - 1;
const queueScope = source.slice(source.indexOf('var QUEUE_ROOT = '), tickStart);
const queuePersistName = queueScope.match(/var (persistTail\d*) = Promise\.resolve\(\)/)?.[1];
assert.ok(queuePersistName, 'Legacy queue persistence tail binding is absent');
const allPersistNames = [...new Set([...source.matchAll(/var ((?:persistTail|auditTail|profileMutationTail)\d*) = Promise\.resolve\(\)/g)]
  .map(match => match[1]))];
const temporary = await mkdtemp('/mnt/hdd/code-ai-builds/offline-bootstrap-inspector-');
const bundlePath = path.join(temporary, 'app', 'dist', 'server.js');
const home = path.join(temporary, 'synthetic-home');
const storage = path.join(temporary, 'storage');
const workspace = path.join(temporary, 'workspace');
const profileId = 'bootstrap-synthetic';
const ids = [randomUUID(), randomUUID(), randomUUID()];
let child, socket, chromeSocket, streamReader, closing = false;
let privateLog = '';
let cookie = '';
const devicePassword = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('hex');
const syntheticChromeToken = randomBytes(32).toString('hex');
const syntheticChromeId = randomUUID();
const syntheticCommandId = randomUUID();
const pending = new Map();
const events = new Map();
const waits = new Map();
let requestId = 0;
let inspectorUrl;
let failed = false;
let phase = 'initialization';

async function waitFor(check, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Owned fixture exited');
    const result = await check();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(label);
}

function protocol(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Offline inspector request timed out')); }, 8000);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function nextEvent(method, timeoutMs = 8000) {
  const available = events.get(method) || [];
  if (available.length > 0) return Promise.resolve(available.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Offline inspector event timed out')), timeoutMs);
    const list = waits.get(method) || [];
    list.push(value => { clearTimeout(timer); resolve(value); });
    waits.set(method, list);
  });
}

async function evaluate(expression, callFrameId) {
  const result = await protocol(callFrameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate', {
    ...(callFrameId ? { callFrameId } : { awaitPromise: true }), expression, returnByValue: true, silent: true,
  });
  assert.equal(Boolean(result.exceptionDetails), false, 'Scoped offline inspector evaluation failed');
  return result.result?.value;
}

async function closeKnownReadOnlySse() {
  // Pre-existing response references are not reliably discoverable through
  // Node's private handle list or prototype query. The exact pinned heartbeat
  // closure still holds its original response. Pause before its liveness check
  // so ending the response cannot cause a subsequent write-after-end.
  const breakpoint = await protocol('Debugger.setBreakpointByUrl', {
    url: new URL('file://' + bundlePath).href, lineNumber: sseHeartbeatLine, columnNumber: 0,
  });
  const pause = await nextEvent('Debugger.paused', 20_000);
  try {
    const closed = await evaluate(`(() => {
      const status = globalThis.__codeAiOfflineBootstrap.status();
      if (status.active || status.workers || status.providerChildren || status.terminals
        || status.workerTickInFlight || status.pendingCommands || status.pendingApprovals) return false;
      const route = String(req.originalUrl || req.url || '').split('?')[0];
      if (!/^\\/api\\/codex\\/sessions\\/[^/]+\\/events$/.test(route)
        || !String(res.getHeader('content-type') || '').startsWith('text/event-stream')) return false;
      res.end();
      return true;
    })()`, pause.callFrames[0].callFrameId);
    assert.equal(closed, true, 'Known read-only SSE closure did not satisfy quiescence contract');
  } finally {
    await protocol('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
    await protocol('Debugger.resume');
  }
}

async function request(origin, route, body, expected = 200) {
  const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000) });
  assert.equal(response.status, expected, 'Offline HTTP contract status: ' + route.split('?')[0]
    + ' expected=' + expected + ' actual=' + response.status);
  if (route === '/api/codex/device-unlock') cookie = response.headers.getSetCookie()
    .find(value => value.startsWith('code_ai_device_unlock='))?.split(';', 1)[0] || '';
  return response.json();
}

async function start() {
  for (const directory of [home, storage, workspace, home + '/sessions']) await mkdir(directory, { recursive: true });
  await mkdir(path.dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, source, { mode: 0o600 });
  await writeFile(path.join(temporary, 'app', 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  // The copied module remains byte-for-byte exact. This reuses existing trusted
  // dependencies read-only; no package installation or compilation occurs.
  await symlink('/mnt/hdd/code-ai-builds/drafts-panel-live-20261002/node_modules',
    path.join(temporary, 'app', 'node_modules'));
  await writeFile(home + '/.code-ai-synthetic-fixture', 'synthetic-only\n', { mode: 0o600 });
  const bridgeRoot = storage + '/local/personal-chrome-bridge';
  await mkdir(bridgeRoot, { recursive: true });
  await writeFile(bridgeRoot + '/state.json', JSON.stringify({ version: 1, bindings: [], trustedExtensions: [], devices: [{
    id: syntheticChromeId, ownerId: 'owned-offline-fixture', name: 'Owned offline Chrome fixture',
    tokenHash: hash(syntheticChromeToken), extensionId: null, installationId: null,
    platform: 'synthetic', browserVersion: 'synthetic', capabilities: [], revokedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSeenAt: null,
  }] }), { mode: 0o600 });
  for (const id of ids) {
    await writeFile(home + '/sessions/rollout-offline-' + id + '.jsonl', JSON.stringify({ type: 'session_meta',
      timestamp: new Date().toISOString(), payload: { id, cwd: workspace, source: 'cli', model_provider: 'openai' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
        payload: { type: 'user_message', message: 'Synthetic bootstrap fixture' } }) + '\n', { mode: 0o600 });
  }
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const appRoot = '/mnt/hdd/code-ai-builds/drafts-panel-live-20261002';
  const env = {
    PATH: process.env.PATH || '', HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
    CODEX_APP_ROOT: appRoot, CODEX_STORAGE_ROOT: storage, CODEX_QUEUE_ROOT: storage + '/queue',
    CODEX_LOG_ROOT: storage + '/logs', CODEX_UPLOAD_ROOT: storage + '/uploads', CODEX_WORKSPACE_ROOT: workspace,
    CODEX_ALLOWED_FILE_ROOTS: temporary, CODEX_ALLOW_ANY_PATHS: 'false', CODEX_OPEN_ACCESS: 'true',
    CODEX_PROFILES_JSON: JSON.stringify([{ id: profileId, label: 'Offline fixture', provider: 'codex',
      codexHome: home, workspaceCwd: workspace, defaultProfile: true }]),
    CODEX_PROFILES_JSON_BASE64: '', CODEX_BIN: path.resolve('ops/codex-interactive-release/fake-codex.mjs'),
    CODEX_DEVICE_ADMIN_PASSWORD: devicePassword, SESSION_SECRET: secret, SESSION_COOKIE_DOMAIN: '', DATABASE_URL: '',
    CODEX_REMOTE_AGENT_TOKEN: '', CODEX_REMOTE_HOSTS_FILE: storage + '/no-remotes.json',
    CODEX_CLI_AUTO_UPDATE: 'false', CODEX_NTFY_ENABLED: 'false', CODEX_NTFY_DEFAULT_ENABLED: 'false',
    CODEX_NTFY_URL: '', CODEX_QUEUE_DISABLE_EXECUTION: '0', CODE_AI_PASSIVE_HTTP_NODE: '0',
  };
  child = spawn(process.execPath, ['--inspect=127.0.0.1:0', bundlePath], {
    cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const collect = chunk => {
    privateLog = (privateLog + chunk).slice(-16_000);
    inspectorUrl ||= privateLog.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)?.[0];
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  await waitFor(() => inspectorUrl, 'Private inspector did not start');
  socket = new WebSocket(inspectorUrl);
  await once(socket, 'open');
  socket.addEventListener('message', message => {
    const body = JSON.parse(message.data);
    if (body.id) {
      const holder = pending.get(body.id);
      if (!holder) return;
      pending.delete(body.id); clearTimeout(holder.timer);
      if (body.error) holder.reject(new Error('Offline inspector protocol rejected ' + holder.method + ': code=' + body.error.code + ' phase=' + phase));
      else holder.resolve(body.result);
    } else if (body.method === 'Debugger.paused') {
      const list = waits.get(body.method) || [];
      if (list.length) list.shift()(body.params);
      else { const queue = events.get(body.method) || []; queue.push(body.params); events.set(body.method, queue); }
    }
  });
  await protocol('Runtime.enable'); await protocol('Debugger.enable');
  const origin = 'http://127.0.0.1:' + port;
  await waitFor(async () => {
    try { return await request(origin, '/api/auth/check-session'); } catch { return false; }
  }, 'Owned offline HTTP fixture did not start');
  await request(origin, '/api/codex/device-unlock', { password: devicePassword });
  assert.ok(cookie, 'Synthetic authentication was not issued');
  return origin;
}

async function pauseDispatch() {
  const breakpoint = await protocol('Debugger.setBreakpointByUrl', {
    url: new URL('file://' + bundlePath).href, lineNumber: dispatchLine, columnNumber: 0,
  });
  const pause = await nextEvent('Debugger.paused');
  assert.ok(pause.callFrames[0].functionName.startsWith('tickWorker'), 'Breakpoint hit a foreign fixture scope');
  await protocol('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
  return pause.callFrames[0].callFrameId;
}

async function stop() {
  closing = true;
  try { if (socket?.readyState === WebSocket.OPEN) await protocol('Debugger.resume'); } catch {}
  socket?.close();
  chromeSocket?.close();
  await streamReader?.cancel().catch(() => {});
  for (const holder of pending.values()) clearTimeout(holder.timer);
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    let timer;
    await Promise.race([closed, new Promise(resolve => {
      timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 3000);
    })]); clearTimeout(timer);
  }
  cookie = ''; privateLog = '';
  await rm(temporary, { recursive: true, force: true });
}

try {
  const origin = await start();
  phase = 'provider-fixture';
  const frame = await pauseDispatch();
  const initial = await evaluate(`(() => {
    const originalPick = pickRunnableItems, originalRun = runAgentPrompt;
    const fixture = { active: 0, starts: 0, directBlocked: 0, phase: 'open', releaseFirst: null,
      holdNext: false, releaseDirect: null, httpClosed: false,
      ownedKeepalive: setInterval(() => {}, 30_000) };
    let first = true;
    const fakeRun = async (...args) => {
      fixture.active++; fixture.starts++;
      try {
        if (first) { first = false; await new Promise(resolve => { fixture.releaseFirst = resolve; }); }
        else if (fixture.holdNext) { fixture.holdNext = false; await new Promise(resolve => { fixture.releaseDirect = resolve; }); }
        return { sessionId: args[1], finalMessage: 'SYNTHETIC_BOOTSTRAP_COMPLETED', entryId: null };
      } finally { fixture.active--; }
    };
    runAgentPrompt = fakeRun;
    fixture.fence = () => {
      workerStopping = true;
      pickRunnableItems = () => [];
      runAgentPrompt = async () => { fixture.directBlocked++; throw new Error('Offline deployment admission fenced'); };
    };
    fixture.status = () => ({ active: fixture.active, starts: fixture.starts, directBlocked: fixture.directBlocked,
      workers: activeWorkerPromises.size, providerChildren: activeCodexRuns.size + activeClaudeRuns.size + activeGeminiRuns.size,
      terminals: [...terminals.values()].filter(t => t.exitedAt === null).length,
      workerStopping, selectable: pickRunnableItems(20).length, httpClosed: fixture.httpClosed,
      workerTickInFlight, pendingCommands: pendingCommands.size, pendingApprovals: pendingApprovals.size,
      chromeConnections: deviceConnections.size, upgradedSockets: socketServer?.clients.size || 0,
      chromeCommandCompleted: fixture.chromeCommandCompleted === true });
    fixture.closeHttp = () => { server.close(() => { fixture.httpClosed = true; }); return server.listening; };
    fixture.persist = () => Promise.all([${allPersistNames.join(', ')}]);
    fixture.pendingChrome = () => new Promise(resolve => {
      pendingCommands.set(${JSON.stringify(syntheticCommandId)}, {
        deviceId: ${JSON.stringify(syntheticChromeId)}, timer: setTimeout(() => {}, 60_000),
        resolve: () => { fixture.chromeCommandCompleted = true; resolve(true); },
        reject: () => { fixture.chromeCommandCancelled = true; resolve(false); },
      });
    });
    fixture.finishOwnedTerminal = id => {
      const record = terminals.get(id);
      if (!record || record.cwd !== ${JSON.stringify(workspace)}) throw new Error('Foreign terminal is forbidden in offline fixture');
      record.process.write('exit\\r');
      return true;
    };
    fixture.closeIdleStreams = () => {
      const status = fixture.status();
      if (status.active || status.workers || status.providerChildren || status.terminals
        || status.workerTickInFlight || status.pendingCommands || status.pendingApprovals
        || !status.httpClosed) return { refused: true };
      for (const ws of socketServer?.clients || []) ws.close(1001, 'Owned offline sealed bootstrap');
      return { refused: false, chromeCommandCancelled: fixture.chromeCommandCancelled === true };
    };
    fixture.resume = () => { workerStopping = false; pickRunnableItems = originalPick; runAgentPrompt = fakeRun; };
    fixture.restore = () => { workerStopping = false; pickRunnableItems = originalPick; runAgentPrompt = originalRun;
      clearInterval(fixture.ownedKeepalive); };
    globalThis.__codeAiOfflineBootstrap = fixture;
    return fixture.status();
  })()`, frame);
  assert.equal(initial.active, 0);
  await protocol('Debugger.resume');
  const enqueue = (id, scheduledAt) => request(origin, '/api/codex/queue/items', {
    profileId, cwd: workspace, sessionId: id, queueKey: id, clientRequestId: randomUUID(),
    prompt: 'Synthetic bootstrap only', ...(scheduledAt ? { scheduledAt } : {}),
  }, 202);
  const first = await enqueue(ids[0]);
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).active === 1,
    'Synthetic pre-fence task did not enter');
  const activeFrame = await pauseDispatch();
  const fenced = await evaluate(`(() => { globalThis.__codeAiOfflineBootstrap.fence(); return globalThis.__codeAiOfflineBootstrap.status(); })()`, activeFrame);
  assert.equal(fenced.workerStopping, true); assert.equal(fenced.selectable, 0); assert.equal(fenced.active, 1);
  await protocol('Debugger.resume');
  const next = await enqueue(ids[1]);
  const future = await enqueue(ids[2], new Date(Date.now() + 100).toISOString());
  await request(origin, '/api/codex/ask', { profileId, sessionId: ids[1], cwd: workspace,
    prompt: 'Synthetic direct request', async: false }, 500);
  await evaluate('globalThis.__codeAiOfflineBootstrap.releaseFirst(); true');
  const item = async id => (await request(origin, '/api/codex/queue/items/' + id + '?includeSession=false')).item;
  await waitFor(async () => (await item(first.item.id)).status === 'completed', 'Pre-fence task was not preserved');
  await sleep(1700);
  assert.equal((await item(next.item.id)).status, 'queued');
  assert.equal((await item(future.item.id)).status, 'queued');
  const drained = await evaluate('globalThis.__codeAiOfflineBootstrap.status()');
  assert.equal(drained.workers, 0); assert.equal(drained.active, 0); assert.equal(drained.starts, 1);
  assert.equal(drained.directBlocked, 1);
  await evaluate('globalThis.__codeAiOfflineBootstrap.resume(); true');
  await waitFor(async () => (await item(next.item.id)).status === 'completed'
    && (await item(future.item.id)).status === 'completed', 'Preserved queued tasks did not resume');
  const resumed = await evaluate('globalThis.__codeAiOfflineBootstrap.status()');
  assert.equal(resumed.starts, 3);
  phase = 'stream-and-terminal-fixtures';
  const stream = await fetch(origin + '/api/codex/sessions/' + ids[0] + '/events?profile=' + profileId,
    { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
  assert.equal(stream.status, 200, 'Synthetic SSE fixture did not start');
  streamReader = stream.body.getReader();
  await streamReader.read();
  chromeSocket = new WebSocket(origin.replace('http:', 'ws:') + '/api/codex/browser-extension/socket');
  await once(chromeSocket, 'open');
  const authenticated = new Promise((resolve, reject) => {
    chromeSocket.addEventListener('message', message => {
      const body = JSON.parse(message.data);
      if (body.type === 'auth_ok') resolve(true);
    });
    chromeSocket.addEventListener('close', () => reject(new Error('Owned offline Chrome fixture authentication failed')), { once: true });
  });
  chromeSocket.send(JSON.stringify({ type: 'auth', version: 1, deviceId: syntheticChromeId, token: syntheticChromeToken }));
  assert.equal(await authenticated, true);
  // The fixture creates the same pending command shape as the old bridge, then
  // completes it via its actual authenticated result handler, never cancellation.
  await evaluate('globalThis.__codeAiOfflineBootstrap.pendingChrome(); true');
  const terminal = await request(origin, '/api/codex/terminal/sessions', { profileId, cwd: workspace }, 201);
  assert.equal((await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).terminals, 1,
    'Owned real PTY fixture is not active');
  const futureSaved = await enqueue(ids[1], new Date(Date.now() + 86_400_000).toISOString());
  phase = 'accepted-direct-http';
  // An already-accepted direct HTTP call has no legacy durable start marker.
  // HTTP close conservatively waits the entire request, including postprocessing.
  await evaluate('globalThis.__codeAiOfflineBootstrap.holdNext = true; true');
  const directResponse = request(origin, '/api/codex/ask', { profileId, sessionId: ids[0], cwd: workspace,
    prompt: 'Synthetic accepted direct HTTP drain', async: false });
  directResponse.catch(() => {});
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).active === 1,
    'Accepted direct fixture request did not enter');
  const httpFrame = await pauseDispatch();
  phase = 'http-close-fence';
  const closedListener = await evaluate(`(() => { globalThis.__codeAiOfflineBootstrap.fence();
    return globalThis.__codeAiOfflineBootstrap.closeHttp(); })()`, httpFrame);
  assert.equal(closedListener, false);
  await protocol('Debugger.resume');
  phase = 'http-close-wait';
  assert.equal((await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).httpClosed, false,
    'HTTP close did not wait the accepted direct request');
  assert.equal((await evaluate('globalThis.__codeAiOfflineBootstrap.closeIdleStreams()')).refused, true,
    'Streams closed while provider, command or PTY fixture was active');
  await assert.rejects(() => fetch(origin + '/api/auth/check-session', { signal: AbortSignal.timeout(1000) }),
    'Closing listener accepted a new HTTP request');
  await evaluate('globalThis.__codeAiOfflineBootstrap.releaseDirect(); true');
  phase = 'direct-response';
  await directResponse;
  phase = 'pending-chrome-and-pty-boundary';
  assert.equal((await evaluate('globalThis.__codeAiOfflineBootstrap.closeIdleStreams()')).refused, true,
    'Streams closed before pending Chrome command and PTY completed');
  chromeSocket.send(JSON.stringify({ type: 'result', version: 1, commandId: syntheticCommandId, ok: true,
    result: { ownedSyntheticFixture: true } }));
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).chromeCommandCompleted,
    'Existing Chrome command did not complete normally');
  assert.equal((await evaluate('globalThis.__codeAiOfflineBootstrap.closeIdleStreams()')).refused, true,
    'A still-active real PTY did not block stream close');
  await evaluate('globalThis.__codeAiOfflineBootstrap.finishOwnedTerminal(' + JSON.stringify(terminal.terminal.id) + '); true');
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).terminals === 0,
    'The owned real PTY did not exit normally');
  phase = 'idle-stream-close';
  await closeKnownReadOnlySse();
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).httpClosed,
    'Existing HTTP requests did not settle after read-only SSE close');
  const chromeClosed = once(chromeSocket, 'close');
  const closedStreams = await evaluate('globalThis.__codeAiOfflineBootstrap.closeIdleStreams()');
  assert.equal(closedStreams.refused, false);
  assert.equal(closedStreams.chromeCommandCancelled, false, 'Existing Chrome command was cancelled');
  await chromeClosed;
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).chromeConnections === 0,
    'Idle Chrome connection did not close');
  while (!(await streamReader.read()).done) {}
  await waitFor(async () => (await evaluate('globalThis.__codeAiOfflineBootstrap.status()')).httpClosed,
    'Accepted direct HTTP postprocessing did not finish');
  phase = 'persistence-settlement';
  assert.equal(await evaluate('globalThis.__codeAiOfflineBootstrap.persist().then(() => true)'), true);
  const persisted = JSON.parse(await readFile(storage + '/queue/state.json', 'utf8'));
  assert.equal(persisted.items.find(entry => entry.id === futureSaved.item.id).status, 'scheduled',
    'The future scheduled item changed during stream/terminal drain');
  await evaluate('globalThis.__codeAiOfflineBootstrap.restore(); delete globalThis.__codeAiOfflineBootstrap; true');
  console.log(JSON.stringify({ format: 'code-ai-offline-legacy-bootstrap-feasibility', version: 1,
    variant, serverSha256: expectedHash, inspectedOnlyOwnedSyntheticProcess: true, installedEffects: false,
    lexicalMutationSupported: true, inFlightTickSelectorFenced: true, preFenceSyntheticJobCompleted: true,
    persistedNewQueueItemPreserved: true, dueScheduledItemPreserved: true, directNewRequestBlocked: true,
    resumedJobsCompletedExactlyOnce: true, realModelTurns: 0, liveCredentialsRead: false,
    acceptedDirectHttpCompletedBeforeClose: true, noNewHttpAcceptedAfterClose: true, queuePersistenceSettled: true,
    requiresOwnedKeepaliveThroughSeal: true,
    existingSyntheticSseHeartbeatClosedOnlyAfterQuiescence: true,
    authenticatedChromeCommandCompletedWithoutCancellation: true,
    idleAuthenticatedUpgradedSocketClosedAfterQuiescence: true,
    realOwnedPtyBlockedSealUntilNaturalExit: true,
    allDiscoveredPersistenceTailsSettled: true, futureSchedulePreserved: true,
    productionBootstrapQualified: false,
    unproven: ['All real existing SSE/WebSocket/bridge routes and external invocations are within the demonstrated census',
      'Preservation/retry of unaccepted synchronous HTTP submissions during the availability window',
      'Retrospective census of legacy handlers already aborted by their HTTP clients',
      'Native desktop/IDE migration (not part of this core release)', 'Live inspector activation/security/isolation',
      'Windows and each host native Node/runtime qualification', 'Atomic store handoff and rollback'] }));
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ format: 'code-ai-offline-legacy-bootstrap-feasibility', version: 1,
    variant, passed: false, installedEffects: false, productionBootstrapQualified: false,
    code: error.code || 'OFFLINE_CONTRACT_FAILED', phase,
    message: String(error.message || 'Offline contract failed').split('\n')[0] }));
} finally {
  await stop();
}
if (failed) process.exitCode = 1;
