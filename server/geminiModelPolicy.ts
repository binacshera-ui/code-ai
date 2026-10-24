import type { CodexReasoningLevelOption } from './codexService.js';

/** Shared default for chat, support and every Gemini specialist feature. */
export const GEMINI_PRIMARY_MODEL = 'gemini-4-argon';
const MIGRATED_PRO_MODELS = new Set(['gemini-3.1-pro-preview', 'gemini-3-pro-preview']);

export const GEMINI_ARGON_REASONING_LEVELS: CodexReasoningLevelOption[] = [
  { effort: 'low', description: 'חשיבה קצרה' },
  { effort: 'medium', description: 'חשיבה מאוזנת' },
  { effort: 'high', description: 'חשיבה מעמיקה' },
];

/** Preserve deliberate other model choices; upgrade cached Gemini Pro choices. */
export function resolveGeminiRunModel(model?: string | null): string {
  const requested = model?.trim();
  return !requested || MIGRATED_PRO_MODELS.has(requested) ? GEMINI_PRIMARY_MODEL : requested;
}

export function geminiThinkingConfig(model: string, effort: string): {
  thinkingLevel?: 'low' | 'medium' | 'high';
  thinkingBudget?: number;
} {
  if (model === GEMINI_PRIMARY_MODEL) {
    // Older queued/UI values remain executable with the supported Argon levels.
    const thinkingLevel = effort === 'none' || effort === 'low' ? 'low'
      : effort === 'max' || effort === 'high' ? 'high' : 'medium';
    return { thinkingLevel };
  }
  const budgets: Record<string, number> = { none: 0, low: 512, medium: 2048, high: 8192, max: 16384 };
  return { thinkingBudget: budgets[effort] ?? budgets.medium };
}
