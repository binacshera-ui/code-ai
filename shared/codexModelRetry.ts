/** Durable retry intent. Never contains provider text, credentials or prompts. */
export interface CodexModelRetry {
  turnId: string;
  kind: 'rate_limit' | 'model_capacity';
  detectedAt: string;
  retryAt: string;
}

export function normalizeCodexModelRetry(value: unknown): CodexModelRetry | null {
  const r = value as CodexModelRetry | null;
  return r && typeof r.turnId === 'string' && /^[A-Za-z0-9._:-]{1,240}$/.test(r.turnId)
    && ['rate_limit', 'model_capacity'].includes(r.kind)
    && typeof r.detectedAt === 'string' && typeof r.retryAt === 'string'
    && Number.isFinite(Date.parse(r.detectedAt)) && Date.parse(r.retryAt) - Date.parse(r.detectedAt) === 60_000
    ? { turnId: r.turnId, kind: r.kind, detectedAt: r.detectedAt, retryAt: r.retryAt } : null;
}
