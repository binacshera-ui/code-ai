export function withCodexMessageAdmission<T>(profileId: string, requestId: string, operation: () => Promise<T>): Promise<T>;
export function shouldAppendLiveMessage(input: {
  route: string; sessionId?: string; draft?: boolean; scheduledAt?: string; recurrence?: unknown; provider?: string;
}): boolean;
