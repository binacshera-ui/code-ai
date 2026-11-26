import type { CodexLiveInputStore } from './codexLiveInputStore.mjs';
import type { CodexLiveInputConnection } from './codexLiveInputNative.mjs';
export interface CodexLiveInputReceipt {
  id: string; profileId: string; sessionId: string; clientRequestId: string;
  turnId: string; status: 'delivered'; kind: 'active-turn';
}
export interface CodexLiveInputRequest {
  profileId: string; sessionId: string; clientRequestId: string;
  input: Array<Record<string, unknown>>; contextText: string;
  connectionOptions: {codexHome: string; expectedUid?: number; requestTimeoutMs?: number};
}
export class CodexLiveInputError extends Error {
  code: string; statusCode: number;
  constructor(code: string, message: string, statusCode?: number);
}
export function isCodexLiveInputError(error: unknown): error is CodexLiveInputError;
export function codexLiveInputClientId(requestId: string): string;
export function codexLiveInputPayloadHash(request: CodexLiveInputRequest): string;
export function createCodexLiveInputService(options: {
  store: CodexLiveInputStore;
  connect?: (options: CodexLiveInputRequest['connectionOptions']) => Promise<CodexLiveInputConnection>;
}): {append(request: CodexLiveInputRequest): Promise<CodexLiveInputReceipt | null>};
