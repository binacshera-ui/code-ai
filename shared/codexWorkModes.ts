/** Durable, provider-independent task budgets. Times are server-owned UTC ISO strings. */
export interface CodexRationalTask {
  id: string;
  title: string;
  estimatedMinutes: number;
  status: 'pending' | 'completed';
  deadlineAt: string;
  completedAt: string | null;
  evidence: string | null;
}

export interface CodexRationalRun {
  runId: string;
  attemptId: string;
  profileId: string;
  sessionKey: string;
  enabled: boolean;
  status: 'planning' | 'running' | 'completed' | 'expired' | 'incomplete';
  startedAt: string;
  planningDeadlineAt: string | null;
  /** New runs let the model declare its budget once, before planning work. */
  timingSource?: 'model';
  planningMinutes?: number | null;
  /** Safety deadline to declare a budget, not an operator-selected planning time. */
  budgetDeclarationDeadlineAt?: string | null;
  plannedAt: string | null;
  /** Deadline of the first unfinished task, or the initial planning deadline. */
  deadlineAt: string | null;
  currentTaskId: string | null;
  /** Historical runs retain their original cap; new model-owned runs have none. */
  taskMinutes: number | null;
  tasks: CodexRationalTask[];
  expiredAt: string | null;
  /** An explicit owner decision releases the conversation hold, never the original result. */
  holdReleasedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
}

export type CodexRationalAction =
  | { action: 'budget'; planningMinutes: number }
  | { action: 'plan'; tasks: Array<{ title: string; estimatedMinutes: number }> }
  | { action: 'complete'; taskId: string; evidence: string }
  | { action: 'status' };
