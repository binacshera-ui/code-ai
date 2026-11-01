export const DECISION_BOARD_LIMITS = {
  items: 50, options: 10, id: 120, title: 180, description: 1600,
  optionLabel: 180, optionDescription: 600, note: 4000, documentBytes: 512_000,
} as const;

export type DecisionBoardKind = 'approval' | 'single' | 'multiple' | 'text';
export interface DecisionBoardOption { id: string; label: string; description?: string }
export interface DecisionBoardAnswer {
  verdict: 'approved' | 'rejected' | null;
  optionIds: string[];
  note: string;
}
export interface DecisionBoardItemDefinition {
  id: string;
  title: string;
  description: string;
  kind: DecisionBoardKind;
  options: DecisionBoardOption[];
}
export interface DecisionBoardItem extends DecisionBoardItemDefinition {
  answer: DecisionBoardAnswer | null;
  answeredAt: string | null;
  submittedAt: string | null;
}
export interface DecisionBoard {
  enabled: boolean;
  title: string;
  revision: number;
  items: DecisionBoardItem[];
  updatedAt: string | null;
  /** An explicit delivery is unresolved; retry it unchanged before editing answers. */
  pendingDelivery?: boolean;
}
export interface DecisionBoardDefinitions { title: string; items: DecisionBoardItemDefinition[] }
export interface DecisionBoardMutation {
  expectedRevision: number;
  enabled?: boolean;
  title?: string;
  decisionId?: string;
  answer?: DecisionBoardAnswer;
  answers?: Array<{ decisionId: string; answer: DecisionBoardAnswer }>;
}
export interface DecisionBoardSubmitResult {
  board: DecisionBoard;
  batchId: string;
  queueItemId: string;
  duplicate: boolean;
}

export class DecisionBoardError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); this.name = 'DecisionBoardError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new DecisionBoardError(`שדה ${name} אינו תקין או ארוך מדי.`);
  }
  return value.trim();
}
export function decisionBoardId(value: unknown): string {
  const id = text(value, 'מזהה', DECISION_BOARD_LIMITS.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id)) {
    throw new DecisionBoardError('מזהה החלטה או אפשרות אינו תקין.');
  }
  return id;
}
export function createEmptyDecisionBoard(): DecisionBoard {
  return { enabled: false, title: 'לוח החלטות', revision: 0, items: [], updatedAt: null };
}
export function normalizeDecisionBoardDefinitions(value: unknown): DecisionBoardDefinitions {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > DECISION_BOARD_LIMITS.items) {
    throw new DecisionBoardError('לוח החלטות חייב לכלול עד 50 פריטים.');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DECISION_BOARD_LIMITS.documentBytes) throw new DecisionBoardError('לוח ההחלטות גדול מדי.');
  const ids = new Set<string>();
  const items = value.items.map((raw): DecisionBoardItemDefinition => {
    if (!object(raw)) throw new DecisionBoardError('פריט החלטה אינו תקין.');
    const id = decisionBoardId(raw.id);
    if (ids.has(id)) throw new DecisionBoardError('מזהה החלטה כפול.');
    ids.add(id);
    const kind = raw.kind;
    if (!['approval', 'single', 'multiple', 'text'].includes(String(kind))) throw new DecisionBoardError('סוג החלטה אינו תקין.');
    if (raw.options !== undefined && !Array.isArray(raw.options)) throw new DecisionBoardError('אפשרויות החלטה אינן תקינות.');
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    if (rawOptions.length > DECISION_BOARD_LIMITS.options) throw new DecisionBoardError('אפשר לשמור עד 10 אפשרויות לפריט.');
    if (['single', 'multiple'].includes(String(kind)) ? !rawOptions.length : rawOptions.length > 0) {
      throw new DecisionBoardError('מספר האפשרויות אינו מתאים לסוג ההחלטה.');
    }
    const optionIds = new Set<string>();
    const options = rawOptions.map(option => {
      if (!object(option)) throw new DecisionBoardError('אפשרות אינה תקינה.');
      const optionId = decisionBoardId(option.id);
      if (optionIds.has(optionId)) throw new DecisionBoardError('מזהה אפשרות כפול.');
      optionIds.add(optionId);
      const description = text(option.description, 'תיאור אפשרות', DECISION_BOARD_LIMITS.optionDescription, true);
      return { id: optionId, label: text(option.label, 'אפשרות', DECISION_BOARD_LIMITS.optionLabel), ...(description ? { description } : {}) };
    });
    return { id, title: text(raw.title, 'כותרת החלטה', DECISION_BOARD_LIMITS.title),
      description: text(raw.description, 'תיאור החלטה', DECISION_BOARD_LIMITS.description, true), kind: kind as DecisionBoardKind, options };
  });
  return { title: text(value.title ?? 'לוח החלטות', 'כותרת הלוח', DECISION_BOARD_LIMITS.title), items };
}
export function normalizeDecisionBoardAnswer(item: DecisionBoardItemDefinition, raw: unknown): DecisionBoardAnswer {
  if (!object(raw) || ![null, 'approved', 'rejected'].includes(raw.verdict as string | null)
    || !Array.isArray(raw.optionIds) || raw.optionIds.length > DECISION_BOARD_LIMITS.options) {
    throw new DecisionBoardError('תשובת ההחלטה אינה תקינה.');
  }
  const note = text(raw.note, 'הערה', DECISION_BOARD_LIMITS.note, true);
  const ids = raw.optionIds.map(decisionBoardId);
  if (new Set(ids).size !== ids.length || ids.some(id => !item.options.some(option => option.id === id))) {
    throw new DecisionBoardError('בחר אפשרויות קיימות ללא כפילויות.');
  }
  const verdict = raw.verdict as DecisionBoardAnswer['verdict'];
  if (item.kind === 'approval' ? !verdict || ids.length > 0 : verdict !== null) throw new DecisionBoardError('תשובה אינה מתאימה לסוג ההחלטה.');
  if (item.kind === 'single' && ids.length !== 1) throw new DecisionBoardError('יש לבחור אפשרות אחת.');
  if (item.kind === 'multiple' && ids.length < 1) throw new DecisionBoardError('יש לבחור לפחות אפשרות אחת.');
  if (item.kind === 'text' && (!note || ids.length > 0)) throw new DecisionBoardError('יש להזין תשובה כתובה.');
  // Multiple choice is a set, not a click-order-dependent value.
  return { verdict, optionIds: item.options.map(option => option.id).filter(id => ids.includes(id)), note };
}
export function extractDecisionBoardDefinitionsFromText(value: string): DecisionBoardDefinitions[] {
  const found: DecisionBoardDefinitions[] = [];
  for (const match of value.matchAll(/```code-ai-decisions\s*\n([\s\S]*?)```/g)) {
    if (match[1].length > DECISION_BOARD_LIMITS.documentBytes) continue;
    try { found.push(normalizeDecisionBoardDefinitions(JSON.parse(match[1]))); } catch { /* malformed agent output is not a user decision */ }
  }
  return found;
}
