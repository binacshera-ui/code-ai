import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Explicit opt-in: this launches the installed native executable, but never uses
// the operator's HOME, CODEX_HOME, credentials, config, model endpoint or MCPs.
const nativeBin = process.env.CODE_AI_NATIVE_AUTH_TEST_BIN;
const dummyA = ('sk-' + 'dummy-api-A-native-auth-integration');
const dummyB = ('sk-' + 'dummy-api-B-native-auth-integration');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed native owner switches API credentials for an existing thread without restarting', {
  skip: !nativeBin && 'set CODE_AI_NATIVE_AUTH_TEST_BIN to an installed codex binary',
  timeout: 120_000,
}, t => verifyNativeAuthSwitch(t, false));

test('installed native owner changes the credential bound to its cached Responses WebSocket', {
  skip: (!nativeBin || process.env.CODE_AI_NATIVE_AUTH_TEST_WEBSOCKETS !== '1')
    && 'set CODE_AI_NATIVE_AUTH_TEST_BIN and CODE_AI_NATIVE_AUTH_TEST_WEBSOCKETS=1',
  timeout: 120_000,
}, t => verifyNativeAuthSwitch(t, true));

async function verifyNativeAuthSwitch(t, websockets) {
  const scratchParent = path.join(projectRoot, '.code-ai', 'tmp');
  await fs.mkdir(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = await fs.mkdtemp(path.join(scratchParent, 'native-api-auth-'));
  const codexHome = path.join(scratch, 'codex-home');
  const userHome = path.join(scratch, 'user-home');
  const workingDir = path.join(scratch, 'workspace');
  await Promise.all([codexHome, userHome, workingDir].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  const requests = [], unexpectedRequests = [], handshakes = [], prewarms = [];
  const credentialOf = auth => auth === `Bearer ${dummyA}` ? 'API_A' : auth === `Bearer ${dummyB}` ? 'API_B' : 'unexpected';
  const mockEvents = n => [
    { type: 'response.created', response: { id: `local-response-${n}` } },
    { type: 'response.output_item.done', item: { id: `local-message-${n}`, type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: `local-answer-${n}` }] } },
    { type: 'response.completed', response: { id: `local-response-${n}`,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ];
  let responseGate = null, requestObserved = null, releaseResponse = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      unexpectedRequests.push({ method: req.method, url: req.url });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Only the local mock Responses endpoint is allowed' } }));
      return;
    }
    try {
      assert.equal(req.headers['content-encoding'], undefined, 'mock expects uncompressed API-key requests');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const credential = credentialOf(req.headers.authorization);
      requests.push({ credential, body, transport: 'http' });
      requestObserved?.();
      if (responseGate) await responseGate;
      const n = requests.length;
      const events = mockEvents(n);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) {
      unexpectedRequests.push({ error: error.message });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Local mock request failed' } }));
    }
  });
  let wsServer = null;
  if (websockets) {
    const { WebSocketServer } = await import('ws');
    wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/v1/responses') {
        unexpectedRequests.push({ method: 'UPGRADE', url: req.url });
        socket.destroy(); return;
      }
      const credential = credentialOf(req.headers.authorization);
      const connectionId = handshakes.length + 1;
      handshakes.push({ connectionId, credential });
      wsServer.handleUpgrade(req, socket, head, ws => {
        ws.on('message', async data => {
          try {
            const body = JSON.parse(data.toString());
            if (body.type === 'response.processed') return;
            assert.equal(body.type, 'response.create');
            if (body.generate === false) {
              prewarms.push({ credential, connectionId });
              const responseId = `local-prewarm-${prewarms.length}`;
              ws.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
              ws.send(JSON.stringify({ type: 'response.completed', response: { id: responseId,
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }));
              return;
            }
            requests.push({ credential, body, transport: 'websocket', connectionId });
            requestObserved?.();
            if (responseGate) await responseGate;
            for (const event of mockEvents(requests.length)) ws.send(JSON.stringify(event));
          } catch (error) {
            unexpectedRequests.push({ error: error.message, transport: 'websocket' });
            ws.terminate();
          }
        });
      });
    });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(codexHome, 'config.toml'), `
model = "mock-model"
model_provider = "native_auth_mock"
cli_auth_credentials_store = "file"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[features]
shell_snapshot = false
[model_providers.native_auth_mock]
name = "OpenAI"
base_url = "${endpoint}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = ${websockets}
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });

  // An allowlist prevents inherited provider credentials or config switches from
  // reaching the child. Proxy fallback also terminates on the local mock server.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: userHome, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(userHome, '.config'),
    XDG_CACHE_HOME: path.join(userHome, '.cache'),
    XDG_DATA_HOME: path.join(userHome, '.local', 'share'),
    TMPDIR: scratch, NO_COLOR: '1', TERM: 'dumb',
    OPENAI_BASE_URL: `${endpoint}/v1`,
    HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };
  const child = spawn(nativeBin, ['app-server'], { cwd: workingDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const nativePid = child.pid;
  const messages = [], pending = new Map(), waiters = new Set();
  let seq = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32_768); });
  const failPending = error => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  child.on('error', failPending);
  child.on('exit', (code, signal) => failPending(new Error(`native exited: ${code ?? signal}`)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return failPending(new Error('invalid native JSON frame')); }
    messages.push(message);
    if (message.id != null && !message.method && pending.has(message.id)) {
      const pendingRequest = pending.get(message.id);
      pending.delete(message.id); clearTimeout(pendingRequest.timer);
      if (message.error) pendingRequest.reject(new Error(JSON.stringify(message.error)));
      else pendingRequest.resolve(message.result);
    }
    for (const waiter of [...waiters]) {
      if (waiter.matches(message)) { waiters.delete(waiter); waiter.resolve(message); }
    }
  });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const waitNotification = matches => {
    const existing = messages.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('native notification timed out')); }, 60_000);
      waiters.add(waiter);
    });
  };
  t.after(async () => {
    releaseResponse?.();
    child.stdin.end();
    child.kill('SIGTERM');
    failPending(new Error('test cleanup'));
    if (wsServer) { for (const client of wsServer.clients) client.terminate(); wsServer.close(); }
    await new Promise(resolve => server.close(resolve));
    if (!process.env.CODE_AI_NATIVE_AUTH_KEEP_ARTIFACTS) await fs.rm(scratch, { recursive: true, force: true });
  });
  try {
    const initialize = await rpc('initialize', { clientInfo: { name: 'code-ai-native-auth-test', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    assert.equal((await rpc('account/read', { refreshToken: false })).account, null);
    assert.deepEqual(await rpc('account/login/start', { type: 'apiKey', apiKey: dummyA }), { type: 'apiKey' });
    assert.equal((await rpc('account/read', { refreshToken: false })).account.type, 'apiKey');
    assert.equal(JSON.parse(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8')).OPENAI_API_KEY, dummyA);

    const started = await rpc('thread/start', { cwd: workingDir, model: 'mock-model', ephemeral: false });
    const threadId = started.thread.id;
    const idleRead = await rpc('thread/read', { threadId, includeTurns: false });
    assert.deepEqual(idleRead.thread.status, { type: 'idle' });
    const runTurn = async text => {
      const result = await rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      const completed = await waitNotification(message => message.method === 'turn/completed'
        && message.params?.threadId === threadId && message.params?.turn?.id === result.turn.id);
      assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
      return result.turn.id;
    };
    responseGate = new Promise(resolve => { releaseResponse = resolve; });
    const firstRequest = new Promise(resolve => { requestObserved = resolve; });
    const firstTurn = runTurn('native-auth-first-history-marker');
    await Promise.race([firstRequest, firstTurn]);
    const loaded = await rpc('thread/loaded/list', {});
    assert.ok(loaded.data.includes(threadId));
    const activeRead = await rpc('thread/read', { threadId, includeTurns: true });
    assert.deepEqual(activeRead.thread.status, { type: 'active', activeFlags: [] });
    assert.ok(activeRead.thread.turns.some(turn => turn.status === 'inProgress'));
    releaseResponse(); responseGate = null; requestObserved = null;
    const firstTurnId = await firstTurn;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].credential, 'API_A');
    if (websockets) assert.equal(requests[0].transport, 'websocket', 'must exercise native WebSocket transport');

    await rpc('account/logout');
    assert.equal((await rpc('account/read', { refreshToken: false })).account, null);
    assert.deepEqual(await rpc('account/login/start', { type: 'apiKey', apiKey: dummyB }), { type: 'apiKey' });
    assert.equal((await rpc('account/read', { refreshToken: false })).account.type, 'apiKey');
    assert.equal(JSON.parse(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8')).OPENAI_API_KEY, dummyB);
    const secondTurnId = await runTurn('native-auth-second-history-marker');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].credential, 'API_B', 'existing thread must send the newly selected credential');
    const secondInput = JSON.stringify(requests[1].body.input);
    assert.ok(secondInput.includes('native-auth-first-history-marker'), 'prior user history survives switching');
    assert.ok(secondInput.includes('local-answer-1'), 'prior assistant history survives switching');
    assert.ok(secondInput.includes('native-auth-second-history-marker'));
    const read = await rpc('thread/read', { threadId, includeTurns: true });
    assert.equal(read.thread.id, threadId);
    assert.ok(read.thread.turns.some(turn => turn.id === firstTurnId));
    assert.ok(read.thread.turns.some(turn => turn.id === secondTurnId));
    assert.equal(child.pid, nativePid);
    assert.equal(child.exitCode, null, 'native owner remains alive');
    assert.deepEqual(unexpectedRequests, []);
    const evidence = { passed: true, transportScenario: websockets ? 'websocket' : 'http',
      handshakes, prewarms, requestTransports: requests.map(req => req.transport),
      userAgent: initialize.userAgent, nativePid, sameOwnerProcess: true,
      threadId, turnIds: [firstTurnId, secondTurnId], credentialsObserved: requests.map(req => req.credential),
      preservedUserHistory: true, preservedAssistantHistory: true, persistedTurns: read.thread.turns.length,
      idleThreadStatus: idleRead.thread.status, activeThreadStatus: activeRead.thread.status,
      activeTurnStatuses: activeRead.thread.turns.map(turn => turn.status), loadedList: loaded,
      responsesRequests: requests.length, unexpectedRequests, endpointScope: 'localhost-only', dummyCredentialsOnly: true };
    if (process.env.CODE_AI_NATIVE_AUTH_EVIDENCE_PATH) {
      const outputPath = process.env.CODE_AI_NATIVE_AUTH_EVIDENCE_PATH + (websockets ? '.websocket.json' : '');
      await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    }
    t.diagnostic(JSON.stringify(evidence));
  } catch (error) {
    t.diagnostic(`native stderr: ${stderr}`);
    t.diagnostic(`observed credentials: ${JSON.stringify(requests.map(req => req.credential))}`);
    const failedEvidence = { passed: false, transportScenario: websockets ? 'websocket' : 'http',
      handshakes, prewarms, requests: requests.map(({ credential, transport, connectionId }) => ({ credential, transport, connectionId })),
      failure: error.message, unexpectedRequests, endpointScope: 'localhost-only', dummyCredentialsOnly: true };
    t.diagnostic(JSON.stringify(failedEvidence));
    if (process.env.CODE_AI_NATIVE_AUTH_EVIDENCE_PATH) {
      const outputPath = process.env.CODE_AI_NATIVE_AUTH_EVIDENCE_PATH + (websockets ? '.websocket.json' : '');
      await fs.writeFile(outputPath, JSON.stringify(failedEvidence, null, 2) + '\n', { mode: 0o600 });
    }
    t.diagnostic(`unexpected local requests: ${JSON.stringify(unexpectedRequests)}`);
    throw error;
  }
}
