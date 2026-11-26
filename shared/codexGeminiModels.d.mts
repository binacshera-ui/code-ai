export interface GeminiCodexModel {
  slug: string;
  displayName: string;
  description: string;
  efforts: string[];
}
export const GEMINI_CODEX_MODELS: GeminiCodexModel[];
export function isGeminiCodexModel(model: unknown): boolean;
export function geminiCodexCatalog(template: Record<string, unknown>): Record<string, any>[];
