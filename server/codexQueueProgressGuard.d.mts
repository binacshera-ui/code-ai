import type { CodexQueueItem } from './codexQueue.js';
import type { CodexProgressGuardClaim } from './codexAppServer.js';
export function claimQueueProgressGuard(item: Pick<CodexQueueItem, 'status' | 'nativeSubmission' | 'nativeCancellationRequestedAt' | 'progressGuardWarning'>,
  warning: CodexProgressGuardClaim, persist: () => Promise<void>): Promise<boolean>;
