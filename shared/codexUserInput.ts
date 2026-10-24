/** Product-owned view of Codex app-server 0.160.1 request_user_input. */
export interface CodexUserInputOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[] | null;
}

export type CodexUserInputAnswers = Record<string, { answers: string[] }>;

/** Native response shape; question IDs, not option indices, are the keys. */
export interface CodexUserInputResponse {
  answers: CodexUserInputAnswers;
}

export type CodexUserInputStatus = 'pending' | 'answered' | 'expired' | 'cancelled' | 'failed';

export interface CodexUserInputRequest {
  /** Opaque product ID. Native RPC IDs can repeat between process instances. */
  id: string;
  profileId: string;
  /** Owning conversation, including when a child thread asked the question. */
  sessionId: string;
  runId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  questions: CodexUserInputQuestion[];
  status: CodexUserInputStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** Resolved secret answers are always redacted. */
  answers?: CodexUserInputAnswers;
  resolutionReason?: string;
}

export interface CodexUserInputSnapshot {
  requests: CodexUserInputRequest[];
  pendingCount: number;
}

export interface CodexUserInputAnswerResult {
  request: CodexUserInputRequest;
  duplicate: boolean;
}

export const CODEX_USER_INPUT_LIMITS = {
  questions: 3,
  optionsPerQuestion: 20,
  questionText: 16_000,
  optionText: 2_000,
  answerText: 32_000,
  answerBytes: 128_000,
  requestBytes: 128_000,
} as const;
