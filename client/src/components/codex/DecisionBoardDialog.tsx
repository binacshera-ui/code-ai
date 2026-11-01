import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, CheckCheck, CircleHelp, Loader2, MessageSquare, RefreshCw, Save, Send, X } from 'lucide-react';
import type { DecisionBoardAnswer, DecisionBoardItem } from '../../../../shared/decisionBoard';
import { DECISION_BOARD_LIMITS } from '../../../../shared/decisionBoard';
import type { CodexUserInputRequest, CodexUserInputResponse } from '../../../../shared/codexUserInput';
import { UserInputQuestionCard } from './UserInputQuestionCard';
import { decisionAnswer, decisionAnswerError, decisionBoardProgress, emptyDecisionAnswer, sameDecisionAnswer, toggleDecisionOption, type DecisionBoardClientState } from './decisionBoardClient';

const STYLES = `
.code-ai-decisions{--dd-bg:var(--code-ai-panel-bg,#fff);--dd-soft:var(--code-ai-soft-bg,#fafafa);--dd-border:var(--code-ai-panel-border,#e5e5e5);--dd-text:var(--code-ai-canvas-text,#171717);--dd-muted:var(--code-ai-text-muted,#737373);--dd-good:#15803d;--dd-bad:#b91c1c;background:var(--dd-bg);color:var(--dd-text)}
.code-ai-theme-dark .code-ai-decisions{--dd-good:#86efac;--dd-bad:#fca5a5}
.code-ai-decisions .dd-muted{color:var(--dd-muted)}
.code-ai-decisions .dd-action{display:inline-flex;min-height:44px;min-width:44px;align-items:center;justify-content:center;gap:.5rem;border:1px solid var(--dd-border);border-radius:999px;padding:.5rem .85rem;font-size:.75rem;font-weight:500;background:var(--dd-bg);color:var(--dd-text)}
.code-ai-decisions .dd-action:hover:not(:disabled){background:var(--dd-soft)}
.code-ai-decisions .dd-action[aria-pressed=true]{background:var(--dd-soft);border-color:var(--dd-text)}
.code-ai-decisions .dd-action:disabled{cursor:not-allowed;opacity:.45}
.code-ai-decisions :is(button,input,textarea,summary):focus-visible{outline:2px solid var(--dd-muted);outline-offset:3px}
.code-ai-decisions .dd-card{min-width:0;border:1px solid var(--dd-border);border-radius:1.25rem;padding:1rem;background:var(--dd-bg)}
.code-ai-decisions .dd-choice{display:flex;min-height:44px;align-items:start;gap:.75rem;border:1px solid var(--dd-border);border-radius:1rem;padding:.75rem;cursor:pointer}
.code-ai-decisions .dd-choice[data-selected=true]{background:var(--dd-soft);border-color:var(--dd-muted)}
.code-ai-decisions :is(input,textarea){accent-color:var(--dd-text)}
.code-ai-decisions .dd-note{display:block;width:100%;min-height:88px;border:1px solid var(--dd-border);border-radius:1rem;background:var(--dd-soft);color:var(--dd-text);padding:.75rem;resize:vertical;font-size:1rem}
`;

export interface DecisionBoardNativeQuestions {
  requests: CodexUserInputRequest[];
  submittingId: string | null;
  error: { id: string; message: string } | null;
  answer: (id: string, response: CodexUserInputResponse) => Promise<void>;
}
export interface DecisionBoardViewProps {
  state: DecisionBoardClientState;
  onChange: (id: string, answer: DecisionBoardAnswer) => void;
  onSave: () => Promise<boolean>;
  onSubmit: () => Promise<boolean>;
  onEnabled: (enabled: boolean) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
  native?: DecisionBoardNativeQuestions;
}

function DecisionCard({ item, answer, dirty, disabled, onChange }: {
  item: DecisionBoardItem; answer: DecisionBoardAnswer; dirty: boolean; disabled: boolean;
  onChange: (answer: DecisionBoardAnswer) => void;
}) {
  const validation = decisionAnswerError(item, answer);
  const status = dirty ? 'שינוי שלא נשמר' : item.submittedAt ? 'נשלחה לסוכן' : item.answer ? 'נשמרה · טרם נשלחה' : 'לבחירתך';
  return <section className="dd-card" aria-label={item.title} data-decision-id={item.id}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="min-w-0 whitespace-pre-wrap break-words text-sm font-semibold [overflow-wrap:anywhere]">{item.title}</h3>
      <div className="flex items-center gap-2"><span className="dd-muted rounded-full border px-2 py-1 text-[10px]" style={{ borderColor: 'var(--dd-border)' }}>{status}</span>{dirty && <button type="button" className="dd-action" disabled={disabled} onClick={() => onChange(item.answer || emptyDecisionAnswer())}>בטל שינוי</button>}</div>
    </div>
    {item.description && <p className="dd-muted mt-2 whitespace-pre-wrap break-words text-xs leading-6 [overflow-wrap:anywhere]">{item.description}</p>}
    <fieldset disabled={disabled} className="mt-3 min-w-0 space-y-2">
      <legend className="sr-only">{item.title}</legend>
      {item.kind === 'approval' && <div className="grid grid-cols-2 gap-2">
        <button type="button" className="dd-action" aria-pressed={answer.verdict === 'approved'} onClick={() => onChange({ ...answer, verdict: 'approved', optionIds: [] })}>
          <Check aria-hidden="true" className="h-5 w-5" style={{ color: 'var(--dd-good)' }} />מאשר
        </button>
        <button type="button" className="dd-action" aria-pressed={answer.verdict === 'rejected'} onClick={() => onChange({ ...answer, verdict: 'rejected', optionIds: [] })}>
          <X aria-hidden="true" className="h-5 w-5" style={{ color: 'var(--dd-bad)' }} />דוחה
        </button>
      </div>}
      {(item.kind === 'single' || item.kind === 'multiple') && item.options.map(option => {
        const checked = answer.optionIds.includes(option.id);
        return <label key={option.id} className="dd-choice" data-selected={checked}>
          <input type={item.kind === 'multiple' ? 'checkbox' : 'radio'} name={`decision-${item.id}`} value={option.id} checked={checked} onChange={() => onChange(toggleDecisionOption(item, answer, option.id))} className="mt-1 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]"><span className="block text-sm">{option.label}</span>{option.description && <span className="dd-muted mt-1 block text-xs leading-5">{option.description}</span>}</span>
        </label>;
      })}
      <details open={item.kind === 'text' || Boolean(answer.note)} className="pt-1">
        <summary className="dd-muted flex min-h-11 cursor-pointer items-center gap-2 rounded-lg text-xs"><MessageSquare aria-hidden="true" className="h-4 w-4" />{item.kind === 'text' ? 'התשובה שלך' : 'הוסף הערה'}</summary>
        <label className="sr-only" htmlFor={`decision-note-${item.id}`}>{item.kind === 'text' ? `תשובה: ${item.title}` : `הערה: ${item.title}`}</label>
        <textarea id={`decision-note-${item.id}`} className="dd-note" dir="auto" maxLength={DECISION_BOARD_LIMITS.note} rows={3} value={answer.note} onChange={event => onChange({ ...answer, note: event.target.value })} />
      </details>
    </fieldset>
    {dirty && validation && <p className="dd-muted mt-2 text-xs leading-5" role="status">{validation}</p>}
  </section>;
}

export function DecisionBoardView({ state, onChange, onSave, onSubmit, onEnabled, onRefresh, onClose, native }: DecisionBoardViewProps) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const { board, drafts } = state;
  const progress = decisionBoardProgress(board, drafts);
  const busy = state.saving || state.submitting;
  const locked = state.submitting || state.uncertain || Boolean(board?.pendingDelivery);
  const pendingNative = native?.requests.filter(request => request.status === 'pending') || [];
  const items = board?.items.filter(item => filter === 'all' || !item.submittedAt || Boolean(drafts[item.id])) || [];
  const invalidDirty = board?.items.some(item => drafts[item.id] && decisionAnswerError(item, drafts[item.id])) || false;
  const canSubmit = !busy && !invalidDirty && Boolean(board?.enabled || state.uncertain || board?.pendingDelivery)
    && Boolean(state.uncertain || board?.pendingDelivery || progress.dirty || progress.unsent);
  const footerStatus = state.submitting ? 'שומר ושולח לסוכן…' : state.saving ? 'שומר בחירות…'
    : state.uncertain || board?.pendingDelivery ? 'המסירה לתור עדיין לא אומתה'
      : progress.dirty ? `${progress.dirty} שינויים לא נשמרו · נשמרים בחלון הזה, לא לאחר רענון הדף`
        : state.receipt ? 'הבחירות נמסרו לתור השיחה'
          : progress.unsent ? 'הבחירות נשמרו · עדיין לא נשלחו לסוכן' : 'רק שליחה מפורשת מעבירה את הבחירות לסוכן';
  return <>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--dd-border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="dd-action" role="switch" aria-checked={board?.enabled || false} disabled={!board || busy || locked} onClick={() => void onEnabled(!board?.enabled)}>{board?.enabled ? 'מצב החלטות פעיל' : 'הפעל החלטות בשיחה'}</button>
        {board && <span className="dd-muted text-xs">{progress.answered}/{progress.total} נבחרו</span>}
      </div>
      <button type="button" className="dd-action" disabled={busy || state.loading} onClick={onRefresh} aria-label="רענן את ההחלטות"><RefreshCw aria-hidden="true" className="h-4 w-4" /></button>
      {progress.total > 0 && <div role="progressbar" aria-label="החלטות שנבחרו" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.answered} className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--dd-soft)' }}><div className="h-full rounded-full" style={{ width: `${progress.answered / progress.total * 100}%`, background: 'var(--dd-muted)' }} /></div>}
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
      {state.error && <div role="alert" className="rounded-xl border px-3 py-2 text-xs leading-6" style={{ borderColor: 'var(--dd-bad)', color: 'var(--dd-bad)' }}>{state.error}</div>}
      {(state.uncertain || board?.pendingDelivery) && <p role="status" className="dd-muted rounded-xl border p-3 text-xs leading-6" style={{ borderColor: 'var(--dd-border)' }}>הבחירות נשמרו, אך המסירה לתור עדיין לא אומתה. ניסיון חוזר ישלים את אותה שליחה, בלי ליצור עותק נוסף.</p>}
      {state.loading && !board && <p role="status" className="dd-muted flex items-center gap-2 py-8 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />טוען את החלטות השיחה…</p>}
      {pendingNative.map(request => request.questions.some(question => question.isSecret)
        ? <section key={request.id} className="dd-card"><p className="text-sm">שאלה חסויה פתוחה בשיחה</p><button type="button" className="dd-action mt-3" onClick={onClose}>ענה בשיחה</button></section>
        : <UserInputQuestionCard key={request.id} request={request} submitting={native?.submittingId === request.id} error={native?.error?.id === request.id ? native.error.message : null} onSubmit={response => native!.answer(request.id, response)} />)}
      {board && board.items.length > 0 && <div className="flex gap-2" aria-label="סינון החלטות"><button type="button" className="dd-action" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>ממתינות</button><button type="button" className="dd-action" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>הכול ({progress.total})</button></div>}
      {items.map(item => <DecisionCard key={item.id} item={item} answer={decisionAnswer(item, drafts)} dirty={Boolean(drafts[item.id]) && !sameDecisionAnswer(drafts[item.id], item.answer)} disabled={locked} onChange={answer => onChange(item.id, answer)} />)}
      {board && !items.length && !pendingNative.length && <div className="dd-card py-8 text-center"><CircleHelp aria-hidden="true" className="dd-muted mx-auto mb-3 h-7 w-7" /><p className="text-sm">{progress.total ? 'כל ההחלטות נשלחו' : 'כאן בוחרים, מאשרים וממשיכים'}</p><p className="dd-muted mx-auto mt-2 max-w-sm text-xs leading-6">{progress.total ? 'אפשר לראות ולעדכן בחירות בכרטיסיית הכול.' : board.enabled ? 'בקש מהסוכן להציג אפשרויות בלוח ההחלטות. הבחירות שלך יישלחו אליו רק בלחיצה על שליחה.' : 'הפעל החלטות ובקש מהסוכן להכין כאן את הבחירות עבורך.'}</p></div>}
    </div>
    <footer className="shrink-0 space-y-2 border-t px-4 py-3" style={{ borderColor: 'var(--dd-border)', paddingBottom: 'max(.75rem,env(safe-area-inset-bottom))' }}>
      <p role="status" aria-live="polite" className="dd-muted flex items-center gap-1.5 text-[11px] leading-5">{state.submitting && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}{footerStatus}</p>
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="dd-action" disabled={busy || locked || !progress.dirty || invalidDirty} onClick={() => void onSave()}><Save aria-hidden="true" className="h-4 w-4" />שמור בחירות</button><button type="button" className="dd-action" disabled={!canSubmit} onClick={() => void onSubmit()}><Send aria-hidden="true" className="h-4 w-4" />{state.uncertain || board?.pendingDelivery ? 'נסה לשלוח שוב' : 'שלח לסוכן'}</button></div>
    </footer>
  </>;
}

export function DecisionBoardDialog(props: DecisionBoardViewProps & { themeClassName: string; themePresetId: string; scope: string }) {
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={open => { if (!open) props.onClose(); }}>
    <Dialog.Portal><div className={`code-ai-theme ${props.themeClassName}`} data-theme-preset={props.themePresetId} dir="rtl">
      <style>{STYLES}</style>
      <Dialog.Overlay className="fixed inset-0 z-[140] bg-black/40 backdrop-blur-sm" />
      <Dialog.Content data-testid="decision-board-dialog" data-decision-scope={props.scope} dir="rtl" className="code-ai-decisions fixed left-1/2 top-1/2 z-[141] flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[1.5rem] border shadow-2xl outline-none" style={{ borderColor: 'var(--code-ai-panel-border)' }} onCloseAutoFocus={event => { event.preventDefault(); const target = previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLButtonElement>('[data-testid="decision-board-launcher"]'); target?.focus({ preventScroll: true }); }}>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--dd-border)' }}><div className="min-w-0"><Dialog.Title className="flex items-center gap-2 text-base font-semibold"><CheckCheck aria-hidden="true" className="h-5 w-5 shrink-0" />{props.state.board?.title || 'החלטות'}</Dialog.Title><Dialog.Description className="dd-muted mt-1 text-xs leading-5">הבחירות שלך, בתוך השיחה הזאת</Dialog.Description></div><Dialog.Close asChild><button type="button" className="dd-action" aria-label="סגור החלטות"><X aria-hidden="true" className="h-5 w-5" /></button></Dialog.Close></header>
        <DecisionBoardView {...props} />
      </Dialog.Content>
    </div></Dialog.Portal>
  </Dialog.Root>;
}
