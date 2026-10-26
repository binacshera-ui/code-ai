/** An omitted limit requests the complete summary catalog, not a partial page.
 * Explicit limits remain bounded for existing paged/picker callers. */
export function sessionListLimit(limit?: number, allowExtendedLimit = false): number {
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(limit)) return 500;
  return Math.max(0, Math.min(Math.floor(limit), allowExtendedLimit ? Number.MAX_SAFE_INTEGER : 500));
}
