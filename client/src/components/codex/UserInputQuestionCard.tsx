import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, CircleHelp, Loader2, LockKeyhole } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CODEX_USER_INPUT_LIMITS } from '../../../../shared/codexUserInput';
import type {
  CodexUserInputAnswers,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from '../../../../shared/codexUserInput';
import {
  buildUserInputQuestionResponse,
  createUserInputQuestionDrafts,
  redactUserInputQuestionAnswers,
  userInputQuestionAnswer,
  userInputQuestionAnswerSummary,
  userInputQuestionCardPresentation,
  userInputRequestKey,
  type UserInputQuestionDraft,
} from './userInputQuestionCardState';

export interface UserInputQuestionCardProps {
  request: CodexUserInputRequest;
  submitting?: boolean;
  error?: string | null;
  /** Resolve only after the native response is accepted; reject to allow retry. */
  onSubmit: (response: CodexUserInputResponse) => Promise<void> | void;
  className?: string;
}

const SUBMISSION_ERROR = 'שליחת התשובה לא הצליחה. אפשר לערוך אותה ולנסות שוב.';

/** This boundary resets answer drafts on a request/session change, never the composer. */
export function UserInputQuestionCard(props: UserInputQuestionCardProps) {
  return <UserInputQuestionCardDraft key={userInputRequestKey(props.request)} {...props} />;
}

function UserInputQuestionCardDraft({
  request,
  submitting = false,
  error = null,
  onSubmit,
  className,
}: UserInputQuestionCardProps) {
  const formId = useId();
  const mountedRef = useRef(false);
  const submitLockRef = useRef(false);
  const [drafts, setDrafts] = useState(() => createUserInputQuestionDrafts(request.questions));
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [acceptedAnswers, setAcceptedAnswers] = useState<CodexUserInputAnswers | null>(null);
  const busy = submitting || localSubmitting;
  const answered = request.status === 'answered' || (request.status === 'pending' && acceptedAnswers !== null);
  const editable = request.status === 'pending' && !answered;
  const response = buildUserInputQuestionResponse(request.questions, drafts);
  const answeredCount = request.questions.filter((question) => userInputQuestionAnswer(question, drafts[question.id]) !== null).length;
  const presentation = userInputQuestionCardPresentation({
    status: answered ? 'answered' : request.status,
    isBlocking: request.isBlocking,
  });
  const hasSecret = request.questions.some((question) => question.isSecret);
  // A transport error must not accidentally echo a submitted secret into the DOM.
  const visibleError = localError || (error && hasSecret ? SUBMISSION_ERROR : error);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (request.status !== 'pending') {
      setDrafts(createUserInputQuestionDrafts(request.questions));
      setLocalError(null);
    }
  }, [request.status]);

  function updateDraft(questionId: string, update: Partial<UserInputQuestionDraft>) {
    if (!editable || busy || submitLockRef.current) return;
    setDrafts((previous) => ({
      ...previous,
      [questionId]: { ...previous[questionId], ...update },
    }));
    setLocalError(null);
  }

  async function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || busy || submitLockRef.current || !response) return;
    submitLockRef.current = true;
    setLocalSubmitting(true);
    setLocalError(null);
    try {
      await onSubmit(response);
      if (mountedRef.current) {
        setAcceptedAnswers(redactUserInputQuestionAnswers(request.questions, response.answers));
        setDrafts(createUserInputQuestionDrafts(request.questions));
      }
    } catch {
      if (mountedRef.current) setLocalError(SUBMISSION_ERROR);
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setLocalSubmitting(false);
    }
  }

  return (
    <section
      dir="rtl"
      aria-labelledby={`${formId}-title`}
      className={cn('min-w-0 rounded-[1.25rem] border border-slate-200 bg-white p-3 text-right shadow-sm sm:p-4', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${formId}-title`} className="flex items-center gap-2 text-sm font-medium text-slate-800">
          <CircleHelp aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
          שאלה מ-Codex
        </h3>
        <span
          role="status"
          className={cn('rounded-full border px-2.5 py-1 text-[11px] font-medium',
            answered ? 'border-emerald-100 bg-emerald-50/70 text-emerald-700'
              : editable && request.isBlocking ? 'border-amber-100 bg-amber-50/80 text-amber-700'
                : 'border-slate-200 bg-slate-50/70 text-slate-500')}
        >
          {presentation.label}
        </span>
      </div>
      <p id={`${formId}-description`} className="mt-2 text-xs leading-6 text-slate-500">
        {presentation.description}
      </p>

      <form onSubmit={submitAnswer} aria-describedby={`${formId}-description`} aria-busy={busy && editable} className="mt-3 space-y-4">
        {request.questions.map((question, questionIndex) => {
          const draft = drafts[question.id];
          const hasOptions = Boolean(question.options?.length);
          const showTextInput = editable && (!hasOptions || draft?.useOther);
          const textInputId = `${formId}-text-${questionIndex}`;
          return (
            <fieldset key={question.id} disabled={!editable || busy} className="min-w-0 space-y-2">
              <legend className="mb-2 w-full text-sm leading-6 text-slate-800">
                {question.header && <span className="mb-1 block text-[11px] font-medium text-slate-500">{question.header}</span>}
                <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{question.question}</span>
              </legend>

              {answered ? (
                <p className="flex items-start gap-2 rounded-xl bg-slate-50/70 px-3 py-2 text-xs leading-6 text-slate-600">
                  {question.isSecret
                    ? <LockKeyhole aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0" />
                    : <Check aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                  <span className="max-h-40 min-w-0 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {userInputQuestionAnswerSummary(question, request.answers || acceptedAnswers || undefined)}
                  </span>
                </p>
              ) : editable && (
                <>
                  {question.options?.map((option, optionIndex) => {
                    const selected = draft?.selectedOption === optionIndex && !draft?.useOther;
                    return (
                      <label key={optionIndex} className={cn(
                        'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-slate-300',
                        selected ? 'border-indigo-100 bg-indigo-50/60' : 'border-slate-200 bg-slate-50/70 hover:bg-slate-100',
                        busy && 'cursor-wait opacity-60',
                      )}>
                        <input
                          type="radio"
                          name={`${formId}-question-${questionIndex}`}
                          value={optionIndex}
                          checked={selected}
                          onChange={() => updateDraft(question.id, { selectedOption: optionIndex, useOther: false })}
                          className="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          <span className="block text-sm leading-6 text-slate-700">{option.label}</span>
                          {option.description && <span className="mt-0.5 block text-xs leading-5 text-slate-500">{option.description}</span>}
                        </span>
                      </label>
                    );
                  })}

                  {hasOptions && question.isOther && (
                    <label className={cn(
                      'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm text-slate-700 transition-colors focus-within:ring-2 focus-within:ring-slate-300',
                      draft?.useOther ? 'border-indigo-100 bg-indigo-50/60' : 'border-slate-200 bg-slate-50/70 hover:bg-slate-100',
                      busy && 'cursor-wait opacity-60',
                    )}>
                      <input
                        type="radio"
                        name={`${formId}-question-${questionIndex}`}
                        checked={Boolean(draft?.useOther)}
                        onChange={() => updateDraft(question.id, { selectedOption: null, useOther: true })}
                        className="h-4 w-4 shrink-0 accent-indigo-600"
                      />
                      תשובה אחרת
                    </label>
                  )}

                  {showTextInput && (
                    <div className="space-y-1.5">
                      <label htmlFor={textInputId} className="block text-xs text-slate-500">
                        {question.isSecret ? 'תשובה חסויה' : hasOptions ? 'התשובה שלך' : 'אפשר לכתוב את התשובה כאן'}
                      </label>
                      {question.isSecret ? (
                        <input
                          id={textInputId}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={CODEX_USER_INPUT_LIMITS.answerText}
                          value={draft?.text || ''}
                          onChange={(event) => updateDraft(question.id, { text: event.target.value })}
                          className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-800 outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-60"
                        />
                      ) : (
                        <textarea
                          id={textInputId}
                          rows={2}
                          maxLength={CODEX_USER_INPUT_LIMITS.answerText}
                          value={draft?.text || ''}
                          onChange={(event) => updateDraft(question.id, { text: event.target.value })}
                          className="min-h-20 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-base leading-6 text-slate-800 outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-60"
                        />
                      )}
                      {question.isSecret && <p className="text-[11px] leading-5 text-slate-500">התשובה תישלח לסוכן ולא תוצג בכרטיס התשובה.</p>}
                    </div>
                  )}
                </>
              )}
            </fieldset>
          );
        })}

        {editable && (
          <>
            {visibleError && <p role="alert" className="rounded-xl border border-red-100 bg-red-50/70 px-3 py-2 text-xs leading-6 text-red-700">{visibleError}</p>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <p className="min-w-0 text-[11px] leading-5 text-slate-500">
                {request.questions.length > 1 ? `${answeredCount} מתוך ${request.questions.length} שאלות נענו` : 'בחרו או כתבו תשובה לפני השליחה'}
              </p>
              <button
                type="submit"
                disabled={busy || !response}
                className="code-ai-user-action flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                {busy ? 'שולח תשובה…' : 'שלח תשובה'}
              </button>
            </div>
          </>
        )}
      </form>
    </section>
  );
}
