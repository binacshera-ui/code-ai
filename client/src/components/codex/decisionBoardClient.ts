import type { DecisionBoard, DecisionBoardAnswer, DecisionBoardItem, DecisionBoardMutation, DecisionBoardSubmitResult } from '../../../../shared/decisionBoard';
import { normalizeDecisionBoardAnswer, normalizeDecisionBoardDefinitions } from '../../../../shared/decisionBoard';

export type DecisionBoardDrafts = Record<string, DecisionBoardAnswer>;
export type DecisionBoardSubmitReceipt = DecisionBoardSubmitResult;
export interface DecisionBoardApi {
  read: () => Promise<{ board: DecisionBoard }>;
  save: (mutation: DecisionBoardMutation) => Promise<{ board: DecisionBoard }>;
  submit: (input: { expectedRevision: number; requestId: string }) => Promise<DecisionBoardSubmitReceipt>;
}
export interface DecisionBoardClientState {
  board: DecisionBoard | null;
  drafts: DecisionBoardDrafts;
  loading: boolean;
  saving: boolean;
  submitting: boolean;
  error: string | null;
  uncertain: boolean;
  receipt: DecisionBoardSubmitReceipt | null;
}

export const emptyDecisionAnswer = (): DecisionBoardAnswer => ({ verdict: null, optionIds: [], note: '' });
export function decisionAnswer(item: DecisionBoardItem, drafts: DecisionBoardDrafts): DecisionBoardAnswer {
  const answer = drafts[item.id] || item.answer;
  return answer ? { ...answer, optionIds: [...answer.optionIds] } : emptyDecisionAnswer();
}
export function sameDecisionAnswer(a: DecisionBoardAnswer | null | undefined, b: DecisionBoardAnswer | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.verdict === b.verdict && a.note.trim() === b.note.trim()
    && JSON.stringify([...a.optionIds].sort()) === JSON.stringify([...b.optionIds].sort());
}
export function decisionAnswerError(item: DecisionBoardItem, answer: DecisionBoardAnswer): string | null {
  try { normalizeDecisionBoardAnswer(item, answer); return null; }
  catch (error) { return error instanceof Error ? error.message : 'התשובה אינה תקינה.'; }
}
export function isDecisionBoardCode(language: string | undefined, code: string): boolean {
  if (language !== 'code-ai-decisions') return false;
  try { normalizeDecisionBoardDefinitions(JSON.parse(code)); return true; }
  catch { return false; }
}
export function toggleDecisionOption(item: DecisionBoardItem, answer: DecisionBoardAnswer, id: string): DecisionBoardAnswer {
  if (!item.options.some(option => option.id === id)) return answer;
  return { ...answer, verdict: null, optionIds: item.kind === 'multiple'
    ? answer.optionIds.includes(id) ? answer.optionIds.filter(value => value !== id) : [...answer.optionIds, id]
    : [id] };
}
export function decisionBoardProgress(board: DecisionBoard | null, drafts: DecisionBoardDrafts = {}) {
  const items = board?.items || [];
  const answered = items.filter(item => !decisionAnswerError(item, decisionAnswer(item, drafts))).length;
  const pending = items.filter(item => !item.answer).length;
  const dirty = items.filter(item => drafts[item.id] && !sameDecisionAnswer(drafts[item.id], item.answer)).length;
  const unsent = items.filter(item => item.answer && !item.submittedAt).length;
  return { total: items.length, answered, pending, dirty, unsent };
}

function decisionDefinitionKey(item: DecisionBoardItem): string {
  // Option order is presentation-only; stable IDs and their visible meaning
  // must match before a local human answer can be carried into a new revision.
  const options = item.options.map(option => [option.id, option.label, option.description || ''])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([item.title, item.description, item.kind, options]);
}

/** A controller is owned by one server/profile/conversation. Reusing it when a
 * dialog reopens preserves local drafts; it never stores native secret answers. */
export function createDecisionBoardClient(api: DecisionBoardApi, createRequestId: () => string) {
  let state: DecisionBoardClientState = { board: null, drafts: {}, loading: false, saving: false, submitting: false, error: null, uncertain: false, receipt: null };
  let readVersion = 0;
  let activeRead: number | null = null;
  let writeInFlight = false;
  let pendingSubmission: { expectedRevision: number; requestId: string } | null = null;
  const reviewRequired = new Set<string>();
  const reviewMessage = () => reviewRequired.size
    ? 'השאלה או האפשרויות השתנו. הבחירה הקודמת בוטלה וההערה נשמרה כטיוטה. יש לבחור מחדש או לערוך את ההערה לפני שמירה ושליחה.' : null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<DecisionBoardClientState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const message = (error: unknown) => error instanceof Error ? error.message : 'לא ניתן להשלים את הפעולה. אפשר לנסות שוב.';
  const adopt = (board: DecisionBoard, sent?: DecisionBoardDrafts) => {
    const drafts = { ...state.drafts };
    const previousItems = new Map(state.board?.items.map(item => [item.id, item]) || []);
    const currentIds = new Set(board.items.map(item => item.id));
    // A removed item must not leave an invisible review hold, nor restore its
    // old answer if a different question later reuses the same ID.
    for (const id of Object.keys(drafts)) {
      if (!currentIds.has(id)) { delete drafts[id]; reviewRequired.delete(id); }
    }
    for (const item of board.items) {
      const previous = previousItems.get(item.id);
      if (drafts[item.id] && previous && decisionDefinitionKey(previous) !== decisionDefinitionKey(item)) {
        drafts[item.id] = { ...emptyDecisionAnswer(), note: drafts[item.id].note };
        reviewRequired.add(item.id);
        continue;
      }
      if (drafts[item.id] && sameDecisionAnswer(drafts[item.id], item.answer)
        && !reviewRequired.has(item.id)
        && (!sent || sameDecisionAnswer(sent[item.id], drafts[item.id]))) delete drafts[item.id];
    }
    update({ board, drafts, error: reviewMessage() });
  };
  const persist = async (patch?: Partial<DecisionBoardMutation>) => {
    if (!state.board) throw new Error('הלוח עדיין לא נטען.');
    if (reviewRequired.size) throw new Error(reviewMessage()!);
    const answers = state.board.items.flatMap(item => {
      const answer = state.drafts[item.id];
      if (!answer || sameDecisionAnswer(answer, item.answer)) return [];
      const error = decisionAnswerError(item, answer);
      if (error) throw new Error(`${item.title}: ${error}`);
      return [{ decisionId: item.id, answer }];
    });
    if (!answers.length && !patch) return;
    const submitted = Object.fromEntries(answers.map(entry => [entry.decisionId, entry.answer]));
    const { board } = await api.save({ expectedRevision: state.board.revision, ...(answers.length ? { answers } : {}), ...patch });
    adopt(board, submitted);
  };
  const write = async (submitting: boolean, operation: () => Promise<void>) => {
    if (writeInFlight) return false;
    writeInFlight = true;
    readVersion++;
    activeRead = null;
    update({ saving: !submitting, submitting, loading: false, error: reviewMessage() });
    try { await operation(); return true; }
    catch (error) { update({ error: message(error), uncertain: Boolean(pendingSubmission) }); return false; }
    finally { writeInFlight = false; update({ saving: false, submitting: false }); }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh() {
      if (writeInFlight || activeRead !== null) return;
      const version = ++readVersion;
      activeRead = version;
      update({ loading: !state.board });
      try {
        const { board } = await api.read();
        if (version !== readVersion || writeInFlight || (state.board && board.revision < state.board.revision)) return;
        adopt(board);
        update({ loading: false, error: reviewMessage() });
      } catch (error) { if (version === readVersion) update({ loading: false, error: message(error) }); }
      finally { if (activeRead === version) activeRead = null; }
    },
    change(id: string, answer: DecisionBoardAnswer) {
      if (state.submitting || pendingSubmission || state.board?.pendingDelivery || !state.board?.items.some(item => item.id === id)) return;
      const item = state.board.items.find(item => item.id === id)!;
      const drafts = { ...state.drafts };
      // Only an explicit user interaction with the newly rendered definition
      // can lift its review hold. A save/submit or another poll cannot do so.
      reviewRequired.delete(id);
      if (sameDecisionAnswer(answer, item.answer || emptyDecisionAnswer())) delete drafts[id];
      else drafts[id] = { ...answer, optionIds: [...answer.optionIds] };
      update({ drafts, error: reviewMessage(), receipt: null });
    },
    save: () => write(false, async () => {
      if (pendingSubmission || state.board?.pendingDelivery) throw new Error('יש לאמת קודם את השליחה הקודמת לסוכן.');
      await persist();
    }),
    setEnabled: (enabled: boolean) => write(false, async () => {
      if (pendingSubmission) throw new Error('יש לאמת קודם את השליחה הקודמת לסוכן.');
      // Enabling a mode does not implicitly save or execute partial answers.
      if (!state.board) throw new Error('הלוח עדיין לא נטען.');
      const { board } = await api.save({ expectedRevision: state.board.revision, enabled });
      adopt(board);
    }),
    submit: () => write(true, async () => {
      if (!pendingSubmission) {
        if (!state.board?.enabled && !state.board?.pendingDelivery) throw new Error('יש להפעיל את מצב ההחלטות לפני השליחה לסוכן.');
        if (!state.board?.pendingDelivery) await persist();
        if (!state.board || (!state.board.pendingDelivery && !state.board.items.some(item => item.answer && !item.submittedAt))) throw new Error('אין בחירות חדשות לשליחה.');
        pendingSubmission = { expectedRevision: state.board.revision, requestId: createRequestId() };
      }
      // An uncertain POST is only retried explicitly with the same immutable ID
      // and revision, never after silently creating a new queue submission.
      const receipt = await api.submit(pendingSubmission);
      if (!receipt?.board || !receipt.batchId || !receipt.queueItemId) throw new Error('לא התקבל אישור מסירה תקין מהשרת. אפשר לנסות שוב.');
      pendingSubmission = null;
      adopt(receipt.board);
      update({ receipt, uncertain: false, error: null });
    }),
  };
}

export function createDecisionBoardClientCache() {
  const clients = new Map<string, ReturnType<typeof createDecisionBoardClient>>();
  return {
    get(scope: string, api: DecisionBoardApi, createRequestId: () => string) {
      let client = clients.get(scope);
      if (!client) { client = createDecisionBoardClient(api, createRequestId); clients.set(scope, client); }
      return client;
    },
  };
}
