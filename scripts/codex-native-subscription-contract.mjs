/** Explicit installed binary, private synthetic home and loopback fake provider.
 * No installed service, credential, user thread or real provider is accessed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { CodexSharedOwnerBroker } from '../server/codexSharedOwnerBroker.mjs';
import { CodexSharedSubscriptions } from '../server/codexSharedSubscriptions.mjs';

const binary = process.argv[2];
assert.ok(binary && path.isAbsolute(binary), 'Explicit absolute native binary required');
const root = await mkdtemp(path.join(os.tmpdir(), 'coa-native-subscriptions-'));
const home = path.join(root, 'home'), socket = path.join(root, 'owner.sock');
await mkdir(home, { mode: 0o700 });
const clients = [], calls = new Map();
let owner, lifecycle, providerCalls = 0;
const provider = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) { req.resume(); res.writeHead(404).end(); return; }
  for await (const _ of req) { /* Drain synthetic request, never retain or print bodies. */ }
  const ordinal = ++providerCalls;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
  emit({ type: 'response.created', response: { id: 'fixture-' + ordinal } });
  emit({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'answer-' + ordinal,
    content: [{ type: 'output_text', text: 'Synthetic complete.' }] } });
  emit({ type: 'response.completed', response: { id: 'fixture-' + ordinal,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
  res.end();
});
const waitFor = async predicate => {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error('Isolated native condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function client(name) {
  const ws = new WebSocket(`ws+unix://${socket}:/`), events = [], pending = new Map();
  let next = 0;
  ws.on('error', () => {});
  ws.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()), call = !frame.method && pending.get(frame.id);
    if (!call) { events.push(frame); return; }
    pending.delete(frame.id); clearTimeout(call.timer);
    frame.error ? call.reject(Error('Isolated native RPC refused ' + call.method + ' ' + frame.error.code)) : call.resolve(frame.result);
  });
  const channel = { ws, events, clientName: name, subscriptionRoots: new Set(),
    call(method, params = {}) {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      return new Promise((resolve, reject) => {
        const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('Isolated native RPC timed out: ' + method)); }, 10_000);
        pending.set(id, { resolve, reject, timer, method }); ws.send(JSON.stringify({ id, method, params }));
      });
    } };
  clients.push(channel);
  await once(ws, 'open');
  await channel.call('initialize', { clientInfo: { name, version: 'fixture' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  return channel;
}
async function turn(channel, threadId, text) {
  const result = await channel.call('turn/start', { threadId, input: [{ type: 'text', text }] });
  await waitFor(() => channel.events.some(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === result.turn.id));
  assert.equal(channel.events.find(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === result.turn.id).params.turn.status, 'completed');
}
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  await writeFile(path.join(home, 'config.toml'), [
    'model = "mock-model"', 'model_provider = "fixture"', 'model_reasoning_effort = "medium"',
    'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
    '[model_providers.fixture]', 'name = "Synthetic loopback provider"',
    `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"',
    'requires_openai_auth = false',
  ].join('\n') + '\n', { mode: 0o600 });
  owner = spawn(binary, ['app-server', '--listen', 'unix://' + socket], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
  owner.stderr.resume();
  await waitFor(async () => {
    if (owner.exitCode !== null) throw Error('Isolated native exited');
    return stat(socket).then(s => s.isSocket(), () => false);
  });
  const control = await client('fixture-control'), recovery = await client('code-ai-broker-recovery'), web = await client('code-ai');
  const own = await web.call('thread/start', { cwd: root, ephemeral: false });
  web.subscriptionRoots.add(own.thread.id);
  await turn(web, own.thread.id, 'Synthetic first own input.');
  const foreign = await control.call('thread/start', { cwd: root, ephemeral: false });
  await turn(control, foreign.thread.id, 'Synthetic foreign input.');
  // Recreate incidental subscriptions while preserving only web's intended root.
  for (const channel of [recovery, web]) await channel.call('thread/resume', { threadId: foreign.thread.id, excludeTurns: true });
  await recovery.call('thread/resume', { threadId: own.thread.id, excludeTurns: true });
  const foreignPath = foreign.thread.path;
  assert.ok(typeof foreignPath === 'string' && foreignPath.startsWith(home + path.sep));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const before = hash(await readFile(foreignPath));
  const metadata = await recovery.call('thread/read', { threadId: foreign.thread.id, includeTurns: false });
  assert.equal(metadata.thread.status.type, 'idle'); assert.equal(metadata.thread.ephemeral, false);
  assert.ok(['appServer', 'vscode', 'exec', 'cli'].includes(metadata.thread.source));
  assert.equal((await control.call('thread/unsubscribe', { threadId: foreign.thread.id })).status, 'unsubscribed');
  lifecycle = new CodexSharedSubscriptions({ broker: new CodexSharedOwnerBroker(), channels: new Set([recovery, web]), recovery });
  const result = await lifecycle.sweep();
  assert.ok(result.unsubscribed >= 3);
  assert.equal((await recovery.call('thread/unsubscribe', { threadId: foreign.thread.id })).status, 'notSubscribed');
  assert.equal((await web.call('thread/unsubscribe', { threadId: foreign.thread.id })).status, 'notSubscribed');
  assert.ok((await control.call('thread/loaded/list')).data.includes(foreign.thread.id), 'Native grace retains idle unsubscribed thread');
  assert.equal(hash(await readFile(foreignPath)), before, 'Cleanup preserves stored history');
  assert.equal((await control.call('thread/read', { threadId: foreign.thread.id, includeTurns: false })).thread.id, foreign.thread.id);
  const inputCallsBeforeFollowup = calls.get('turn/start');
  await turn(web, own.thread.id, 'Synthetic explicit follow-up.');
  assert.equal(calls.get('turn/start'), inputCallsBeforeFollowup + 1);
  assert.equal(providerCalls, 3);
  const required = ['thread/loaded/list', 'thread/read', 'thread/queue/list', 'thread/goal/get', 'thread/backgroundTerminals/list', 'thread/unsubscribe'];
  for (const method of required) assert.ok(calls.get(method) > 0);
  console.log(JSON.stringify({ format: 'code-ai-native-subscription-contract', passed: true, synthetic: true,
    installedEffects: false, realCredentialsRead: false, realProviderCalls: 0, fakeProviderCalls: providerCalls,
    nativePidPreserved: owner.exitCode === null, lifecycleApisExercised: required,
    unsubscribed: result.unsubscribed, nativeGraceObserved: true, historyHashPreserved: true,
    explicitFollowupOnly: true, fullThirtyMinuteExpiryObserved: false }));
} finally {
  lifecycle?.close();
  for (const channel of clients) channel.ws.terminate();
  if (owner && owner.exitCode === null) { const exited = once(owner, 'close'); owner.kill('SIGTERM'); await exited; }
  await new Promise(resolve => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
