/** Native queue contract; synthetic private homes and a loopback fake provider only. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';

const bin = process.argv[2];
if (!bin || !path.isAbsolute(bin)) throw new Error('Explicit absolute native fixture binary required');
const bridgeIndex = process.argv.indexOf('--bridge');
const bridgePath = bridgeIndex >= 0 ? process.argv[bridgeIndex + 1] : null;
if (bridgeIndex >= 0 && (!bridgePath || !path.isAbsolute(bridgePath))) throw new Error('Explicit absolute fixture bridge required');
const WebSocket = bridgePath ? null : (await import('ws')).default;
const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-owner-contract-'));
const canonical = process.argv.includes('--canonical');
const settingsRace = process.argv.includes('--settings-race');
const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
const socketPath = canonical ? path.join(home, 'app-server-control', 'app-server-control.sock') : path.join(root, 'owner.sock');
await mkdir(home); await mkdir(cwd);
let providerCalls = 0;
const requestedSyntheticModels = [];
let releaseDesktop;
const desktopHeld = new Promise(resolve => { releaseDesktop = resolve; });
const provider = createServer(async (req, res) => {
  // Only this fixture's synthetic body is inspected; no headers or content are logged.
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { req.resume(); res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requestedSyntheticModels.push(JSON.parse(Buffer.concat(chunks).toString()).model);
  const ordinal = ++providerCalls;
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
  const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  event({ type: 'response.created', response: { id: `synthetic-${ordinal}` } });
  if (ordinal === 1) await desktopHeld;
  event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `answer-${ordinal}`,
    content: [{ type: 'output_text', text: 'Synthetic contract answer.' }] } });
  event({ type: 'response.completed', response: { id: `synthetic-${ordinal}`,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  res.end();
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
await writeFile(path.join(home, 'config.toml'), [
  'model = "mock-model"', 'model_provider = "contract"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
  '[model_providers.contract]', 'name = "Isolated contract fake provider"',
  `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
].join('\n') + '\n', { mode: 0o600 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root });
const owner = spawn(bin, ['app-server', '--listen', canonical ? 'unix://' : `unix://${socketPath}`], { env, cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
owner.stderr.resume();
let ownerError = false;
owner.on('error', () => { ownerError = true; });
const clients = [];
let lastRpcMetadata = null;
const waitFor = async predicate => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline || ownerError || owner.exitCode !== null) throw new Error('Native isolated fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function client() {
  let next = 0;
  const pending = new Map(), events = [];
  const receive = frame => {
    const call = pending.get(frame.id);
    if (call) { pending.delete(frame.id); clearTimeout(call.timer); call.resolve(frame); }
    else events.push(frame);
  };
  let send, close;
  if (bridgePath) {
    const adapter = spawn(process.execPath, [bridgePath, socketPath], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    adapter.stderr.resume();
    clients.push({ terminate: () => adapter.kill('SIGTERM') });
    let buffer = '';
    adapter.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        receive(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
      }
    });
    send = value => adapter.stdin.write(JSON.stringify(value) + '\n');
    close = () => adapter.stdin.end();
  } else {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5_000 });
    clients.push(ws);
    await once(ws, 'open');
    ws.on('message', data => receive(JSON.parse(data.toString())));
    send = value => ws.send(JSON.stringify(value));
    close = () => ws.close();
  }
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native isolated RPC timed out')); }, 15_000);
    pending.set(id, { resolve: frame => {
      lastRpcMetadata = { method, ok: !frame.error, code: frame.error?.code ?? null,
        homeReturned: typeof frame.result?.codexHome === 'string' };
      resolve(frame);
    }, reject, timer });
    send({ id, method, params });
  });
  const init = await call('initialize', { clientInfo: { name: 'code-ai-isolated-contract', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  assert.equal(init.error, undefined);
  assert.equal(init.result.codexHome, home);
  send({ method: 'initialized', params: {} });
  return { call, events, close };
}
const input = text => [{ type: 'text', text, text_elements: [] }];
let passed = 0;
let daemonVersionProbe = null;
try {
  const deadline = Date.now() + 15_000;
  while (!await stat(socketPath).then(s => s.isSocket(), () => false)) {
    if (Date.now() > deadline || ownerError || owner.exitCode !== null) throw new Error('Fixture owner not ready');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (canonical) {
    daemonVersionProbe = await new Promise((resolve, reject) => {
      execFile(bin, ['app-server', 'daemon', 'version'], { env, cwd, timeout: 10_000 }, (error, stdout) => {
        if (error) { reject(new Error('Isolated native daemon probe rejected')); return; }
        try {
          const result = JSON.parse(stdout);
          assert.ok(typeof result.appServerVersion === 'string');
          resolve({ appServerVersion: result.appServerVersion, unmanagedOwnerAccepted: true });
        } catch { reject(new Error('Isolated native daemon version shape not accepted')); }
      });
    });
  }
  const desktop = await client(), web = await client();
  const started = await desktop.call('thread/start', { cwd, ephemeral: false });
  assert.equal(started.error, undefined);
  const threadId = started.result.thread.id;
  const external = await desktop.call('turn/start', { threadId, input: input('Synthetic desktop turn.'), clientUserMessageId: 'desktop-contract' });
  assert.equal(external.error, undefined);
  const desktopTurnId = external.result.turn.id;
  await waitFor(() => providerCalls === 1);
  assert.equal((await web.call('thread/resume', { threadId, excludeTurns: true })).error, undefined);
  passed++;
  const queued = await web.call('thread/queue/add', { threadId, input: input('Synthetic web queued turn.'), clientUserMessageId: 'web-contract' });
  assert.equal(queued.error, undefined);
  assert.equal(queued.result.queuedSubmission.clientUserMessageId, 'web-contract');
  passed++;
  const queuedId = queued.result.queuedSubmission.id;
  const notIdle = await web.call('thread/queue/start', { threadId, queuedSubmissionId: queuedId });
  assert.ok(notIdle.error && notIdle.error.code === -32600);
  assert.equal(providerCalls, 1);
  passed++;
  const queuedRead = await web.call('thread/queue/list', { threadId, limit: 100 });
  assert.equal(queuedRead.result.data.filter(item => item.clientUserMessageId === 'web-contract').length, 1);
  const cancelQueued = await web.call('thread/queue/add', { threadId, input: input('Synthetic removable queued turn.'), clientUserMessageId: 'cancel-contract' });
  assert.equal(cancelQueued.error, undefined);
  assert.equal((await web.call('thread/queue/delete', { threadId, queuedSubmissionId: cancelQueued.result.queuedSubmission.id })).result.deleted, true);
  assert.equal(providerCalls, 1);
  passed++;
  web.close();
  const rejoined = await client();
  assert.equal((await rejoined.call('thread/resume', { threadId, excludeTurns: true })).error, undefined);
  assert.equal((await rejoined.call('thread/queue/list', { threadId })).result.data.filter(item => item.clientUserMessageId === 'web-contract').length, 1);
  passed++;
  if (settingsRace) {
    const updated = await desktop.call('thread/settings/update', { threadId, model: 'mock-model-updated', effort: 'low' });
    assert.equal(updated.error, undefined);
    await waitFor(() => desktop.events.some(frame => frame.method === 'thread/settings/updated'
      && frame.params?.threadSettings?.model === 'mock-model-updated'));
    passed++;
  }
  releaseDesktop();
  await waitFor(() => providerCalls === 2 && rejoined.events.some(frame => frame.method === 'turn/completed'
    && frame.params?.turn?.id !== desktopTurnId));
  const own = rejoined.events.find(frame => frame.method === 'item/started' && frame.params?.item?.type === 'userMessage'
    && frame.params.item.clientId === 'web-contract');
  assert.ok(own && typeof own.params.turnId === 'string' && own.params.turnId !== desktopTurnId);
  passed++;
  const read = await rejoined.call('thread/read', { threadId, includeTurns: true });
  assert.equal(read.error, undefined);
  const ownTurns = read.result.thread.turns.filter(turn => turn.items.some(item => item.type === 'userMessage' && item.clientId === 'web-contract'));
  assert.equal(ownTurns.length, 1);
  assert.equal(ownTurns[0].id, own.params.turnId);
  assert.equal(ownTurns[0].status, 'completed');
  assert.equal((await rejoined.call('thread/queue/list', { threadId })).result.data.length, 0);
  passed++;
  if (settingsRace) {
    assert.equal(requestedSyntheticModels[0], 'mock-model');
    assert.equal(requestedSyntheticModels[1], 'mock-model-updated');
    passed++;
  }
  desktop.close(); rejoined.close();
  const last = await client();
  assert.equal((await last.call('thread/resume', { threadId, excludeTurns: true })).error, undefined);
  assert.equal(providerCalls, 2);
  passed++;
  console.log(JSON.stringify({ format: 'code-ai-native-shared-owner-contract', passed,
    synthetic: true, realProviderCalls: 0, loopbackFakeProviderCalls: providerCalls,
    writerConflict: false, queuedInputNeverSteeredDesktop: true, stableClientIdIdentifiedOwnTurn: true,
    pendingCancellationPreservedDesktop: true, disconnectPreservedQueue: true, reconnectDidNotReplayInput: true,
    installedEffects: false, canonicalEndpoint: canonical, daemonVersionProbe,
    queuedInputInheritedSubsequentOwnerSettings: settingsRace ? true : null,
    liveGuiMigrationProven: false, perSubmissionConfigOverridesProven: false }));
} catch {
  console.error(JSON.stringify({ format: 'code-ai-native-shared-owner-contract', passed,
    synthetic: true, installedEffects: false, failed: true, realProviderCalls: 0, lastRpcMetadata }));
  process.exitCode = 1;
} finally {
  releaseDesktop();
  for (const ws of clients) ws.terminate();
  if (owner.pid && owner.exitCode === null) {
    try { process.kill(-owner.pid, 'SIGTERM'); } catch { /* Own fixture only. */ }
    await Promise.race([once(owner, 'close'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (owner.exitCode === null && owner.signalCode === null) { try { process.kill(-owner.pid, 'SIGKILL'); } catch { /* Own fixture only. */ } }
  }
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
