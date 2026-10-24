export const CODEX_PROGRESS_GUARD_INSTRUCTION: string;
export function createCodexProgressGuard(options?: { threshold?: number; maxInterventions?: number }): {
  observeItem(item: unknown): { kind: 'repeated_failure'; fingerprint: string; count: number; instruction: string } | null;
};
