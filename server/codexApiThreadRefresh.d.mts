export function refreshCodexApiThread<T>(options: {
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  threadResult: T;
  model: unknown;
  recovery?: boolean;
  managedOwner?: boolean;
  /** Trusted absolute catalog path already configured for this native owner. */
  catalogFile?: string | null;
}): Promise<T>;
