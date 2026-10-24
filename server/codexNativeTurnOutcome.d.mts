import type { CodexFailureKind } from '../shared/codexRunOutcome.js';
export interface CodexNativeTurnFailure { readonly version: 1; readonly kind: CodexFailureKind; readonly code: string | null; readonly httpStatusCode: number | null; }
export function codexNativeTurnFailure(error: unknown): Readonly<CodexNativeTurnFailure>;
export class CodexAppServerTurnFailedError extends Error {
  constructor(nativeError: unknown, recovered?: boolean);
  readonly failure: Readonly<CodexNativeTurnFailure>;
}
export function isCodexAppServerTurnFailedError(error: unknown): error is CodexAppServerTurnFailedError;
