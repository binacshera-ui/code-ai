/** Registered API models on the existing Codex transport.
 * Billing exemptions and provider routing must use exact aliases from here,
 * never a user-controlled model-name prefix. No credentials belong in this file.
 */
import { GEMINI_CODEX_MODELS, geminiCodexCatalog } from './codexGeminiModels.mjs';

// Supplier catalogs checked on 2026-11-26. These are separate paid API routes,
// even when both suppliers serve the same underlying DeepSeek model family.
export const DEEPSEEK_CODEX_MODELS = [
  {
    slug: 'deepseek-v4.1-flash-venice',
    displayName: 'DeepSeek V4.1 Flash · Venice',
    description: 'Venice API · Codex · טקסט ותמונות · ללא סינון',
    family: 'deepseek', provider: 'venice',
    upstreamModel: 'deepseek-v4-1-flash-1017-uncensored',
    apiBase: 'https://api.venice.ai/api/v1', protocol: 'responses', credentialEnv: 'VENICE_API_KEY',
    efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high',
    contextWindow: 1_000_000, maxOutputTokens: 131_072,
    vision: true, inputModalities: ['text', 'image'], maxImages: 10,
    prices: { inputUsdPerMillion: 0.33, cachedInputUsdPerMillion: 0.00825,
      outputUsdPerMillion: 1.32, cacheWriteUsdPerMillion: null },
    catalogSource: 'https://api.venice.ai/api/v1/models',
    catalogVerifiedAt: '2026-11-26',
  },
  {
    slug: 'deepseek-v4.1-flash-experiential',
    displayName: 'DeepSeek V4.1 Flash · Experiential',
    description: 'Experiential Labs API · Codex · טקסט בלבד · ללא סינון',
    family: 'deepseek', provider: 'experiential',
    upstreamModel: 'deepseek-v4.1-flash-uncensored',
    apiBase: 'https://api.experientiallabs.ai/v1', protocol: 'responses', credentialEnv: 'EXPLABS_API_KEY',
    efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high',
    contextWindow: 1_048_576, maxOutputTokens: 393_216,
    vision: false, inputModalities: ['text'], maxImages: 0,
    prices: { inputUsdPerMillion: 0.225, cachedInputUsdPerMillion: 0.0225,
      outputUsdPerMillion: 0.9, cacheWriteUsdPerMillion: 0.225 },
    catalogSource: 'https://api.experientiallabs.ai/v1/models',
    catalogVerifiedAt: '2026-11-26',
  },
];

export const CODEX_API_MODELS = [
  ...GEMINI_CODEX_MODELS.map(model => ({
    ...model, family: 'gemini', provider: 'gemini', upstreamModel: model.slug,
    protocol: 'responses-adapter', credentialEnv: 'GEMINI_API_KEY', defaultEffort: 'high',
    contextWindow: 1_048_576,
  })),
  ...DEEPSEEK_CODEX_MODELS,
];

const bySlug = new Map(CODEX_API_MODELS.map(model => [model.slug, model]));
export function getCodexApiModel(model) { return typeof model === 'string' ? bySlug.get(model) || null : null; }
export function isCodexApiModel(model) { return getCodexApiModel(model) !== null; }
export function isDeepseekCodexModel(model) { return getCodexApiModel(model)?.family === 'deepseek'; }
export function codexModelFamily(model) { return getCodexApiModel(model)?.family || 'gpt'; }

export function deepseekCodexCatalog(template) {
  return DEEPSEEK_CODEX_MODELS.map(model => ({
    ...template, slug: model.slug, display_name: model.displayName, description: model.description,
    visibility: 'list', supported_in_api: true, priority: 60,
    default_reasoning_level: model.defaultEffort,
    supported_reasoning_levels: model.efforts.map(effort => ({ effort, description: effort })),
    supports_reasoning_summaries: false, default_reasoning_summary: 'none',
    support_verbosity: false, default_verbosity: null,
    shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'direct',
    supports_parallel_tool_calls: true, supports_reasoning_effort_updates: true,
    input_modalities: [...model.inputModalities], supports_image_detail_original: false,
    supports_search_tool: false, web_search_tool_type: 'text',
    context_window: model.contextWindow, max_context_window: model.contextWindow,
    effective_context_window_percent: 90,
    auto_compact_token_limit: Math.min(Math.floor(model.contextWindow * 0.85), model.contextWindow - model.maxOutputTokens),
    comp_hash: null, use_responses_lite: false, prefer_websockets: false,
    multi_agent_reasoning_effort: model.defaultEffort,
    experimental_supported_tools: [], additional_speed_tiers: [], service_tiers: [],
    available_access_programs: { cyber: [] }, availability_nux: null, upgrade: null,
  }));
}

export function codexApiCatalog(template) {
  return [...geminiCodexCatalog(template), ...deepseekCodexCatalog(template)];
}
