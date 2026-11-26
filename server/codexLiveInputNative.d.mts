export class CodexLiveInputNativeError extends Error {
  code: number | string;
  nativeRejected: boolean;
  admission: 'notAccepted' | null;
  constructor(options?: {code?: number | string; rejected?: boolean; admission?: 'notAccepted' | null});
}
export interface CodexLiveInputConnection {
  rpc(method: string, params: Record<string, unknown>): Promise<any>;
  close(): void | Promise<void>;
}
export function connectCodexLiveInput(options: {codexHome: string; expectedUid?: number; requestTimeoutMs?: number}): Promise<CodexLiveInputConnection>;
