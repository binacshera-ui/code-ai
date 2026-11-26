export interface CodexApiPrices {
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cacheWriteUsdPerMillion: number | null;
}
export interface CodexApiModel {
  slug: string;
  displayName: string;
  description: string;
  family: 'gemini' | 'deepseek';
  provider: 'gemini' | 'venice' | 'experiential';
  upstreamModel: string;
  apiBase?: string;
  protocol: 'responses' | 'responses-adapter';
  credentialEnv: string;
  efforts: string[];
  defaultEffort: string;
  contextWindow: number;
  maxOutputTokens?: number;
  vision?: boolean;
  inputModalities?: string[];
  maxImages?: number;
  prices?: CodexApiPrices;
  catalogSource?: string;
  catalogVerifiedAt?: string;
}
export const DEEPSEEK_CODEX_MODELS: CodexApiModel[];
export const CODEX_API_MODELS: CodexApiModel[];
export function getCodexApiModel(model: unknown): CodexApiModel | null;
export function isCodexApiModel(model: unknown): boolean;
export function isDeepseekCodexModel(model: unknown): boolean;
export function codexModelFamily(model: unknown): 'gpt' | 'gemini' | 'deepseek';
export function deepseekCodexCatalog(template: Record<string, unknown>): Record<string, any>[];
export function codexApiCatalog(template: Record<string, unknown>): Record<string, any>[];
