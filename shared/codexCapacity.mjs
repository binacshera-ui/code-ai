// Match only the provider's complete terminal error, never a mention in prose.
export const CODEX_MODEL_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';
export function isCodexModelCapacityMessage(value) {
  return typeof value === 'string' && value.trim() === CODEX_MODEL_CAPACITY_MESSAGE;
}
