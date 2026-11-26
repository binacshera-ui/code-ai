#!/usr/bin/env node
// Live qualification: one native thread switches models, keeps tools and resumes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const selectedModels = process.argv.find(arg => arg.startsWith('--models='))?.slice('--models='.length).split(',');
const args = process.argv.slice(2).filter(arg => arg !== '--legacy-openai' && !arg.startsWith('--models='));
const models = selectedModels || ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon', 'gemini-4-hydrogen'];
const continuationModel = selectedModels?.at(-1) || 'gemini-4-neon';
const home = path.resolve(args[0]);
const workspace = path.resolve(args[1]);
const output = path.resolve(args[2]);
await mkdir(workspace, { recursive: true });
const previous = args[3] ? JSON.parse(await readFile(path.resolve(args[3]), 'utf8')) : null;
const legacy = process.argv.includes('--legacy-openai') || previous?.existingOpenAiThreadResumed === true;
const marker = previous?.marker || randomUUID();
const receipt = previous ? { ...previous, resumedAt: new Date().toISOString() }
  : { marker, startedAt: new Date().toISOString(), checks: [], threadId: null };
let child, reader, next = 0, frames = [], pending = new Map();
const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} acknowledgement timed out`)); }, method === 'initialize' || method === 'thread/resume' ? 120000 : 20000);
  pending.set(id, { resolve, reject, timer }); send({ id, method, params });
});
async function wait(predicate, after, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = frames.slice(after).find(predicate);
    if (frame) return frame;
    if (child.exitCode !== null) throw new Error('Native app-server exited');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Native turn timed out');
}
async function start(originalProvider = false) {
  frames = [];
  child = spawn(process.env.CODEX_BIN || '/usr/local/bin/codex', ['app-server', '--listen', 'stdio://',
    '-c', 'features.code_mode_host=true', ...(originalProvider ? ['-c', 'model_provider="openai"'] : [])], { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    frames.push(frame);
    if (frame.method && frame.id !== undefined) {
      send({ id: frame.id, error: { code: -32601, message: 'No interactive input in qualification' } }); return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error(`${request.method}: ${frame.error.message}`));
    else request.resolve(frame.result);
  });
  await call('initialize', { clientInfo: { name: 'code-ai-inference-qualification', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
}
async function stop() {
  child.stdin.end();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  reader.close();
}
async function turn(model, prompt, expected, tools = false) {
  const after = frames.length;
  const result = await call('turn/start', { threadId: receipt.threadId, model, effort: 'low', input: [{ type: 'text', text: prompt }] });
  const complete = await wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === result.turn.id, after);
  const text = frames.slice(after).filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage').map(frame => frame.params.item.text).join('\n');
  const toolItems = frames.slice(after).filter(frame => frame.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(frame.params?.item?.type));
  if (complete.params.turn.status !== 'completed') {
    throw new Error(`${model}: ${complete.params.turn.status}: ${JSON.stringify(complete.params.turn.error).slice(0,1500)}`);
  }
  assert.ok(text.includes(expected), `${model}: lost continuing context: ${text.slice(0,500)}`);
  if (tools) assert.ok(toolItems.length, `${model}: no native tool execution`);
  receipt.checks.push({ model, turnId: result.turn.id, status: 'completed', context: true, tools: toolItems.map(frame => frame.params.item.type) });
  console.log(`${model}: same-thread continuity OK${tools ? ', tools OK' : ''}`);
}
try {
  if (previous) {
    await start();
    const resumed = await call('thread/resume', { threadId: receipt.threadId, excludeTurns: true });
    assert.equal(resumed.thread.id, receipt.threadId);
  } else {
  await start(legacy);
  const started = await call('thread/start', { model: 'gpt-6.1-sol', cwd: workspace, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false });
  receipt.threadId = started.thread.id;
  await turn('gpt-6.1-sol', `This is a model-switch qualification. Remember code ${marker} and answer it. No tools.`, marker);
  await stop(); await start();
  const migrated = await call('thread/resume', { threadId: receipt.threadId, excludeTurns: true });
  assert.equal(migrated.thread.id, receipt.threadId);
  assert.equal(migrated.modelProvider, legacy ? 'openai' : 'code_ai');
  if (legacy) receipt.existingOpenAiThreadResumed = true;
  }
  for (const model of models) {
    if (receipt.checks.some(check => check.model === model && check.tools?.length)) continue;
    await turn(model, `Keep the same conversation. Run a shell command to compute 17 * 23. ${model.startsWith('deepseek-') ? `Also use apply_patch to create the harmless qualification file ${model}.txt containing only 391 in the current test workspace. Verify it with a shell command.` : 'Do not read files or change anything.'} Then answer with the code from the first message and the arithmetic result.`, marker, true);
    await turn('gpt-6.1-sol', 'After switching providers, answer with the original code and the arithmetic result. No tools.', marker);
  }
  await turn('gpt-6.1-sol', 'Now answer with the original code and the arithmetic result from previous tool output. No tools.', marker);
  await stop(); await start();
  const resumed = await call('thread/resume', { threadId: receipt.threadId, excludeTurns: true });
  assert.equal(resumed.thread.id, receipt.threadId);
  await turn(continuationModel, 'After process restart, answer with the original code and result. No tools.', marker);
  const before = frames.length;
  await call('thread/compact/start', { threadId: receipt.threadId });
  const compacted = await wait(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'contextCompaction'
    || frame.method === 'turn/completed' && (frame.params?.turn?.status !== 'completed' || frame.params?.turn?.error)
    || frame.method === 'error' && frame.params?.willRetry !== true, before);
  if (compacted.method !== 'item/completed') throw new Error(`Native compaction failed: ${JSON.stringify(compacted.params?.turn?.error || compacted.params?.error).slice(0,1500)}`);
  await turn('gpt-6.1-sol', 'After native compaction, answer with the original qualification code and arithmetic result. No tools.', marker);
  receipt.nativeCompaction = true; receipt.passed = true; delete receipt.error;
} catch (error) { receipt.passed = false; receipt.error = error.message; process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) await stop();
  for (const request of pending.values()) clearTimeout(request.timer);
  receipt.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(receipt));
