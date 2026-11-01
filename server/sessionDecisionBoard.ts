import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODEX_APP_CONFIG } from './config.js';
import {
  createEmptyDecisionBoard, decisionBoardId, DecisionBoardError, DECISION_BOARD_LIMITS,
  extractDecisionBoardDefinitionsFromText, normalizeDecisionBoardAnswer, normalizeDecisionBoardDefinitions,
  type DecisionBoard, type DecisionBoardAnswer, type DecisionBoardItem, type DecisionBoardMutation,
  type DecisionBoardSubmitResult,
} from '../shared/decisionBoard.js';

export interface DecisionBoardEnqueueInput {
  profileId: string; sourceProfileId?: string; queueKey: string; sessionId?: string; clientRequestId: string; prompt: string; promptPreview: string;
}
export type DecisionBoardEnqueue = (input: DecisionBoardEnqueueInput) => Promise<{ id: string }>;
interface StoredBoard {
  version: 1; recordId: string; profileId: string; sessionKey: string; board: DecisionBoard;
  pendingBatchId: string | null; lastBatchId: string | null;
}
interface BoardAlias { version: 1; profileId: string; sessionKey: string; redirectSessionKey: string }
interface DecisionBatch {
  version: 1; id: string; recordId: string; profileId: string; sessionKey: string; title: string;
  clientRequestId: string; requestId: string | null; sourceRevision: number;
  createdAt: string; submittedAt: string | null; queueItemId: string | null; items: DecisionBoardItem[];
}
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A bounded document per conversation, plus separately stored immutable answer
 * batches. This never rewrites every conversation or starts a native writer. */
export function createSessionDecisionBoardService(options: { storageRoot: string; now?: () => string }) {
  const root = path.join(options.storageRoot, 'local', 'decision-boards');
  const timestamp = () => options.now?.() || new Date().toISOString();
  let tail: Promise<unknown> = Promise.resolve();
  const deliveries = new Map<string, Promise<DecisionBoardSubmitResult>>();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.catch(() => undefined).then(operation);
    tail = result.catch(() => undefined);
    return result;
  }
  function scope(profile: string, session: string) {
    if (typeof profile !== 'string' || typeof session !== 'string' || !profile.trim() || !session.trim()
      || profile.length > 240 || session.length > 512 || /[\0\r\n]/.test(profile + session)) {
      throw new DecisionBoardError('פרופיל ושיחה תקינים נדרשים.');
    }
    return { profileId: profile.trim(), sessionKey: session.trim() };
  }
  const recordFile = (profile: string, session: string) => path.join(root, digest([profile, session]) + '.json');
  function batchFile(recordId: string, batchId: string) {
    if (!/^[a-f0-9-]{36}$/.test(recordId) || !/^batch-[a-f0-9]{32}$/.test(batchId)) throw new Error('Invalid stored decision batch identity');
    return path.join(root, 'batches', recordId, batchId + '.json');
  }
  async function readJson(file: string): Promise<any | null> {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) throw new Error('Stored decision board exceeds the size limit');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  async function writeJson(file: string, value: unknown) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 2 * 1024 * 1024) throw new DecisionBoardError('לוח ההחלטות גדול מדי.', 413);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, file);
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } catch (error: any) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error; }
      finally { await directory.close(); }
    } finally { await handle?.close().catch(() => undefined); await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
  async function load(profile: string, session: string): Promise<StoredBoard> {
    const requested = scope(profile, session);
    let key = requested.sessionKey;
    const visited = new Set<string>();
    for (let hop = 0; hop < 16; hop++) {
      if (visited.has(key)) throw new Error('Decision board alias cycle');
      visited.add(key);
      const value = await readJson(recordFile(requested.profileId, key));
      if (!value) {
        if (hop > 0) throw new Error('Decision board alias target is missing');
        return { version: 1, recordId: randomUUID(), profileId: requested.profileId, sessionKey: key,
          board: createEmptyDecisionBoard(), pendingBatchId: null, lastBatchId: null };
      }
      if (value.version !== 1 || value.profileId !== requested.profileId || value.sessionKey !== key) throw new Error('Stored decision board scope is invalid');
      if (typeof value.redirectSessionKey === 'string') { key = scope(requested.profileId, value.redirectSessionKey).sessionKey; continue; }
      if (typeof value.recordId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.recordId)
        || !Number.isSafeInteger(value.board?.revision) || value.board.revision < 0
        || typeof value.board.enabled !== 'boolean') throw new Error('Stored decision board is invalid');
      const definitions = normalizeDecisionBoardDefinitions(value.board);
      value.board.items = definitions.items.map((definition, index) => {
        const item = value.board.items[index];
        return { ...definition, answer: item.answer ? normalizeDecisionBoardAnswer(definition, item.answer) : null,
          answeredAt: typeof item.answeredAt === 'string' ? item.answeredAt : null,
          submittedAt: typeof item.submittedAt === 'string' ? item.submittedAt : null };
      });
      return value as StoredBoard;
    }
    throw new Error('Decision board alias chain is too long');
  }
  const save = (record: StoredBoard) => writeJson(recordFile(record.profileId, record.sessionKey), record);
  const clientBoard = (record: StoredBoard): DecisionBoard => ({ ...clone(record.board), pendingDelivery: Boolean(record.pendingBatchId) });
  function checkRevision(record: StoredBoard, expected: number) {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new DecisionBoardError('נדרשת גרסת לוח תקינה.');
    if (record.board.revision !== expected) throw new DecisionBoardError('לוח ההחלטות השתנה. רענן לפני שמירה.', 409);
  }
  function changed(record: StoredBoard) { record.board.revision++; record.board.updatedAt = timestamp(); }
  async function loadBatch(record: StoredBoard, id: string): Promise<DecisionBatch> {
    const batch = await readJson(batchFile(record.recordId, id));
    if (!batch || batch.version !== 1 || batch.id !== id || batch.recordId !== record.recordId
      || batch.profileId !== record.profileId || !Array.isArray(batch.items)) throw new Error('Stored decision batch is invalid');
    return batch;
  }
  async function applySubmitted(record: StoredBoard, batch: DecisionBatch) {
    if (!batch.submittedAt || !batch.queueItemId) return;
    let touched = record.pendingBatchId === batch.id;
    for (const snapshot of batch.items) {
      const item = record.board.items.find(item => item.id === snapshot.id);
      if (item && equal(item.answer, snapshot.answer) && item.submittedAt !== batch.submittedAt) {
        item.submittedAt = batch.submittedAt; touched = true;
      }
    }
    if (touched) {
      record.pendingBatchId = null; record.lastBatchId = batch.id; changed(record); await save(record);
    }
  }
  async function getSessionDecisionBoard(profile: string, key: string): Promise<DecisionBoard> {
    await tail;
    return clientBoard(await load(profile, key));
  }
  async function setSessionDecisionBoard(profile: string, key: string, input: DecisionBoardMutation): Promise<DecisionBoard> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DecisionBoardError('עדכון הלוח אינו תקין.');
    if (input.answers !== undefined && !Array.isArray(input.answers)) throw new DecisionBoardError('אוסף התשובות אינו תקין.');
    return serial(async () => {
      const record = await load(profile, key); checkRevision(record, input.expectedRevision);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new DecisionBoardError('ערך הפעלת הלוח אינו תקין.');
      const edits = input.answers ? [...input.answers] : [];
      if (input.decisionId !== undefined || input.answer !== undefined) {
        if (!input.decisionId || !input.answer || input.answers) throw new DecisionBoardError('יש למסור תשובה אחת או אוסף תשובות, לא את שניהם.');
        edits.push({ decisionId: input.decisionId, answer: input.answer });
      }
      if (!Array.isArray(edits) || edits.length > DECISION_BOARD_LIMITS.items) throw new DecisionBoardError('מספר תשובות אינו תקין.');
      if (record.pendingBatchId && edits.length) throw new DecisionBoardError('העברת התשובות הקודמת ממתינה לאימות. נסה לשלוח אותה שוב לפני עריכה.', 409);
      const seen = new Set<string>();
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new DecisionBoardError('תשובת ההחלטה אינה תקינה.');
        const id = decisionBoardId(edit.decisionId);
        if (seen.has(id)) throw new DecisionBoardError('תשובה כפולה לאותה החלטה.');
        seen.add(id);
        const item = record.board.items.find(item => item.id === id);
        if (!item) throw new DecisionBoardError('פריט ההחלטה לא נמצא בלוח.', 404);
        const answer = normalizeDecisionBoardAnswer(item, edit.answer);
        if (!equal(item.answer, answer)) { item.answer = answer; item.answeredAt = timestamp(); item.submittedAt = null; }
      }
      if (input.title !== undefined) record.board.title = normalizeDecisionBoardDefinitions({ title: input.title, items: [] }).title;
      if (input.enabled !== undefined) record.board.enabled = input.enabled;
      changed(record); await save(record); return clientBoard(record);
    });
  }
  async function ingestSessionDecisionBoardFromText(profile: string, key: string, value: string | null | undefined): Promise<DecisionBoard | null> {
    if (!value) return null;
    const definition = extractDecisionBoardDefinitionsFromText(value).at(-1);
    if (!definition) return null;
    return serial(async () => {
      const record = await load(profile, key);
      if (!record.board.enabled) return null;
      const current = new Map(record.board.items.map(item => [item.id, item]));
      const next = definition.items.map(item => {
        const previous = current.get(item.id);
        // Human answers bind to the exact question/option semantics they saw.
        return previous?.answer ? previous : { ...item, answer: null, answeredAt: null, submittedAt: null };
      });
      for (const previous of record.board.items) if (previous.answer && !next.some(item => item.id === previous.id)) next.push(previous);
      if (next.length > DECISION_BOARD_LIMITS.items) throw new DecisionBoardError('אין מקום לפריטים נוספים בלי לאבד היסטוריית תשובות.', 409);
      if (equal(next, record.board.items) && definition.title === record.board.title) return clientBoard(record);
      record.board.items = next; record.board.title = definition.title; changed(record); await save(record); return clientBoard(record);
    });
  }
  async function buildSessionDecisionBoardPromptAdditions(profile: string, key: string): Promise<string | null> {
    const board = await getSessionDecisionBoard(profile, key);
    if (!board.enabled) return null;
    const visibleToAgent = { ...board, items: board.items.map(item => item.submittedAt ? item : {
      ...item, answer: null, answeredAt: null,
    }) };
    return [
      'לוח החלטות פעיל בשיחה הזאת. זהו לוח כללי לבחירות, אישורים והערות — לא תיק תמיכה ולא מרכז תקלות.',
      'כאשר נדרשת הכרעת משתמש, הצג שאלות ממוקדות בסוף תשובתך בתוך בלוק JSON יחיד ```code-ai-decisions. אין צורך לייצר שאלות אם אפשר להתקדם בבטחה.',
      'סכימה: {"title":"כותרת","items":[{"id":"stable-id","title":"שאלה","description":"הסבר","kind":"approval|single|multiple|text","options":[{"id":"stable-option","label":"אפשרות","description":"הסבר"}]}]}. באישור או טקסט options הוא [].',
      'שמור מזהים ושאלות יציבים. אל תשנה את משמעות פריט שכבר נענה, אל תמחק תשובות משתמש ואל תמציא אישור. תשובות שמורות אינן נשלחות אוטומטית; רק פעולת משתמש מפורשת מעבירה אותן להמשך.',
      'הכרעה אינה מרחיבה הרשאות ואינה מאשרת פעולה שלא נשאלה. כשנמסרו תשובות להמשך, פעל לפיהן בלי לפתוח לולאת אישורים כפולים.',
      JSON.stringify(visibleToAgent),
    ].join('\n\n');
  }
  async function rebindSessionDecisionBoard(profile: string, from: string, to: string): Promise<void> {
    if (!from || !to || from === to) return;
    await serial(async () => {
      const source = await load(profile, from); const destination = await load(profile, to);
      if (source.sessionKey === destination.sessionKey) return;
      if (!source.board.revision && !source.board.items.length) return;
      if (destination.board.revision && destination.recordId !== source.recordId) {
        throw new DecisionBoardError('לשיחה היעד כבר יש לוח אחר. הלוחות נשמרו ללא דריסה.', 409);
      }
      // A retry after the destination write must not overwrite a newer edit
      // already made under that canonical conversation identity.
      if (destination.recordId !== source.recordId) await save({ ...source, sessionKey: destination.sessionKey });
      const alias: BoardAlias = { version: 1, profileId: source.profileId, sessionKey: source.sessionKey, redirectSessionKey: destination.sessionKey };
      await writeJson(recordFile(source.profileId, source.sessionKey), alias);
    });
  }
  async function submitSessionDecisionBoard(profile: string, key: string, input: { expectedRevision: number; requestId?: string }, enqueue: DecisionBoardEnqueue): Promise<DecisionBoardSubmitResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new DecisionBoardError('נדרשת גרסת לוח תקינה.');
    if (typeof enqueue !== 'function') throw new DecisionBoardError('לא נמצא תור ההמשך של השיחה.');
    const prepared = await serial(async () => {
      const record = await load(profile, key);
      const requestId = input.requestId === undefined ? null : decisionBoardId(input.requestId);
      const requestedBatchId = requestId ? `batch-${digest([record.recordId, requestId]).slice(0, 32)}` : null;
      let batch: DecisionBatch | null = record.pendingBatchId ? await loadBatch(record, record.pendingBatchId) : null;
      if (!batch && requestedBatchId && await readJson(batchFile(record.recordId, requestedBatchId))) batch = await loadBatch(record, requestedBatchId);
      if (batch) { await applySubmitted(record, batch); return { record, batch, duplicate: true }; }
      checkRevision(record, input.expectedRevision);
      const items = record.board.items.filter(item => item.answer && !item.submittedAt);
      if (!items.length && record.lastBatchId) return { record, batch: await loadBatch(record, record.lastBatchId), duplicate: true };
      if (!items.length) throw new DecisionBoardError('אין תשובות חדשות להעברה לסוכן.', 409);
      if (!record.board.enabled) throw new DecisionBoardError('יש להפעיל את לוח ההחלטות לפני העברה לסוכן.', 409);
      const id = requestedBatchId || `batch-${randomUUID().replace(/-/g, '')}`;
      batch = { version: 1, id, recordId: record.recordId, profileId: record.profileId, sessionKey: record.sessionKey,
        title: record.board.title, clientRequestId: `decision-board:${record.recordId}:${id}`,
        requestId, sourceRevision: record.board.revision, createdAt: timestamp(), submittedAt: null, queueItemId: null, items: clone(items) };
      await writeJson(batchFile(record.recordId, id), batch);
      record.pendingBatchId = id; changed(record); await save(record);
      return { record, batch, duplicate: false };
    });
    const { record, batch } = prepared;
    if (batch.queueItemId && batch.submittedAt) return { board: clientBoard(record), batchId: batch.id, queueItemId: batch.queueItemId, duplicate: true };
    const deliveryKey = record.recordId + ':' + batch.id;
    let delivery = deliveries.get(deliveryKey);
    const duplicate = prepared.duplicate || Boolean(delivery);
    if (!delivery) {
      delivery = (async () => {
        const result = await enqueue({ profileId: batch.profileId, queueKey: batch.sessionKey,
          ...(!/^draft[:-]/.test(batch.sessionKey) ? { sessionId: batch.sessionKey } : {}), clientRequestId: batch.clientRequestId,
          promptPreview: `החלטות המשתמש · ${batch.title}`,
          prompt: ['המשתמש העביר במפורש את התשובות הבאות מלוח ההחלטות של השיחה הזאת.',
            'המשך את אותה עבודה בהתאם לבחירות ולהערות; אל תפרש פריט שנדחה כאישור ואל תיצור שיחה חלופית.',
            JSON.stringify({ boardTitle: batch.title, batchId: batch.id, decisions: batch.items.map(item => ({
              id: item.id, title: item.title, description: item.description, kind: item.kind, options: item.options, answer: item.answer,
            })) })].join('\n\n') });
        if (!result || typeof result.id !== 'string' || !result.id) throw new Error('Decision continuation did not receive a durable queue acknowledgement');
        return serial(async () => {
          const current = await load(profile, key); const stored = await loadBatch(current, batch.id);
          if (!stored.queueItemId) { stored.queueItemId = result.id; stored.submittedAt = timestamp(); await writeJson(batchFile(current.recordId, stored.id), stored); }
          await applySubmitted(current, stored);
          return { board: clientBoard(current), batchId: stored.id, queueItemId: stored.queueItemId!, duplicate: false };
        });
      })();
      deliveries.set(deliveryKey, delivery);
      void delivery.then(() => deliveries.delete(deliveryKey), () => deliveries.delete(deliveryKey));
    }
    return { ...await delivery, duplicate };
  }
  return { getSessionDecisionBoard, setSessionDecisionBoard, ingestSessionDecisionBoardFromText,
    buildSessionDecisionBoardPromptAdditions, rebindSessionDecisionBoard, submitSessionDecisionBoard };
}

const defaultService = createSessionDecisionBoardService({ storageRoot: CODEX_APP_CONFIG.storageRoot });
export const { getSessionDecisionBoard, setSessionDecisionBoard, ingestSessionDecisionBoardFromText,
  buildSessionDecisionBoardPromptAdditions, rebindSessionDecisionBoard, submitSessionDecisionBoard } = defaultService;
