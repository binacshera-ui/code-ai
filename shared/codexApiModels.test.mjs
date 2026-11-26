import assert from 'node:assert/strict';
import test from 'node:test';
import { GEMINI_CODEX_MODELS, geminiCodexCatalog } from './codexGeminiModels.mjs';
import { CODEX_API_MODELS, DEEPSEEK_CODEX_MODELS, getCodexApiModel, isCodexApiModel,
  isDeepseekCodexModel, codexModelFamily, codexApiCatalog, deepseekCodexCatalog } from './codexApiModels.mjs';

test('billing and routing registry recognizes exact aliases only', () => {
  assert.equal(CODEX_API_MODELS.length, 6);
  assert.equal(new Set(CODEX_API_MODELS.map(model => model.slug)).size, 6);
  for (const model of CODEX_API_MODELS) {
    assert.equal(isCodexApiModel(model.slug), true);
    assert.equal(getCodexApiModel(model.slug), model);
    assert.equal(codexModelFamily(model.slug), model.family);
    assert.equal(isDeepseekCodexModel(model.slug), model.family === 'deepseek');
  }
  for (const model of [undefined, null, '', {}, 'gpt-6.1-sol', 'gemini-fake', 'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-venice-fake', 'Deepseek-v4.1-flash-venice', 'deepseek-v4-1-flash-1017-uncensored']) {
    assert.equal(isCodexApiModel(model), false);
    assert.equal(isDeepseekCodexModel(model), false);
    assert.equal(getCodexApiModel(model), null);
  }
});

test('managed catalog preserves Gemini behavior and isolates provider capabilities from the GPT template', () => {
  const template = { slug: 'gpt-fixture', service_tiers: [{ id: 'ultrafast' }], additional_speed_tiers: ['fast'],
    default_reasoning_level: 'ultra', multi_agent_reasoning_effort: 'xhigh', supports_search_tool: true,
    prefer_websockets: true, input_modalities: ['text', 'image'], comp_hash: 'openai-only',
    context_window: 50, model_messages: { instructions_template: 'stable harness instructions' } };
  const catalog = codexApiCatalog(template);
  assert.deepEqual(catalog.slice(0, GEMINI_CODEX_MODELS.length), geminiCodexCatalog(template));
  const [venice, experiential] = deepseekCodexCatalog(template);
  assert.equal(venice.context_window, 1_000_000);
  assert.equal(experiential.context_window, 1_048_576);
  assert.deepEqual(venice.input_modalities, ['text', 'image']);
  assert.deepEqual(experiential.input_modalities, ['text']);
  for (const row of [venice, experiential]) {
    assert.deepEqual(row.service_tiers, []);
    assert.deepEqual(row.additional_speed_tiers, []);
    assert.deepEqual(row.supported_reasoning_levels.map(level => level.effort), ['none', 'low', 'high', 'max']);
    assert.equal(row.default_reasoning_level, 'high');
    assert.equal(row.multi_agent_reasoning_effort, 'high');
    assert.equal(row.supports_search_tool, false);
    assert.equal(row.prefer_websockets, false);
    assert.equal(row.comp_hash, null);
    assert.deepEqual(row.model_messages, template.model_messages, 'the existing harness instructions remain available');
    const metadata = getCodexApiModel(row.slug);
    assert.ok(row.auto_compact_token_limit + metadata.maxOutputTokens <= metadata.contextWindow);
  }
  assert.equal(template.comp_hash, 'openai-only');
  assert.equal(template.input_modalities.length, 2);
});

test('supplier routes, independent credential names and catalog rates remain unambiguous', () => {
  const [venice, experiential] = DEEPSEEK_CODEX_MODELS;
  assert.equal(venice.upstreamModel, 'deepseek-v4-1-flash-1017-uncensored');
  assert.equal(venice.apiBase, 'https://api.venice.ai/api/v1');
  assert.equal(venice.credentialEnv, 'VENICE_API_KEY');
  assert.equal(experiential.upstreamModel, 'deepseek-v4.1-flash-uncensored');
  assert.equal(experiential.apiBase, 'https://api.experientiallabs.ai/v1');
  assert.equal(experiential.credentialEnv, 'EXPLABS_API_KEY');
  assert.ok(DEEPSEEK_CODEX_MODELS.every(model => model.protocol === 'responses'));
  assert.deepEqual(venice.prices, { inputUsdPerMillion: 0.33, cachedInputUsdPerMillion: 0.00825,
    outputUsdPerMillion: 1.32, cacheWriteUsdPerMillion: null });
  assert.deepEqual(experiential.prices, { inputUsdPerMillion: 0.225, cachedInputUsdPerMillion: 0.0225,
    outputUsdPerMillion: 0.9, cacheWriteUsdPerMillion: 0.225 });
});
