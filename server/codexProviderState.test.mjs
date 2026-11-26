import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderStateStore, providerStateScope, filterProviderState, providerStateObserver } from './codexProviderState.mjs';

const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-private-sealed-reasoning', summary: [] };
const scope = (provider, accountId = 'account-a', credential = 'key-a') => providerStateScope({ provider,
  endpoint: `https://${provider}.example/v1`, accountId, credential });

test('sealed state is provider, endpoint and account scoped, not item-ID scoped', t => {
  const store = new ProviderStateStore(); t.after(() => store.close());
  const owner = scope('openai');
  store.record(reasoning, { scope: owner, provider: 'openai', model: 'gpt-fixture' });
  assert.equal(store.owns(reasoning, owner), true);
  assert.equal(store.owns(reasoning, scope('openai', 'account-b')), false);
  assert.equal(store.owns(reasoning, scope('venice')), false);
  assert.equal(store.owns({ ...reasoning, encrypted_content: 'different-state-same-id' }, owner), false);
  assert.equal(scope('openai', 'account-a', 'refreshed-oauth-token'), owner);
  assert.notEqual(scope('venice', null, 'rotated-api-key'), scope('venice', null));
  assert.notEqual(owner, providerStateScope({ provider: 'openai', endpoint: 'https://other.example/v1', accountId: 'account-a' }));
  assert.notEqual(owner, providerStateScope({ provider: 'openai', endpoint: 'https://openai.example/v1',
    accountId: 'account-a', accountHeader: 'different-routing-account' }));
  assert.notEqual(providerStateScope({ provider: 'openai', endpoint: 'https://openai.example/v1',
    credential: 'token-a', accountHeader: 'header-only' }), providerStateScope({ provider: 'openai',
    endpoint: 'https://openai.example/v1', credential: 'token-b', accountHeader: 'header-only' }));
});

test('mixed and legacy histories lose only unverified reasoning, never messages or tool pairs', t => {
  const store = new ProviderStateStore(); t.after(() => store.close());
  const owner = scope('openai');
  const native = { ...reasoning, encrypted_content: 'known-openai' };
  const foreign = { ...reasoning, encrypted_content: 'known-venice' };
  store.record(native, { scope: owner, provider: 'openai' });
  store.record(foreign, { scope: scope('venice'), provider: 'venice' });
  const messages = [{ role: 'user', content: 'original message' },
    { type: 'custom_tool_call', call_id: 'same-call', name: 'apply_patch', input: 'fixture only' },
    { type: 'custom_tool_call_output', call_id: 'same-call', output: 'completed' },
    { role: 'assistant', content: 'observable result' }];
  const original = { input: [reasoning, ...messages, foreign, native] };
  const before = structuredClone(original);
  const result = filterProviderState(original, store, owner);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.body.input, [...messages, native]);
  assert.deepEqual(original, before);
  assert.equal(filterProviderState({ input: [native] }, store, owner).removed, 0);
  assert.equal(filterProviderState({ input: [native] }, store, scope('venice')).removed, 1);
});

test('unknown compacted checkpoints are rejected rather than silently losing history', t => {
  const store = new ProviderStateStore(); t.after(() => store.close());
  const checkpoint = { type: 'compaction', encrypted_content: 'sealed-only-history' };
  assert.throws(() => filterProviderState({ input: [checkpoint] }, store, scope('openai')),
    { code: 'provider_state_checkpoint_mismatch' });
  store.record(checkpoint, { scope: scope('openai'), provider: 'openai' });
  assert.deepEqual(filterProviderState({ input: [checkpoint] }, store, scope('openai')).body.input, [checkpoint]);
});

test('provenance survives restart and contains fingerprints/metadata, never ciphertext or credentials', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'state.sqlite');
  let store = new ProviderStateStore(filename);
  store.record(reasoning, { scope: scope('openai'), provider: 'openai', model: 'gpt-fixture' });
  store.close();
  store = new ProviderStateStore(filename);
  assert.equal(store.owns(reasoning, scope('openai')), true);
  store.close();
  assert.equal((await stat(filename)).mode & 0o077, 0);
  const disk = (await readFile(filename)).toString();
  assert.ok(disk.includes('rs_fixture'));
  assert.ok(!disk.includes(reasoning.encrypted_content));
  assert.ok(!disk.includes('key-a'));
});

test('JSON and arbitrary UTF-8/SSE chunks record sealed output without recording user input', () => {
  const received = [];
  const text = `event: response.output_item.done\r\ndata: ${JSON.stringify({ item: { ...reasoning, summary: [{ text: 'עברית' }] } })}\r\n\r\n`;
  const observer = providerStateObserver('text/event-stream', item => received.push(item));
  for (const byte of Buffer.from(text)) observer.push(Buffer.from([byte]));
  observer.end();
  assert.equal(received.length, 1);
  assert.equal(received[0].summary[0].text, 'עברית');
  const json = providerStateObserver('application/json', item => received.push(item));
  json.push(Buffer.from(JSON.stringify({ output: [reasoning], input: [{ ...reasoning, id: 'not-output' }] })));
  json.end();
  assert.deepEqual(received.map(item => item.id), ['rs_fixture', 'rs_fixture']);
  const multiline = providerStateObserver('text/event-stream', item => received.push(item));
  multiline.push(Buffer.from(`data: {"response":\ndata: ${JSON.stringify({ output: [reasoning] })}}\n\n`));
  multiline.end();
  assert.equal(received.length, 3);
});
