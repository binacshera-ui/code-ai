const USER_SELECTABLE_HIDDEN_CODEX_MODELS = new Set(['gpt-reserve']);

/**
 * The Codex CLI marks a small number of entries as hidden even when the
 * account is entitled to call them. Keep those entries out of the picker,
 * except for the explicitly supported reserve model. This avoids exposing
 * internal helper models while preserving a separately metered fallback.
 */
export function isUserSelectableCodexModel(entry: {
  slug?: unknown;
  visibility?: unknown;
}): boolean {
  const visibility = typeof entry.visibility === 'string' ? entry.visibility.trim().toLowerCase() : '';
  if (!['hide', 'hidden'].includes(visibility)) {
    return true;
  }

  const slug = typeof entry.slug === 'string' ? entry.slug.trim().toLowerCase() : '';
  return USER_SELECTABLE_HIDDEN_CODEX_MODELS.has(slug);
}
