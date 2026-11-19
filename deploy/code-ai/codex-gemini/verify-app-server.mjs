#!/usr/bin/env node
// Verify native app-server compaction and cancellation in an existing pilot thread.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './runtime-paths.mjs';

const root = await resolveRuntime();
const receiptFile = process.argv[2];
if (!receiptFile || !path.resolve(receiptFile).startsWith(path.join(root, 'evidence') + path.sep)) {
  throw new Error('An explicit pilot verification receipt is required');
}
const previous = JSON.parse(await readFile(receiptFile, 'utf8'));
assert.equal(previous.passed, true);
const threadId = previous.turns[0].threadId;
const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const child = spawn(process.execPath, [launcher, 'app-server', '--listen', 'stdio://'], {
  cwd: path.join(root, 'workspace'), stdio: ['pipe', 'pipe', 'pipe'],
});
const reader = createInterface({ input: child.stdout });
const frames = [], pending = new Map();
let next = 0, stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
reader.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  frames.push(frame);
  if (frame.method && frame.id !== undefined) {
    send({ id: frame.id, error: { code: -32601, message: 'No interactive approvals in this bounded pilot' } });
    return;
  }
  const request = pending.get(frame.id);
  if (request) {
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error(`${request.method}: ${frame.error.message}`));
    else request.resolve(frame.result);
  }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, { method, resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000) });
  send({ id, method, params });
});
async function waitFor(predicate, after, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = frames.slice(after).find(predicate);
    if (frame) return frame;
    if (child.exitCode !== null) throw new Error('Pilot app-server exited');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Pilot app-server event timed out');
}
const receipt = { startedAt: new Date().toISOString(), threadId, checks: {} };
try {
  const settings = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  const unauthorized = await fetch(`http://127.0.0.1:${settings.port}/v1/models`, { headers: { Authorization: 'Bearer invalid-pilot-key' } });
  // Without a virtual-key database LiteLLM rejects unknown keys with 400.
  assert.ok([400, 401, 403].includes(unauthorized.status));
  const anonymous = await fetch(`http://127.0.0.1:${settings.port}/v1/models`);
  assert.equal(anonymous.status, 401); receipt.checks.gatewayAuth = true;
  await call('initialize', { clientInfo: { name: 'codex-gemini-pilot', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  const resumed = await call('thread/resume', { threadId, excludeTurns: true, approvalPolicy: 'never', sandbox: 'workspace-write' });
  assert.equal(resumed.thread.id, threadId); receipt.checks.resume = true;
  const beforeCompact = frames.length;
  await call('thread/compact/start', { threadId });
  await waitFor(frame => frame.method === 'thread/compacted' || (frame.method === 'item/completed' && frame.params?.item?.type === 'contextCompaction'), beforeCompact);
  receipt.checks.nativeCompaction = true;
  console.log('Native Codex compaction completed through Gemini');
  const beforeFollowup = frames.length;
  const followup = await call('turn/start', { threadId, input: [{ type: 'text', text: 'After compaction, without reading files or tools, state the run identifier from verified.txt and the arithmetic result again. Answer COMPACTION_OK.' }] });
  const completed = await waitFor(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === followup.turn.id, beforeFollowup);
  assert.equal(completed.params.turn.status, 'completed');
  const text = frames.slice(beforeFollowup).filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage').map(frame => frame.params.item.text).join('\n');
  assert.ok(text.includes(previous.runId) && text.includes('391') && text.includes('COMPACTION_OK'));
  receipt.checks.postCompactionContinuity = true;
  const beforeCancel = frames.length;
  const cancellable = await call('turn/start', { threadId, input: [{ type: 'text', text: 'For the cancellation integration test, execute the shell command sleep 30 now. Do not change files or do anything else.' }] });
  await waitFor(frame => frame.method === 'item/started' && frame.params?.item?.type === 'commandExecution', beforeCancel);
  await call('turn/interrupt', { threadId, turnId: cancellable.turn.id });
  const interrupted = await waitFor(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === cancellable.turn.id, beforeCancel, 10000);
  assert.equal(interrupted.params.turn.status, 'interrupted'); receipt.checks.nativeInterrupt = true;
  receipt.passed = true;
} catch (error) {
  receipt.passed = false; receipt.error = error.message; process.exitCode = 1;
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  child.stdin.end();
  const exit = new Promise(resolve => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
  await exit; clearTimeout(timer); reader.close();
}
receipt.finishedAt = new Date().toISOString();
const output = path.join(root, 'evidence', `${previous.runId}-app-server-receipt.json`);
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await writeFile(path.join(root, 'evidence', `${previous.runId}-app-server.stderr`), stderr, { mode: 0o600 });
console.log(JSON.stringify({ ...receipt, receipt: output }, null, 2));
