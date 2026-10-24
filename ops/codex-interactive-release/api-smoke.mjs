import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_FAKE_CODEX = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Isolated real Code AI HTTP/queue host. Credentials stay in this object only. */
export async function createInteractiveFixture(compiledServerPath, fakeCodex = DEFAULT_FAKE_CODEX, { timeoutMs = 55_000 } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'code-ai-interactive-api-'));
  const storage = path.join(temporary, 'storage');
  const home = path.join(temporary, 'synthetic-home');
  const otherHome = path.join(temporary, 'other-synthetic-home');
  const cwd = path.join(temporary, 'workspace');
  const appRoot = path.resolve(path.dirname(compiledServerPath), '..');
  const profileId = 'interactive-fixture';
  const otherProfileId = 'other-fixture';
  const devicePassword = randomBytes(32).toString('hex');
  const sessionKey = randomBytes(32).toString('hex');
  for (const directory of [storage, home, otherHome, cwd, path.join(cwd, 'demo', 'nested')]) await mkdir(directory, { recursive: true });
  for (const providerHome of [home, otherHome]) {
    await mkdir(path.join(providerHome, 'sessions'));
    await writeFile(path.join(providerHome, '.code-ai-synthetic-fixture'), 'synthetic-only\n', { mode: 0o600 });
  }
  await chmod(fakeCodex, 0o755);
  const assets = {
    html: path.join(cwd, 'demo', 'index.html'),
    css: path.join(cwd, 'demo', 'nested', 'style.css'),
    js: path.join(cwd, 'demo', 'nested', 'control.js'),
    png: path.join(cwd, 'demo', 'nested', 'pixel.png'),
    huge: path.join(cwd, 'demo', 'huge.bin'),
    outside: path.join(cwd, 'outside.txt'),
  };
  await writeFile(assets.html, `<!doctype html><html dir="rtl"><head><link rel="stylesheet" href="nested/style.css"></head><body><h1 id="fixture">Preview fixture</h1><img src="nested/pixel.png"><button id="qa-button">בדיקת אינטראקטיביות</button><output id="qa-result"></output><script src="nested/control.js"></script><script>document.body.dataset.executed="yes"; window.addEventListener('load',()=>parent.postMessage({fixturePreview:'loaded',color:getComputedStyle(document.getElementById('fixture')).color,imageLoaded:document.querySelector('img').naturalWidth>0,externalScriptLoaded:window.__fixtureExternalScript===true},'*')); document.getElementById('qa-button').onclick=()=>{document.getElementById('qa-result').textContent='הכפתור עובד';parent.postMessage({fixturePreview:'clicked'},'*')};</script></body></html>`);
  await writeFile(assets.css, '@import "./imported.css";\n#fixture { color: rgb(17, 34, 51); background-image: url("./pixel.png"); }\n');
  await writeFile(path.join(cwd, 'demo', 'nested', 'imported.css'), '#fixture { font-style: italic; }\n');
  await writeFile(assets.js, 'window.__fixtureExternalScript = true;\n');
  await writeFile(assets.png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0N8AAAAASUVORK5CYII=', 'base64'));
  await writeFile(assets.outside, 'Outside preview namespace sentinel\n');
  const huge = await open(assets.huge, 'w');
  await huge.truncate(100 * 1024 * 1024 + 1);
  await huge.close();
  await symlink(assets.outside, path.join(cwd, 'demo', 'escaped-link.txt'));

  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let child;
  let childClosed = false;
  let cookie = '';
  let stopped = false;
  let diagnostic = '';

  // Deliberately do not spread process.env: no real home, accounts, tokens or database.
  const env = {
    PATH: process.env.PATH || '', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
    CODEX_APP_ROOT: appRoot, CODEX_WORKSPACE_ROOT: cwd, CODEX_STORAGE_ROOT: storage,
    CODEX_UPLOAD_ROOT: path.join(storage, 'uploads'), CODEX_QUEUE_ROOT: path.join(storage, 'queue'),
    CODEX_LOG_ROOT: path.join(storage, 'logs'), CODEX_ALLOWED_FILE_ROOTS: temporary,
    CODEX_ALLOW_ANY_PATHS: 'false', CODEX_OPEN_ACCESS: 'true', CODEX_BIN: path.resolve(fakeCodex),
    CODEX_PROFILES_JSON: JSON.stringify([
      { id: profileId, label: 'Interactive fixture', provider: 'codex', codexHome: home, workspaceCwd: cwd, defaultProfile: true },
      { id: otherProfileId, label: 'Other fixture', provider: 'codex', codexHome: otherHome, workspaceCwd: cwd },
    ]),
    CODEX_PROFILES_JSON_BASE64: '', CODEX_DEVICE_ADMIN_PASSWORD: devicePassword, SESSION_SECRET: sessionKey,
    DATABASE_URL: '', CODEX_REMOTE_AGENT_TOKEN: '', SESSION_COOKIE_DOMAIN: '',
    CODEX_REMOTE_HOSTS_FILE: path.join(storage, 'no-remotes.json'), CODEX_CLI_AUTO_UPDATE: 'false',
    CODEX_NTFY_ENABLED: 'false', CODEX_NTFY_DEFAULT_ENABLED: 'false', CODEX_NTFY_URL: '',
    CODEX_QUEUE_DISABLE_EXECUTION: '0', CODE_AI_PASSIVE_HTTP_NODE: '0',
  };

  function remaining() {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error('Isolated interactive smoke exceeded its time limit');
    return milliseconds;
  }

  async function fetchRoute(route, { method = 'GET', body, authenticated = true, expected = 200 } = {}) {
    const response = await fetch(origin + route, {
      method, headers: { 'content-type': 'application/json', ...(authenticated && cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(Math.min(5_000, remaining())),
    });
    assert.equal(response.status, expected, `${method} ${route.split('?')[0]} returned an unexpected status`);
    return response;
  }

  async function request(route, method = 'GET', body, expected = 200, authenticated = true) {
    const response = await fetchRoute(route, { method, body, expected, authenticated });
    assert.match(response.headers.get('content-type') || '', /application\/json/, 'API returned an HTML/SPA fallback');
    if (route === '/api/codex/device-unlock' && expected === 200) {
      const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
      const unlock = cookies.find(value => value.startsWith('code_ai_device_unlock='));
      assert.ok(unlock, 'Fixture authentication did not issue the device cookie');
      cookie = unlock.split(';', 1)[0];
    }
    return response.json();
  }

  async function poll(check) {
    while (remaining() > 0) {
      if (child && child.exitCode !== null) throw new Error('Isolated Code AI backend exited unexpectedly');
      const result = await check();
      if (result) return result;
      await sleep(75);
    }
    throw new Error('Isolated interactive smoke timed out');
  }

  async function start(readinessRoute = '/api/auth/check-session') {
    if (child) throw new Error('Fixture has already started');
    child = spawn(process.execPath, [path.resolve(compiledServerPath)], {
      cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    child.once('close', () => { childClosed = true; });
    const appendDiagnostic = chunk => { diagnostic = (diagnostic + chunk).slice(-8_000); };
    child.stdout.on('data', appendDiagnostic);
    child.stderr.on('data', appendDiagnostic);
    await poll(async () => {
      try { return await request(readinessRoute); }
      catch (error) { if (child.exitCode !== null) throw error; return false; }
    });
  }

  async function restart(seal) {
    // Only the owned synthetic backend may be replaced, and only with its
    // actual persisted seal. This helper is NOT a production bootstrap adapter.
    assert.ok(child && !childClosed && !stopped, 'Synthetic backend must be running');
    const marker = await readFile(path.join(home, '.code-ai-synthetic-fixture'), 'utf8');
    assert.equal(marker, 'synthetic-only\n', 'Refusing to restart an unmarked backend');
    const leaseFile = path.join(storage, 'queue', 'deployment-drain', 'lease.json');
    const lease = JSON.parse(await readFile(leaseFile, 'utf8'));
    assert.ok(seal?.httpIngressDrainProven && seal.drained && seal.phase === 'sealed',
      'Synthetic replacement requires complete sealed admission');
    assert.equal(seal.runtimePid, child.pid, 'Seal must belong to this owned backend');
    for (const key of ['runtimeEpoch', 'generation', 'ownerToken', 'sealId']) {
      assert.equal(seal[key], lease[key], 'Synthetic seal binding changed');
    }
    assert.ok(lease.expiresAt - Date.now() > 10_000, 'Synthetic seal must cover the complete restart budget');
    const oldChild = child;
    const closed = once(oldChild, 'close');
    oldChild.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned sealed backend did not stop gracefully')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(oldChild.exitCode, 0, 'Owned sealed backend must exit normally');
    child = undefined;
    childClosed = false;
    // Keep the exact synthetic env, port, state and cookie. No unlock, key
    // generation or conversation replay happens during this handoff.
    await start('/api/codex/remote-agent/health');
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child && !childClosed) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      let timer;
      await Promise.race([closed, new Promise(resolve => {
        timer = setTimeout(() => {
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {}
          resolve();
        }, 3_000);
      })]);
      clearTimeout(timer);
    }
    diagnostic = '';
    cookie = '';
    await rm(temporary, { recursive: true, force: true });
  }

  const fixture = { origin, port, profileId, otherProfileId, cwd, home, storage, assets,
    start, restart, stop, request, fetchRoute, poll };
  // Browser/gateway callers can read these; accidental logging/spreading cannot.
  Object.defineProperties(fixture, {
    cookie: { get: () => cookie, enumerable: false },
    devicePassword: { value: devicePassword, enumerable: false },
  });
  return fixture;
}

export async function runInteractiveApiSmoke(fixture) {
  const { profileId, otherProfileId, assets } = fixture;
  const checks = [];
  const token = Buffer.from(assets.html).toString('base64url');
  const assetRoute = file => `/api/codex/files/asset/local/${token}/${file}`;
  await fixture.request(`/api/codex/files/content?path=${encodeURIComponent(assets.html)}`, 'GET', undefined, 403, false);
  await fixture.request(assetRoute('nested/style.css'), 'GET', undefined, 403, false);
  await fixture.request('/api/codex/device-unlock', 'POST', { password: 'invalid-synthetic-password' }, 401, false);
  await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
  checks.push('device-cookie authentication; unauthenticated preview rejected');

  const htmlContent = await fixture.fetchRoute(`/api/codex/files/content?path=${encodeURIComponent(assets.html)}`);
  assert.match(await htmlContent.text(), /Preview fixture/);
  const htmlAsset = await fixture.fetchRoute(assetRoute('index.html'));
  assert.match(htmlAsset.headers.get('content-type') || '', /text\/html/);
  const policy = htmlAsset.headers.get('content-security-policy') || '';
  assert.match(policy, /sandbox/);
  assert.equal(policy.includes('allow-same-origin'), false);
  assert.match(policy, /connect-src 'none'/);
  assert.match(await htmlAsset.text(), /Preview fixture/);
  const css = await fixture.fetchRoute(assetRoute('nested/style.css'));
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  assert.match(await css.text(), /rgb\(17, 34, 51\)/);
  const js = await fixture.fetchRoute(assetRoute('nested/control.js'));
  assert.match(js.headers.get('content-type') || '', /application\/javascript/);
  assert.match(await js.text(), /__fixtureExternalScript/);
  const png = await fixture.fetchRoute(assetRoute('nested/pixel.png'));
  assert.match(png.headers.get('content-type') || '', /image\/png/);
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), await readFile(assets.png));
  await fixture.request(assetRoute('huge.bin'), 'GET', undefined, 413);
  await fixture.request(assetRoute('missing.css'), 'GET', undefined, 404);
  await fixture.request(assetRoute('escaped-link.txt'), 'GET', undefined, 404);
  // An embedded encoded slash prevents the HTTP client from normalizing '..' away.
  await fixture.request(assetRoute('%2e%2e%2foutside.txt'), 'GET', undefined, 404);
  await fixture.request('/api/codex/files/asset/local/invalid-token/index.html', 'GET', undefined, 404);
  checks.push('HTML content; nested CSS/PNG; oversized/missing/traversal/symlink assets; opaque-origin CSP; JSON errors');

  const queued = await fixture.request('/api/codex/queue/items', 'POST', {
    profileId, cwd: fixture.cwd, queueKey: `interactive-fixture-${randomUUID()}`,
    clientRequestId: randomUUID(), prompt: 'Complete the native interactive fixture in one ongoing task.',
  }, 202);
  const queueItemId = queued.item.id;
  const active = await fixture.poll(async () => {
    const result = await fixture.request(`/api/codex/queue/items/${queueItemId}?includeSession=false`);
    if (['failed', 'cancelled'].includes(result.item.status)) throw new Error('Synthetic native queue run failed before input');
    return result.item.sessionId && result.item.status === 'running' ? result.item : false;
  });
  const sessionId = active.sessionId;
  const questionRoute = `/api/codex/sessions/${sessionId}/user-input`;
  const first = await fixture.poll(async () => {
    const snapshot = await fixture.request(`${questionRoute}?profile=${profileId}`);
    return snapshot.requests.find(request => request.status === 'pending' && request.isBlocking) || false;
  });
  assert.equal(first.profileId, profileId);
  assert.equal(first.sessionId, sessionId);
  assert.equal(first.questions[0].id, 'destination');
  const answerRoute = `${questionRoute}/${first.id}/answer`;
  await fixture.request(answerRoute, 'POST', { profileId: otherProfileId, answers: { destination: { answers: ['Local (Recommended)'] } } }, 404);
  await fixture.request(answerRoute, 'POST', { profileId, answers: { wrong: { answers: ['Local (Recommended)'] } } }, 400);
  const answer = { profileId, answers: { destination: { answers: ['Local (Recommended)'] } } };
  assert.equal((await fixture.request(answerRoute, 'POST', answer)).duplicate, false);
  assert.equal((await fixture.request(answerRoute, 'POST', answer)).duplicate, true);
  await fixture.request(answerRoute, 'POST', { profileId, answers: { destination: { answers: ['Archive'] } } }, 409);
  checks.push('queue session binding before native input; cross-profile isolation; invalid answer; retry idempotency/conflict');

  const second = await fixture.poll(async () => {
    const snapshot = await fixture.request(`${questionRoute}?profile=${profileId}`);
    return snapshot.requests.find(request => request.status === 'pending' && !request.isBlocking) || false;
  });
  assert.equal(second.questions[0].options, null);
  assert.equal(second.runId, first.runId);
  assert.equal(second.turnId, first.turnId);
  const stillRunning = await fixture.request(`/api/codex/queue/items/${queueItemId}?includeSession=false`);
  assert.equal(stillRunning.item.status, 'running');
  assert.equal(stillRunning.item.attempts, 1);
  await fixture.request(`${questionRoute}/${second.id}/answer`, 'POST', {
    profileId, answers: { note: { answers: ['Free-text answer stays in the ongoing task'] } },
  });
  const completed = await fixture.poll(async () => {
    const result = await fixture.request(`/api/codex/queue/items/${queueItemId}?includeSession=false`);
    if (['failed', 'cancelled'].includes(result.item.status)) throw new Error('Synthetic native queue did not complete');
    return result.item.status === 'completed' ? result.item : false;
  });
  assert.equal(completed.id, queueItemId);
  assert.equal(completed.sessionId, sessionId);
  assert.equal(completed.attempts, 1);
  assert.match(completed.finalMessage, /destination=Local \(Recommended\)/);
  assert.match(completed.finalMessage, /note=Free-text answer stays in the ongoing task/);
  const settled = await fixture.request(`${questionRoute}?profile=${profileId}`);
  assert.equal(settled.pendingCount, 0);
  assert.equal(settled.requests.length, 2);
  assert.ok(settled.requests.every(request => request.status === 'answered'));
  const unrelated = await fixture.request(`${questionRoute}?profile=${otherProfileId}`);
  assert.equal(unrelated.requests.length, 0);
  checks.push('blocking and async free-text answers in one native turn; same queue item completes once');

  const detail = await fixture.request(`/api/codex/sessions/${sessionId}?profile=${profileId}&full=true`);
  // The authorized transport intentionally omits duplicated `messages` when
  // supplying the canonical timeline, including on a full detail read.
  assert.ok(detail.session.timeline.some(entry => entry.entryType === 'message'
    && entry.role === 'assistant' && entry.text === completed.finalMessage));
  const index = JSON.parse(await readFile(path.join(fixture.home, '.fixture-session-index.json'), 'utf8'));
  const rows = (await readFile(index[sessionId], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.type === 'session_meta').length, 1);
  assert.equal(rows.filter(row => row.payload?.type === 'task_started').length, 1);
  assert.equal(rows.filter(row => row.payload?.type === 'task_complete').length, 1);
  assert.equal(rows.filter(row => row.payload?.type === 'user_message').length, 1);
  assert.equal(rows.filter(row => row.payload?.type === 'function_call_output').length, 2);
  const audit = JSON.parse(await readFile(path.join(fixture.home, '.fixture-audit.json'), 'utf8'));
  assert.equal(audit.threadStartCount, 1);
  assert.equal(audit.turnStartCount, 1);
  assert.equal(audit.answerCount, 2);
  const queueState = await fixture.poll(async () => {
    const state = JSON.parse(await readFile(path.join(fixture.storage, 'queue', 'state.json'), 'utf8'));
    return state.items[0]?.status === 'completed' ? state : false;
  });
  assert.equal(queueState.items.length, 1);
  assert.equal(queueState.items[0].status, 'completed');
  assert.equal(queueState.items[0].sessionId, sessionId);
  checks.push('reopened native JSONL and API final answer; one persisted task/turn/queue item; two native tool responses');
  return { ok: true, checks, nativeTurns: 1, nativeAnswers: 2, queueItems: 1, realModelTurns: 0, realAccounts: false, productionEffects: false };
}

/** Entrypoint expected by the isolated BEAM build wrapper. */
export async function smoke({ appRoot, fakeCodex = DEFAULT_FAKE_CODEX }) {
  const fixture = await createInteractiveFixture(path.join(appRoot, 'dist', 'server.js'), fakeCodex);
  try {
    await fixture.start();
    return await runInteractiveApiSmoke(fixture);
  } finally {
    await fixture.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const compiled = path.resolve(process.argv[2] || 'dist/server.js');
    console.log(JSON.stringify(await smoke({ appRoot: path.resolve(path.dirname(compiled), '..') })));
  } catch (error) {
    // Error text identifies the failed check only; captured logs and secrets stay private.
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Interactive smoke failed' }));
    process.exitCode = 1;
  }
}
