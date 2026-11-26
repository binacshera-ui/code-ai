import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createInferenceRouter, openaiRequest, geminiRequest, deepseekRequest, numericProviderUsage } from './codexInferenceRouter.mjs';

test('direct DeepSeek keeps sealed reasoning and custom tool history without mutating native transcript', () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'sealed-provider-thought', summary: [] };
  const call = { type: 'custom_tool_call', call_id: 'call-one', name: 'apply_patch', input: 'fixture patch' };
  const result = { type: 'custom_tool_call_output', call_id: 'call-one', output: 'done' };
  const original = { model: 'deepseek-v4.1-flash-venice', input: [reasoning, call, result,
    { type: 'additional_tools', tools: [{ type: 'custom', name: 'apply_patch' }] }],
    service_tier: 'ultrafast', prompt_cache_key: 'openai-cache', include: ['reasoning.encrypted_content'], store: true };
  const value = deepseekRequest(original);
  assert.equal(value.model, 'deepseek-v4-1-flash-1017-uncensored');
  assert.deepEqual(value.input, [reasoning, call, result]);
  assert.deepEqual(value.include, original.include);
  assert.equal(value.tools[0].name, 'apply_patch');
  assert.equal(value.store, false);
  assert.equal(value.service_tier, undefined);
  assert.equal(value.prompt_cache_key, undefined);
  assert.deepEqual(value.venice_parameters, { include_venice_system_prompt: false });
  assert.equal(original.input.length, 4);
  assert.equal(original.store, true);
  const longId = 'call_' + 'signature'.repeat(100);
  const long = deepseekRequest({ model: 'deepseek-v4.1-flash-experiential', input: [
    { type: 'function_call', id: 'fc_' + longId, call_id: longId, name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: longId, output: 'done' },
  ] });
  assert.ok(long.input[0].id.length <= 64);
  assert.equal(long.input[0].call_id, long.input[1].call_id);
  const custom = openaiRequest({ input: [{ type: 'custom_tool_call', id: 'fc_experiential-call', call_id: 'call-stable' },
    { type: 'custom_tool_call_output', call_id: 'call-stable', output: 'done' }] });
  assert.match(custom.input[0].id, /^ctc_/);
  assert.equal(custom.input[0].call_id, custom.input[1].call_id);
  const thought = openaiRequest({ input: [
    { type: 'reasoning', id: 'rs_gateway-summary', summary: [{ type: 'summary_text', text: 'summary only' }] },
    { type: 'reasoning', id: 'rs_native', encrypted_content: 'sealed-native-thought' },
    { role: 'assistant', content: 'observable result' },
  ] });
  assert.equal(thought.input.length, 2);
  assert.equal(thought.input[0].id, 'rs_native');
  assert.throws(() => deepseekRequest({ model: 'deepseek-unknown' }));
});

test('numeric usage preserves unknown cache telemetry and never records content', () => {
  assert.deepEqual(numericProviderUsage({ input_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    unreported_token_details: ['cached_tokens'], secret: 'do-not-log', cost: 0.01 }), {
    input_tokens: 20, input_tokens_details: { cache_write_tokens: 0 }, cost: 0.01, unreported_token_details: ['cached_tokens'],
  });
});

test('both direct provider routes isolate credentials, retain SSE and reject unregistered models', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-deepseek-router-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = path.join(root, 'auth.json');
  await writeFile(auth, JSON.stringify({ tokens: { access_token: 'fixture-openai-secret', account_id: 'fixture-account' } }));
  const calls = [], logs = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":200,"input_tokens_details":{"cached_tokens":100},"output_tokens":10},"output_text":"private-content"}}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const server = createInferenceRouter({ authFiles: [auth], providerKeys: { VENICE_API_KEY: 'fixture-venice-secret', EXPLABS_API_KEY: 'fixture-explabs-secret' },
    providerBaseUrls: { venice: `${base}/venice/v1`, experiential: `${base}/experiential/v1` } }, { logger: e => logs.push(e) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const headers = { Authorization: 'Bearer fixture-openai-secret', 'Content-Type': 'application/json', 'ChatGPT-Account-ID': 'fixture-account', session_id: 'fixture-thread', 'Content-Encoding': 'gzip' };
  for (const model of ['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']) {
    const r = await fetch(endpoint, { method: 'POST', headers, body: zlib.gzipSync(Buffer.from(JSON.stringify({ model, input: [], stream: true }))) });
    assert.equal(r.status, 200); assert.match(await r.text(), /response.completed/);
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/venice/v1/responses');
  assert.equal(calls[0].headers.authorization, 'Bearer fixture-venice-secret');
  assert.equal(calls[1].url, '/experiential/v1/responses');
  assert.equal(calls[1].headers.authorization, 'Bearer fixture-explabs-secret');
  assert.equal(calls[1].body.model, 'deepseek-v4.1-flash-uncensored');
  for (const call of calls) {
    assert.equal(call.headers['chatgpt-account-id'], undefined);
    assert.equal(call.headers.session_id, undefined);
    assert.equal(call.headers['content-encoding'], undefined);
  }
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private-content|fixture-.*secret|fixture-thread/);
  const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{"model":"deepseek-unknown"}' });
  assert.equal(r.status, 400); assert.equal(calls.length, 2);
});

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

test('native image generation and multipart editing retain bytes, account auth and provider errors', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-image-router-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auth = path.join(root, 'auth.json');
  await writeFile(auth, JSON.stringify({ tokens: { access_token: 'fixture-image-token' } }));
  const calls = [], events = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
    if (req.url.includes('failure')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end('{"error":{"code":"rate_limit_exceeded"}}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data":[');
      setImmediate(() => res.end('{"b64_json":"fixture"}]}'));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const server = createInferenceRouter({ authFiles: [auth], geminiGatewayKey: 'fixture-google-secret',
    geminiBaseUrl: `${base}/gemini/v1`, openaiBaseUrl: `${base}/backend-api/codex` },
  { logger: event => events.push(event) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/images`;
  const headers = { Authorization: 'Bearer fixture-image-token', 'ChatGPT-Account-ID': 'fixture-account' };
  assert.equal((await fetch(`${endpoint}/generations`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${endpoint}/edits`, { headers })).status, 405);
  assert.equal((await fetch(`${endpoint}/unknown`, { method: 'POST', headers })).status, 404);
  assert.equal(calls.length, 0);

  // Image models never select the Gemini chat adapter, even if the body names
  // one. OpenAI owns validation of this opaque native image request.
  const generated = zlib.gzipSync(Buffer.from('{ "model":"gemini-4-neon", "prompt":"private fixture prompt" }'));
  const generation = await fetch(`${endpoint}/generations?quality=high`, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: generated });
  assert.deepEqual(await generation.json(), { data: [{ b64_json: 'fixture' }] });
  assert.equal(calls[0].url, '/backend-api/codex/images/generations?quality=high');
  assert.equal(calls[0].headers['content-encoding'], 'gzip');
  assert.deepEqual(calls[0].raw, generated);

  const boundary = 'fixture-native-image-boundary';
  const edited = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([137, 80, 78, 71, 0, 255, 128, 13, 10]), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const edit = await fetch(`${endpoint}/edits`, { method: 'POST',
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: edited });
  assert.equal(edit.status, 200);
  await edit.arrayBuffer();
  assert.equal(calls[1].url, '/backend-api/codex/images/edits');
  assert.equal(calls[1].headers['content-type'], `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(calls[1].raw, edited);
  for (const call of calls) {
    assert.equal(call.headers.authorization, headers.Authorization);
    assert.equal(call.headers['chatgpt-account-id'], 'fixture-account');
    assert.equal(Number(call.headers['content-length']), call.raw.length);
  }

  const failed = await fetch(`${endpoint}/generations?failure=1`, { method: 'POST', headers, body: '{}' });
  assert.equal(failed.status, 429);
  assert.equal(failed.headers.get('retry-after'), '5');
  assert.deepEqual(await failed.json(), { error: { code: 'rate_limit_exceeded' } });
  assert.equal(calls.length, 3, 'paid image submissions must never be retried by the router');
  assert.equal(events.filter(event => event.event === 'inference.image.started').length, 3);
  const finished = events.filter(event => event.event === 'inference.image.finished');
  assert.deepEqual(finished.map(event => event.status), [200, 200, 429]);
  assert.ok(finished.every(event => event.completed && event.durationMs >= 0));
  for (const event of finished) assert.ok(events.some(start => start.event === 'inference.image.started' && start.requestId === event.requestId));
  assert.doesNotMatch(JSON.stringify(events), /private fixture prompt|fixture-image-token|fixture-google-secret|source\.png/);
});
