/** Native Chrome host qualification against an isolated registry, with read RPCs only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
assert.equal(os.hostname(), 'gpu-lab'); assert.equal(process.getuid(), 1000);
const base = '/home/refael/.local/lib/code-ai/browser-shared-20261012-v1';
const cli = base + '/codex-browser-shared.mjs';
await fs.chmod(cli, 0o700);
const registry = '/home/refael/.local/state/openai-codex/chrome-native-hosts-v2.json';
const original = JSON.parse(await fs.readFile(registry, 'utf8'));
assert.equal(original.schemaVersion, 2); assert.equal(original.entries.length, 1);
const candidate = structuredClone(original);
const entry = candidate.entries[0];
assert.equal(entry.paths.codexHome, '/home/refael/.codex');
entry.paths.codexCliPath = cli;
const fixture = await fs.mkdtemp('/home/refael/.local/state/code-ai-browser-qualification-');
await fs.mkdir(fixture + '/openai-codex', { mode: 0o700 });
await fs.writeFile(fixture + '/openai-codex/chrome-native-hosts-v2.json', JSON.stringify(candidate), { mode: 0o600 });
const W = createRequire('/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-large-frames-477ce0f0-4633-4871-a370-42778e15a465/package.json')('ws');
const ownerFile = '/home/refael/code-ai-native-owner/ownership.json';
const before = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
const origin = 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/';
const host = spawn(entry.paths.extensionHostPath, [origin], {
  env: { ...process.env, XDG_STATE_HOME: fixture }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = Buffer.alloc(0), next = 0, stderrBytes = 0;
const pending = new Map();
host.stderr.on('data', b => { stderrBytes += b.length; });
host.stdout.on('data', b => {
  buffer = Buffer.concat([buffer, b]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const length = buffer.readUInt32LE(0), frame = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4); const p = pending.get(frame.id);
    if (p) { pending.delete(frame.id); clearTimeout(p.timer); p.resolve(frame); }
  }
});
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = 'code-ai-preflight-' + (++next), timer = setTimeout(() => { pending.delete(id); reject(Error('native_host_timeout')); }, 15000);
  pending.set(id, { resolve, timer });
  const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })), size = Buffer.alloc(4);
  size.writeUInt32LE(data.length); host.stdin.write(Buffer.concat([size, data]));
});
const constraints = { extensionBuildChannel: 'prod', extensionId: 'hehggadaopoacecdllhhajmbjkdcmajg',
  extensionVersion: '1.26.901.11451', nativeHostName: 'com.openai.codexextension',
  requiredAppServerProtocolVersion: 2, requiredNativeHostProtocolVersion: 2 };
const receipt = { host: 'gpu-lab', fixture, cli, phase: 'hello', inputsSubmitted: false, passed: false };
let ws;
try {
  const hello = await callHost('codexRuntime/hello', { constraints });
  assert.ok(hello.result, 'hello_rejected');
  receipt.nativeHostProtocolVersion = hello.result.nativeHostProtocolVersion;
  receipt.phase = 'ensure';
  const ensure = await callHost('codexRuntime/ensure', { constraints, clientId: 'code-ai-browser-owner-preflight' });
  if (ensure.error) { receipt.errorCode = ensure.error.code; receipt.errorType = ensure.error.data?.type; }
  assert.ok(ensure.result, 'ensure_rejected');
  receipt.resultKeys = Object.keys(ensure.result);
  const url = new URL(ensure.result.localAppServerUrl);
  assert.equal(url.hostname, '127.0.0.1');
  if (url.protocol === 'http:') url.protocol = 'ws:';
  receipt.phase = 'websocket-readback';
  ws = new W(url.toString(), { origin: origin.slice(0, -1), maxPayload: 64 * 1024 * 1024, handshakeTimeout: 5000 });
  const replies = new Map(); ws.on('error', () => {});
  ws.on('message', b => { const f = JSON.parse(b.toString()); const p = replies.get(f.id);
    if (p) { clearTimeout(p.timer); replies.delete(f.id); p.resolve(f); }
  });
  await new Promise((y, x) => { ws.once('open', y); ws.once('error', x); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { replies.delete(id); reject(Error('rpc_timeout')); }, 10000);
    replies.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const init = await rpc('initialize', { clientInfo: { name: 'code-ai-browser-qualification', version: '1' }, capabilities: { experimentalApi: true } });
  assert.equal(init.result?.codexHome, '/home/refael/.codex');
  assert.equal(init.result?.codeAiSharedOwner?.version, 1);
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  const config = await rpc('configRequirements/read', null); assert.ok(Object.hasOwn(config, 'result'));
  const read = await rpc('thread/read', { threadId: '01a12ef6-be42-7962-bbe0-c99092522e96', includeTurns: false });
  assert.equal(read.result?.thread?.id, '01a12ef6-be42-7962-bbe0-c99092522e96');
  receipt.sharedOwnerVerified = true; receipt.historyReadPassed = true;
  const after = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  assert.equal(after.nativePid, before.nativePid); assert.equal(after.nativeIdentity.startTime, before.nativeIdentity.startTime);
  receipt.nativePid = after.nativePid; receipt.ownerUnchanged = true; receipt.passed = true; receipt.phase = 'complete';
} catch (e) {
  receipt.failure = /^[a-z_]+$/.test(e.message) ? e.message : e.code || e.name;
  process.exitCode = 1;
} finally {
  ws?.terminate(); host.stdin.end();
  const closed = new Promise(resolve => host.once('exit', resolve));
  const timer = setTimeout(() => host.kill('SIGTERM'), 2000);
  await closed; clearTimeout(timer); for (const p of pending.values()) clearTimeout(p.timer);
  receipt.stderrBytes = stderrBytes;
  receipt.observedAt = new Date().toISOString();
  await fs.writeFile(base + '/qualification.json', JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
