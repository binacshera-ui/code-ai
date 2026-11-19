#!/usr/bin/env node
// Real provider verification with disposable files, never production conversations.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './runtime-paths.mjs';

const root = await resolveRuntime();
const workspace = path.join(root, 'workspace');
const evidence = path.join(root, 'evidence');
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--mcp-server') {
  const { createInterface } = await import('node:readline');
  const reader = createInterface({ input: process.stdin });
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  for await (const line of reader) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'isolated-codex-gemini-probe', version: '1.0.0' },
    };
    else if (request.method === 'tools/list') result = { tools: [{
      name: 'checksum_file', description: 'Compute SHA256 of probe.txt in this disposable test workspace.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }] };
    else if (request.method === 'tools/call') {
      const filename = request.params?.arguments?.filename;
      await appendFile(path.join(evidence, 'mcp-calls.jsonl'), JSON.stringify({ runId: process.argv[3], name: request.params?.name, filename }) + '\n', { mode: 0o600 });
      result = filename !== 'probe.txt'
        ? { isError: true, content: [{ type: 'text', text: 'Unknown fixture filename. The available file is probe.txt.' }] }
        : { content: [{ type: 'text', text: createHash('sha256').update(await readFile(path.join(workspace, 'probe.txt'))).digest('hex') }] };
    } else if (request.method === 'ping') result = {};
    else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); continue; }
    send({ jsonrpc: '2.0', id: request.id, result });
  }
  process.exit(0);
}

const runId = randomUUID();
const receipt = { runId, startedAt: new Date().toISOString(), model: 'gemini-4-argon', turns: [] };
const launcher = path.join(path.dirname(self), 'run.mjs');
const shared = [
  '-c', `mcp_servers.isolated_probe.command=${JSON.stringify(process.execPath)}`,
  '-c', `mcp_servers.isolated_probe.args=${JSON.stringify([self, '--mcp-server', runId])}`,
  '-c', 'mcp_servers.isolated_probe.required=true',
];

async function turn(name, args, prompt) {
  const started = Date.now();
  const child = spawn(process.execPath, [launcher, ...args, ...shared, prompt], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  for (const [suffix, text] of [['jsonl', stdout], ['stderr', stderr]]) {
    const file = path.join(evidence, `${runId}-${name}.${suffix}`);
    await writeFile(file, text, { mode: 0o600 }); await chmod(file, 0o600);
  }
  const events = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const row = {
    name, exitCode: code, timedOut, elapsedMs: Date.now() - started,
    threadId: events.find(event => event.type === 'thread.started')?.thread_id,
    types: [...new Set(events.map(event => event.type))],
    itemTypes: [...new Set(events.filter(event => event.item).map(event => event.item.type))],
    usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage),
    errors: events.filter(event => event.type === 'error' || event.type === 'turn.failed').map(event => event.message || event.error),
  };
  receipt.turns.push(row); console.log(JSON.stringify(row));
  if (code !== 0 || timedOut || !events.some(event => event.type === 'turn.completed')) {
    console.log('Failure detail:', stderr.slice(-3000));
    throw new Error(`Isolated ${name} did not complete; private transcript is in ${evidence}`);
  }
  return { row, events };
}

try {
  const first = await turn('tools', ['exec', '--json', '--skip-git-repo-check', '-C', workspace],
    `This is a bounded integration check in a disposable directory. Read probe.txt using a shell tool. Also run node -e 'if(process.env.GEMINI_API_KEY || process.env.CODEX_GEMINI_GATEWAY_KEY) process.exit(1); console.log("SECRET_ENV_CLEAN")' to confirm credentials are absent from the tool environment; never read or display any credentials. Call MCP isolated_probe checksum_file first with missing.txt, then recover using probe.txt. Use the native apply_patch tool to create or update verified.txt containing exactly HARNESS_OK ${runId} 391 and a newline. Then report the actual SHA256 returned by MCP. Do only these checks.`);
  assert.ok(first.row.threadId, 'Native thread ID is persisted');
  assert.equal((await readFile(path.join(workspace, 'verified.txt'), 'utf8')).trim(), `HARNESS_OK ${runId} 391`);
  assert.ok(first.events.some(event => event.type === 'item.completed' && event.item?.type === 'command_execution'
    && event.item.exit_code === 0 && event.item.aggregated_output?.includes('SECRET_ENV_CLEAN')));
  const calls = (await readFile(path.join(evidence, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(call => call.runId === runId);
  assert.ok(calls.some(call => call.filename === 'missing.txt'));
  assert.ok(calls.some(call => call.filename === 'probe.txt'));
  const resumed = await turn('resume', ['exec', 'resume', '--json', '--skip-git-repo-check', first.row.threadId],
    `Continue the same integration check after restarting Codex. Without reading any file or calling tools, state the run identifier from the file you just created and the arithmetic result. Then answer CONTINUITY_OK. Do not make other changes.`);
  const answer = resumed.events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text).join('\n');
  assert.equal(resumed.row.threadId, first.row.threadId);
  assert.ok(answer.includes(runId) && answer.includes('391') && answer.includes('CONTINUITY_OK'));
  assert.ok(!resumed.row.itemTypes.includes('command_execution') && !resumed.row.itemTypes.includes('mcp_tool_call'));
  receipt.passed = true;
} catch (error) { receipt.passed = false; receipt.error = error.message; process.exitCode = 1; }
receipt.finishedAt = new Date().toISOString();
await writeFile(path.join(evidence, `${runId}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(evidence, `${runId}-receipt.json`), error: receipt.error }));
