import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInferenceRouter, openaiRequest } from './codexInferenceRouter.mjs';

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
    calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
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
});
