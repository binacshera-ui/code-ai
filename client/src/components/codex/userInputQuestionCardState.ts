import type {
  CodexUserInputAnswers,
  CodexUserInputQuestion,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from '../../../../shared/codexUserInput';

export interface UserInputQuestionDraft {
  selectedOption: number | null;
  useOther: boolean;
  text: string;
}

export type UserInputQuestionDrafts = Record<string, UserInputQuestionDraft>;

/** Keep request-local drafts separate even when sessions reuse question ids. */
export function userInputRequestKey(
  request: Pick<CodexUserInputRequest, 'profileId' | 'sessionId' | 'id'>,
): string {
  return JSON.stringify([request.profileId, request.sessionId, request.id]);
}

export function createUserInputQuestionDrafts(
  questions: readonly CodexUserInputQuestion[],
): UserInputQuestionDrafts {
  return Object.fromEntries(questions.map((question) => [question.id, {
    selectedOption: null,
    useOther: false,
    text: '',
  }]));
}

/** No recommended/default option is an answer until the user selects it. */
export function userInputQuestionAnswer(
  question: CodexUserInputQuestion,
  draft: UserInputQuestionDraft | undefined,
): string | null {
  if (!draft) return null;

  if (question.options?.length) {
    if (!draft.useOther) {
      if (!Number.isInteger(draft.selectedOption) || draft.selectedOption === null) return null;
      const option = question.options[draft.selectedOption];
      return typeof option?.label === 'string' && option.label.length > 0 ? option.label : null;
    }
    if (!question.isOther) return null;
  }

  // Whitespace can be meaningful in a secret; never alter its actual value.
  if (typeof draft.text !== 'string') return null;
  const answer = question.isSecret ? draft.text : draft.text.trim();
  return answer.length > 0 ? answer : null;
}

export function buildUserInputQuestionResponse(
  questions: readonly CodexUserInputQuestion[],
  drafts: UserInputQuestionDrafts,
): CodexUserInputResponse | null {
  if (questions.length === 0) return null;
  const ids = new Set<string>();
  const entries: Array<[string, { answers: string[] }]> = [];
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) return null;
    ids.add(question.id);
    const answer = userInputQuestionAnswer(question, Object.hasOwn(drafts, question.id) ? drafts[question.id] : undefined);
    if (answer === null) return null;
    entries.push([question.id, { answers: [answer] }]);
  }
  // Object.fromEntries also safely handles ids such as "__proto__".
  return { answers: Object.fromEntries(entries) };
}

/** The card may retain a receipt, but never a secret response or unrelated keys. */
export function redactUserInputQuestionAnswers(
  questions: readonly CodexUserInputQuestion[],
  answers: CodexUserInputAnswers,
): CodexUserInputAnswers {
  return Object.fromEntries(questions
    .filter((question) => Object.hasOwn(answers, question.id))
    .map((question) => [question.id, {
      answers: question.isSecret ? ['[redacted]'] : [...answers[question.id].answers],
    }]));
}

export function userInputQuestionAnswerSummary(
  question: CodexUserInputQuestion,
  answers: CodexUserInputAnswers | undefined,
): string {
  if (question.isSecret) return 'תשובה חסויה נשלחה';
  const values = answers && Object.hasOwn(answers, question.id) ? answers[question.id].answers : [];
  return values?.filter((value) => typeof value === 'string' && value.length > 0).join(' · ')
    || 'התשובה נמסרה';
}

export function userInputQuestionCardPresentation(
  request: Pick<CodexUserInputRequest, 'status' | 'isBlocking'>,
): { label: string; description: string } {
  switch (request.status) {
    case 'pending':
      return request.isBlocking
        ? { label: 'ממתין לתשובה', description: 'Codex ממתין לתשובה שלך לפני המשך העבודה.' }
        : { label: 'שאלה פתוחה', description: 'Codex יכול להמשיך לעבוד גם ללא תשובה. אפשר לענות כל עוד הבקשה פעילה.' };
    case 'answered':
      return { label: 'נענתה', description: 'התשובה נשלחה ל-Codex באותו מהלך.' };
    case 'expired':
      return { label: 'לא פעילה', description: 'הבקשה כבר אינה פעילה ולא ניתן לשלוח לה תשובה.' };
    case 'cancelled':
      return { label: 'בוטלה', description: 'בקשת התשובה בוטלה ואינה פעילה עוד.' };
    case 'failed':
      return { label: 'החיבור הסתיים', description: 'לא ניתן לשלוח תשובה לבקשה הזו כי החיבור לסוכן הסתיים.' };
  }
}
