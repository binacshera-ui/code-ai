export type CodexQueueStopMode = 'hard' | 'conditional';

export type CodexQueueStopPolicyStatus =
  | 'armed'
  | 'stopping'
  | 'awaiting-decision'
  | 'continued'
  | 'stopped'
  | 'failed'
  | 'not-needed';

export type CodexQueueStopPolicyOutcome =
  | 'hard-stopped'
  | 'continue-approved'
  | 'continue-declined'
  | 'invalid-decision'
  | 'decision-failed'
  | 'completed-before-stop'
  | 'stop-failed';

export interface CodexQueueStopPolicy {
  stopAt: string;
  mode: CodexQueueStopMode;
  question: string | null;
  status: CodexQueueStopPolicyStatus;
  triggeredAt: string | null;
  resolvedAt: string | null;
  decisionItemId: string | null;
  continuationItemId: string | null;
  decision: boolean | null;
  outcome: CodexQueueStopPolicyOutcome | null;
  error: string | null;
  stopAttempts: number;
  lastStopAttemptAt: string | null;
}

export interface CreateCodexQueueStopPolicyInput {
  stopAt: string;
  mode: CodexQueueStopMode;
  question?: string | null;
}

const STOP_POLICY_STATUSES = new Set<CodexQueueStopPolicyStatus>([
  'armed',
  'stopping',
  'awaiting-decision',
  'continued',
  'stopped',
  'failed',
  'not-needed',
]);

const STOP_POLICY_OUTCOMES = new Set<CodexQueueStopPolicyOutcome>([
  'hard-stopped',
  'continue-approved',
  'continue-declined',
  'invalid-decision',
  'decision-failed',
  'completed-before-stop',
  'stop-failed',
]);

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createCodexQueueStopPolicy(
  input: CreateCodexQueueStopPolicyInput,
  referenceMs = Date.now()
): CodexQueueStopPolicy {
  const stopDate = new Date(input.stopAt);
  if (Number.isNaN(stopDate.getTime())) {
    throw new Error('Stop time is invalid');
  }
  if (stopDate.getTime() <= referenceMs) {
    throw new Error('Stop time must be in the future');
  }
  if (input.mode !== 'hard' && input.mode !== 'conditional') {
    throw new Error('Stop mode is invalid');
  }

  const question = normalizeOptionalText(input.question);
  if (input.mode === 'conditional' && !question) {
    throw new Error('A continuation decision question is required for conditional stop');
  }

  return {
    stopAt: stopDate.toISOString(),
    mode: input.mode,
    question: input.mode === 'conditional' ? question : null,
    status: 'armed',
    triggeredAt: null,
    resolvedAt: null,
    decisionItemId: null,
    continuationItemId: null,
    decision: null,
    outcome: null,
    error: null,
    stopAttempts: 0,
    lastStopAttemptAt: null,
  };
}

export function normalizeCodexQueueStopPolicy(value: unknown): CodexQueueStopPolicy | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const stopAt = normalizeOptionalIso(candidate.stopAt);
  const mode = candidate.mode === 'hard' || candidate.mode === 'conditional'
    ? candidate.mode
    : null;
  const question = normalizeOptionalText(candidate.question);
  if (!stopAt || !mode || (mode === 'conditional' && !question)) {
    return null;
  }

  const status = typeof candidate.status === 'string'
    && STOP_POLICY_STATUSES.has(candidate.status as CodexQueueStopPolicyStatus)
    ? candidate.status as CodexQueueStopPolicyStatus
    : 'armed';
  const outcome = typeof candidate.outcome === 'string'
    && STOP_POLICY_OUTCOMES.has(candidate.outcome as CodexQueueStopPolicyOutcome)
    ? candidate.outcome as CodexQueueStopPolicyOutcome
    : null;

  return {
    stopAt,
    mode,
    question: mode === 'conditional' ? question : null,
    status,
    triggeredAt: normalizeOptionalIso(candidate.triggeredAt),
    resolvedAt: normalizeOptionalIso(candidate.resolvedAt),
    decisionItemId: normalizeOptionalText(candidate.decisionItemId),
    continuationItemId: normalizeOptionalText(candidate.continuationItemId),
    decision: typeof candidate.decision === 'boolean' ? candidate.decision : null,
    outcome,
    error: normalizeOptionalText(candidate.error),
    stopAttempts: Number.isInteger(candidate.stopAttempts) && Number(candidate.stopAttempts) >= 0
      ? Number(candidate.stopAttempts)
      : 0,
    lastStopAttemptAt: normalizeOptionalIso(candidate.lastStopAttemptAt),
  };
}

export function cloneCodexQueueStopPolicy(
  value: CodexQueueStopPolicy | null | undefined
): CodexQueueStopPolicy | null {
  return value ? { ...value } : null;
}

export function buildConditionalStopDecisionPrompt(options: {
  question: string;
  originalTask: string;
}): string {
  return [
    'A scheduled continuation checkpoint has stopped the current task.',
    'Do not continue the task yet and do not use tools. Evaluate only the continuation question below using the current session context.',
    '',
    '<continuation_question>',
    options.question.trim(),
    '</continuation_question>',
    '',
    '<stopped_task_reference>',
    options.originalTask.trim(),
    '</stopped_task_reference>',
    '',
    'Reply with exactly one raw JSON object and no Markdown or explanatory text:',
    '{"continue": true}',
    'or',
    '{"continue": false}',
    'Use true only when the answer to the continuation question is unequivocally yes. Any other response will permanently stop this task.',
  ].join('\n');
}

export function readConditionalStopDecision(finalMessage: string | null | undefined): boolean | null {
  if (typeof finalMessage !== 'string') {
    return null;
  }

  let candidate = finalMessage.trim();
  const fencedMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    candidate = fencedMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const decision = (parsed as Record<string, unknown>).continue;
    return typeof decision === 'boolean' ? decision : null;
  } catch {
    return null;
  }
}

export function parseConditionalStopDecision(finalMessage: string | null | undefined): boolean {
  return readConditionalStopDecision(finalMessage) === true;
}

export function buildStoppedTaskContinuationPrompt(options: {
  originalTask: string;
  taskHadStarted: boolean;
}): string {
  return [
    'Continue the same task that was stopped by its scheduled continuation checkpoint.',
    options.taskHadStarted
      ? 'Resume from the exact current session and workspace state. Preserve completed work, verify what already happened, and do not restart or duplicate it.'
      : 'The original queued task had not started before the checkpoint. Perform it now from start to finish.',
    'Continue until the original request is fully complete, or report a genuine blocker precisely.',
    '',
    '<original_task>',
    options.originalTask.trim(),
    '</original_task>',
  ].join('\n');
}
