import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createInferenceRouter, openaiRequest, geminiRequest } from './codexInferenceRouter.mjs';

test('native historical tool declarations merge once without losing namespace members or current definitions', () => {
  const old = { type: 'function', name: 'followup_task', parameters: { old: true } };
  const current = { type: 'function', name: 'followup_task', parameters: { current: true } };
  const input = [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'collaboration', tools: [old,
    { type: 'function', name: 'list_agents' }] }] }, { role: 'user', content: 'continue' }];
  const value = geminiRequest({ input, tools: [{ type: 'namespace', name: 'collaboration', tools: [current] }] });
  assert.deepEqual(value.input, [input[1]]);
  assert.equal(value.tools.length, 1);
  assert.deepEqual(value.tools[0].tools.map(tool => tool.name), ['followup_task', 'list_agents']);
  assert.deepEqual(value.tools[0].tools[0], current);
  assert.equal(input[0].tools[0].tools.length, 2, 'native source objects must remain unchanged');
});

test('Gemini signature IDs fit OpenAI limits and call/result pairing survives', () => {
  const id = 'call_' + 'x'.repeat(300);
  const result = openaiRequest({ input: [
    { type: 'function_call', id: 'fc_' + id, call_id: id },
    { type: 'function_call_output', call_id: id },
  ] });
  assert.ok(result.input[0].id.startsWith('fc_'));
  assert.ok(result.input[0].id.length <= 64);
  assert.ok(result.input[0].call_id.length <= 64);
  assert.equal(result.input[0].call_id, result.input[1].call_id);
});

test('one native conversation routes exact GPT bytes and Gemini tool history with isolated credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-router-'));
  const auth = path.join(root, 'auth.json');
  await writeFile(auth, JSON.stringify({ tokens: { access_token: 'fixture-openai-token' } }));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, raw: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const server = createInferenceRouter({ authFiles: [auth], geminiGatewayKey: 'fixture-adapter-token',
    geminiBaseUrl: `${base}/gemini/v1`, openaiBaseUrl: `${base}/backend-api/codex` });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const headers = { Authorization: 'Bearer fixture-openai-token', 'Content-Type': 'application/json', 'ChatGPT-Account-ID': 'fixture-account' };
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  const gpt = '{ "model": "gpt-6.1-sol", "input": [{"role":"user","content":"hello"}], "stream": true }';
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: gpt })).status, 200);
  assert.equal(calls[0].body, gpt);
  assert.equal(calls[0].url, '/backend-api/codex/responses');
  assert.equal(calls[0].headers.authorization, headers.Authorization);
  const input = [{ type: 'reasoning', encrypted_content: 'opaque-openai' },
    { type: 'function_call', name: 'read_file', call_id: 'call-one', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-one', output: 'same-session-fact' }];
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: 'gemini-4-neon', input, stream: true,
    service_tier: 'priority', prompt_cache_key: 'openai-only', reasoning: { effort: 'high', summary: 'auto' } }) })).status, 200);
  const gemini = JSON.parse(calls[1].body);
  assert.equal(calls[1].url, '/gemini/v1/responses');
  assert.deepEqual(gemini.input, input.slice(1));
  assert.deepEqual(gemini.reasoning, { effort: 'high' });
  assert.equal(calls[1].headers.authorization, 'Bearer fixture-adapter-token');
  assert.equal(calls[1].headers['chatgpt-account-id'], undefined);
  assert.equal(gemini.service_tier, undefined);
  assert.equal(gemini.prompt_cache_key, undefined);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{"model":"gemini-unknown"}' })).status, 400);
  const compressedGpt = zlib.zstdCompressSync(Buffer.from(gpt));
  const compressedHeaders = { ...headers, 'Content-Encoding': 'zstd' };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: compressedHeaders, body: compressedGpt })).status, 200);
  assert.equal(calls[2].headers['content-encoding'], 'zstd');
  assert.deepEqual(calls[2].raw, compressedGpt);
  const compressedGemini = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gemini-4-neon', input })));
  assert.equal((await fetch(endpoint, { method: 'POST', headers: compressedHeaders, body: compressedGemini })).status, 200);
  assert.equal(calls[3].headers['content-encoding'], undefined);
  assert.equal(JSON.parse(calls[3].body).model, 'gemini-4-neon');
  const longId = 'call_' + 'x'.repeat(300);
  const crossProvider = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', input: [{ type: 'function_call_output', call_id: longId, output: 'ok' }] })));
  assert.equal((await fetch(endpoint, { method: 'POST', headers: compressedHeaders, body: crossProvider })).status, 200);
  assert.equal(calls[4].headers['content-encoding'], undefined);
  assert.ok(JSON.parse(calls[4].body).input[0].call_id.length <= 64);
});
