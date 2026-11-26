import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexCatalogAccountScope, refreshCodexAccountModels } from './codexAccountModels.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'code-ai-model-entitlements-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const authenticate = (id: string) => writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, access_token: 'fixture-not-a-real-token' } }));
  await authenticate('fixture-pro-max');
  await writeFile(path.join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(path.join(home, 'code-ai-models.json'))}\n`);
  const alias = { slug: 'gemini-4-neon', service_tiers: [] };
  await writeFile(path.join(home, 'code-ai-models.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', additional_speed_tiers: ['fast'] }, alias] }));
  const model = { slug: 'gpt-6.1-sol', additional_speed_tiers: ['fast', 'ultrafast'], service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }], originalMetadata: { preserved: true } };
  return { home, alias, model, authenticate, read: async () => JSON.parse(await readFile(path.join(home, 'code-ai-models.json'), 'utf8')) };
}
test('refreshes stale native metadata while preserving Gemini and all vendor fields', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), { fetchImpl: async (url, init) => {
    calls++; assert.ok(String(url).includes('/codex/models?client_version='));
    assert.equal((init?.headers as any)['ChatGPT-Account-ID'], 'fixture-pro-max');
    return Response.json({ models: [f.model] });
  } });
  assert.equal(calls, 1); assert.deepEqual(result, [f.model]);
  assert.deepEqual((await f.read()).models, [f.model, f.alias]);
});
test('account refresh preserves both registered DeepSeek suppliers but never retains guessed API aliases', async t => {
  const f = await fixture(t);
  const deepseek = ['deepseek-v4.1-flash-venice', 'deepseek-v4.1-flash-experiential']
    .map(slug => ({ slug, service_tiers: [], input_modalities: slug.endsWith('venice') ? ['text', 'image'] : ['text'] }));
  await writeFile(path.join(f.home, 'code-ai-models.json'), JSON.stringify({ models: [f.alias, ...deepseek,
    { slug: 'gemini-unknown' }, { slug: 'deepseek-fake' }, { slug: 'gpt-retired' }] }));
  await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), {
    fetchImpl: async () => Response.json({ models: [f.model] }),
  });
  assert.deepEqual((await f.read()).models, [f.model, f.alias, ...deepseek]);
});
test('a new unentitled account removes old Ultrafast metadata, rather than inheriting the prior subscription', async t => {
  const f = await fixture(t);
  await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), { fetchImpl: async () => Response.json({ models: [f.model] }) });
  const previous = await readCodexCatalogAccountScope(f.home);
  await f.authenticate('fixture-no-ultrafast');
  const next = await readCodexCatalogAccountScope(f.home); assert.notEqual(next, previous);
  const plain = { ...f.model, additional_speed_tiers: ['fast'], service_tiers: [{ id: 'priority' }] };
  await refreshCodexAccountModels(f.home, next, { fetchImpl: async () => Response.json({ models: [plain] }) });
  assert.deepEqual((await f.read()).models, [plain, f.alias]);
});
test('account rotation during a response cannot publish old entitlements; failed lookup grants nothing', async t => {
  const f = await fixture(t), before = await f.read();
  const result = await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), { fetchImpl: async () => {
    await f.authenticate('fixture-replacement'); return Response.json({ models: [f.model] });
  } });
  assert.equal(result, null); assert.deepEqual(await f.read(), before);
  assert.equal(await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), { fetchImpl: async () => new Response('', { status: 403 }) }), null);
});
test('API-key authentication never borrows stored ChatGPT subscription credentials', async t => {
  const f = await fixture(t); let calls = 0;
  await writeFile(path.join(f.home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key', tokens: { account_id: 'old', access_token: 'old' } }));
  assert.equal(await refreshCodexAccountModels(f.home, await readCodexCatalogAccountScope(f.home), { fetchImpl: async () => { calls++; return Response.json({ models: [f.model] }); } }), null);
  assert.equal(calls, 0);
});
