import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecisionBoard, DecisionBoardItem } from '../../../../shared/decisionBoard';
import type { CodexUserInputRequest } from '../../../../shared/codexUserInput';
import { DecisionBoardView, type DecisionBoardViewProps } from './DecisionBoardDialog';
import type { DecisionBoardClientState } from './decisionBoardClient';

const definition = (kind: DecisionBoardItem['kind'], id: string): DecisionBoardItem => ({ id, kind, title: `כותרת ${id}`, description: '', options: kind === 'single' || kind === 'multiple' ? [{ id: 'a', label: 'אפשרות א', description: 'פשוט ומהיר' }, { id: 'b', label: 'אפשרות ב' }] : [], answer: null, answeredAt: null, submittedAt: null });
const board: DecisionBoard = { enabled: true, title: 'החלטות', revision: 1, updatedAt: null, items: [definition('approval', 'approve'), definition('single', 'single'), definition('multiple', 'multi'), definition('text', 'note')] };
function props(patch: Partial<DecisionBoardClientState> = {}): DecisionBoardViewProps {
  return { state: { board, drafts: {}, loading: false, saving: false, submitting: false, error: null, uncertain: false, receipt: null, ...patch }, onChange: () => {}, onSave: async () => true, onSubmit: async () => true, onEnabled: async () => true, onRefresh: () => {}, onClose: () => {} };
}
const submitTag = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(tag => /שלח לסוכן|נסה לשלוח שוב/.test(tag))!;

test('four decision kinds render compact accessible controls, notes, progress and explicit send', () => {
  const html = renderToStaticMarkup(<DecisionBoardView {...props()} />);
  for (const text of ['מאשר', 'דוחה', 'אפשרות א', 'פשוט ומהיר', 'הוסף הערה', 'התשובה שלך', 'שמור בחירות', 'שלח לסוכן', 'רק שליחה מפורשת']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('type="radio"') && html.includes('type="checkbox"'));
  assert.ok(html.includes('role="progressbar"') && html.includes('aria-valuenow="0"') && html.includes('aria-valuemax="4"'));
  assert.ok(html.includes('role="switch"') && html.includes('aria-checked="true"'));
  assert.ok(html.includes('maxLength="4000"') && html.includes('dir="auto"'));
  assert.ok(submitTag(html).includes('disabled=""'));
});

test('local changes are explicitly unsaved, not reported as durable delivery', () => {
  const html = renderToStaticMarkup(<DecisionBoardView {...props({ drafts: { approve: { verdict: 'rejected', optionIds: [], note: 'לא כעת' } } })} />);
  assert.ok(html.includes('שינוי שלא נשמר') && html.includes('1 שינויים לא נשמרו'));
  assert.ok(html.includes('לא לאחר רענון הדף') && html.includes('בטל שינוי'));
  assert.ok(!html.includes('הבחירות נמסרו לתור השיחה'));
  assert.ok(!submitTag(html).includes('disabled=""'));
});

test('disabled board cannot send ordinary choices but pending-delivery retry stays enabled', () => {
  const answered = { ...definition('approval', 'approve'), answer: { verdict: 'approved' as const, optionIds: [], note: '' }, answeredAt: 'saved' };
  const off = { ...board, enabled: false, items: [answered] };
  const ordinary = renderToStaticMarkup(<DecisionBoardView {...props({ board: off })} />);
  assert.ok(submitTag(ordinary).includes('disabled=""'));
  const retry = renderToStaticMarkup(<DecisionBoardView {...props({ board: { ...off, pendingDelivery: true } })} />);
  assert.ok(submitTag(retry).includes('נסה לשלוח שוב') && !submitTag(retry).includes('disabled=""'));
  assert.ok(retry.includes('המסירה לתור עדיין לא אומתה'));
  assert.ok(!retry.includes('הבחירות נשמרו · עדיין לא נשלחו לסוכן'));
});

test('model question text is escaped and never interpreted as HTML', () => {
  const evil = { ...definition('approval', 'safe'), title: '<script>unsafe</script>', description: '<img src=x onerror=unsafe>' };
  const html = renderToStaticMarkup(<DecisionBoardView {...props({ board: { ...board, items: [evil] } })} />);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&lt;img'));
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'));
});

test('native public questions reuse existing card; secret questions are not duplicated', () => {
  const native: CodexUserInputRequest = { id: 'rpc-one', profileId: 'developer', sessionId: 's', runId: 'r', turnId: 't', itemId: 'i', isBlocking: true, status: 'pending', createdAt: '2026-11-01T10:00:00Z', resolvedAt: null, questions: [{ id: 'q', header: 'בחירה', question: 'איך להמשיך?', options: null, isOther: false, isSecret: false }] };
  const secret = { ...native, id: 'rpc-secret', questions: [{ ...native.questions[0], question: 'DO_NOT_DUPLICATE_SECRET_PROMPT', isSecret: true }] };
  const value = { ...props(), native: { requests: [native, secret], submittingId: null, error: null, answer: async () => {} } };
  const html = renderToStaticMarkup(<DecisionBoardView {...value} />);
  assert.ok(html.includes('שאלה מ-Codex') && html.includes('איך להמשיך?'));
  assert.ok(html.includes('שאלה חסויה פתוחה בשיחה') && html.includes('ענה בשיחה'));
  assert.ok(!html.includes('DO_NOT_DUPLICATE_SECRET_PROMPT') && !html.includes('type="password"'));
});

test('empty board explains activation without claiming that choices already exist', () => {
  const html = renderToStaticMarkup(<DecisionBoardView {...props({ board: { ...board, enabled: false, items: [] } })} />);
  assert.ok(html.includes('הפעל החלטות בשיחה') && html.includes('הפעל החלטות ובקש מהסוכן'));
  assert.ok(!html.includes('הבחירות נמסרו לתור השיחה'));
});
