export const GEMINI_CODEX_MODELS = [
  { slug: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon', description: 'Gemini API · Codex · משימות מורכבות וארוכות', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gemini-4-neon', displayName: 'Gemini 4 Neon', description: 'Gemini API · Codex · עומק ומהירות', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gemini-4-argon', displayName: 'Gemini 4 Argon', description: 'Gemini API · Codex · חשיבה ופיתוח', efforts: ['low', 'medium', 'high'] },
  { slug: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', description: 'Gemini API · Codex · עבודה מהירה', efforts: ['low', 'medium', 'high', 'xhigh'] },
];

export function isGeminiCodexModel(model) {
  return GEMINI_CODEX_MODELS.some(entry => entry.slug === model);
}

export function geminiCodexCatalog(template) {
  return GEMINI_CODEX_MODELS.map(model => ({
    ...template, slug: model.slug, display_name: model.displayName, description: model.description,
    visibility: 'list', supported_in_api: true, priority: 50,
    default_reasoning_level: 'high', supported_reasoning_levels: model.efforts.map(effort => ({ effort, description: effort })),
    supports_reasoning_summaries: false, default_reasoning_summary: 'none',
    support_verbosity: false, default_verbosity: null,
    shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'direct',
    supports_parallel_tool_calls: true, supports_image_detail_original: false,
    supports_search_tool: false, web_search_tool_type: 'text',
    context_window: 1048576, max_context_window: 1048576, effective_context_window_percent: 90,
    auto_compact_token_limit: 850000, comp_hash: null, use_responses_lite: false,
    experimental_supported_tools: [], additional_speed_tiers: [], service_tiers: [],
    available_access_programs: { cyber: [] }, availability_nux: null, upgrade: null,
  }));
}
