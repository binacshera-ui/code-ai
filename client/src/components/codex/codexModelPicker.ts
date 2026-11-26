import { isDeepseekCodexModel } from '../../../../shared/codexApiModels.mjs';
import { isGeminiCodexModel } from '../../../../shared/codexGeminiModels.mjs';

export type CodexModelFamily = 'gpt' | 'gemini' | 'deepseek';

const MODEL_FAMILIES: readonly CodexModelFamily[] = ['gpt', 'gemini', 'deepseek'];

export const CODEX_MODEL_FAMILY_LABELS: Record<CodexModelFamily, string> = {
  gpt: 'GPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
};

export function codexModelFamily(slug: string | null | undefined): CodexModelFamily {
  if (isGeminiCodexModel(slug)) return 'gemini';
  if (isDeepseekCodexModel(slug)) return 'deepseek';
  return 'gpt';
}

export function availableCodexModelFamilies(models: readonly { slug: string }[]): CodexModelFamily[] {
  const present = new Set(models.map(model => codexModelFamily(model.slug)));
  return MODEL_FAMILIES.filter(family => present.has(family));
}

/** A family left open on another profile must not hide this profile's catalog. */
export function resolveCodexModelFamily(
  availableFamilies: readonly CodexModelFamily[],
  selectedModel: string | null,
  filter: CodexModelFamily | null,
): CodexModelFamily {
  if (filter && availableFamilies.includes(filter)) return filter;
  const selectedFamily = codexModelFamily(selectedModel);
  return availableFamilies.includes(selectedFamily) ? selectedFamily : availableFamilies[0] || 'gpt';
}
