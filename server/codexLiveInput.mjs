/** Immediate input into the native active turn. No execution queue or worker. */
import { createHash } from 'node:crypto';
import { connectCodexLiveInput } from './codexLiveInputNative.mjs';
import { NATIVE_FRAME_BYTES } from './codexNativeTransport.mjs';

const id = (value, maximum = 128) => typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const validInput = item => object(item) && (item.type === 'text' && typeof item.text === 'string'
  || ['image', 'audio'].includes(item.type) && (nonempty(item.url) || nonempty(item.fileId))
  || ['localImage', 'localAudio'].includes(item.type) && nonempty(item.path)
  || ['skill', 'mention'].includes(item.type) && nonempty(item.name) && nonempty(item.path));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export class CodexLiveInputError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message); this.name = 'CodexLiveInputError'; this.code = code; this.statusCode = statusCode;
  }
}
const unconfirmed = () => new CodexLiveInputError('LIVE_INPUT_UNCONFIRMED',
  'לא ניתן עדיין לאמת אם ההודעה צורפה. היא לא תישלח שוב אוטומטית; אפשר לבדוק שוב עם אותו מזהה בקשה.');
const unavailable = () => new CodexLiveInputError('LIVE_INPUT_UNAVAILABLE',
  'חיבור הסבב הפעיל אינו זמין כרגע. ההודעה לא נוספה לתור.', 503);
const ended = () => new CodexLiveInputError('LIVE_TURN_ENDED',
  'הסבב הפעיל הסתיים לפני צירוף ההודעה. ההודעה לא נשלחה ולא נוספה לתור; אפשר לשלוח אותה מחדש במפורש.');

export function isCodexLiveInputError(error) { return error instanceof CodexLiveInputError; }
export function codexLiveInputClientId(requestId) { return 'code-ai:live:' + requestId; }
export function codexLiveInputPayloadHash({ sessionId, input, contextText, connectionOptions }) {
  return createHash('sha256').update(JSON.stringify(canonical({
    sessionId, input, contextText, codexHome: connectionOptions?.codexHome,
  }))).digest('hex');
}
function validate(value) {
  if (!object(value) || !id(value.profileId) || !id(value.sessionId) || !id(value.clientRequestId, 200)
      || typeof value.contextText !== 'string' || !object(value.connectionOptions)
      || !nonempty(value.connectionOptions.codexHome)
      || !Array.isArray(value.input) || !value.input.length
      || !value.input.every(validInput)
      || !value.input.some(item => item.type === 'text' ? Boolean(item.text.trim()) : true)
      || Buffer.byteLength(JSON.stringify(value.input)) + Buffer.byteLength(value.contextText) > NATIVE_FRAME_BYTES - 8192) {
    throw new CodexLiveInputError('LIVE_INPUT_INVALID', 'הודעת הצירוף אינה תקינה.', 400);
  }
}
function sameRequest(row, value, hash) {
  if (row.profileId !== value.profileId || row.sessionId !== value.sessionId || row.payloadHash !== hash) {
    throw new CodexLiveInputError('LIVE_INPUT_CONFLICT', 'מזהה הבקשה כבר משויך להודעה או לשיחה אחרת.');
  }
}
function delivered(row) {
  return { id: row.id, profileId: row.profileId, sessionId: row.sessionId,
    clientRequestId: row.clientRequestId, turnId: row.turnId, status: 'delivered', kind: 'active-turn' };
}
function finalState(row) {
  if (row.status === 'delivered') return delivered(row);
  if (row.status === 'not-delivered') {
    if (row.errorCode === 'LIVE_TURN_ENDED') throw ended();
    throw new CodexLiveInputError(row.errorCode || 'LIVE_INPUT_REJECTED', 'צירוף ההודעה נדחה; היא לא נוספה לתור.');
  }
  return null;
}

async function activeTurn(rpc, sessionId) {
  const read = await rpc('thread/read', { threadId: sessionId, includeTurns: false });
  if (read?.thread?.id !== sessionId) throw unavailable();
  const status = read.thread.status?.type;
  if (status === 'idle' || status === 'notLoaded') return null;
  if (status !== 'active') throw unavailable();
  const turns = await rpc('thread/turns/list', {
    threadId: sessionId, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded',
  });
  if (!Array.isArray(turns?.data)) throw unavailable();
  const active = turns.data.filter(turn => turn?.status === 'inProgress');
  if (active.length === 1 && id(active[0].id)) return active[0].id;
  if (active.length) throw unavailable();
  // Completion can win the history read, but an unknown active turn must never
  // be mistaken for idle and sent to the normal execution queue.
  const current = await rpc('thread/read', { threadId: sessionId, includeTurns: false });
  if (current?.thread?.id === sessionId && ['idle', 'notLoaded'].includes(current.thread.status?.type)) return null;
  throw unavailable();
}

async function containsInput(rpc, row) {
  let cursor; const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const result = await rpc('thread/items/list', {
      threadId: row.sessionId, turnId: row.turnId, limit: 100, sortDirection: 'asc',
      deferOutput: { commandExecution: true, mcpToolCall: true }, ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) throw unconfirmed();
    if (result.data.some(entry => entry?.item?.type === 'userMessage'
      && entry.item.clientId === codexLiveInputClientId(row.clientRequestId))) return true;
    if (!result.nextCursor) return false;
    if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw unconfirmed();
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw unconfirmed();
}

export function createCodexLiveInputService({ store, connect = connectCodexLiveInput }) {
  if (!store || typeof connect !== 'function') throw new TypeError('Live input receipt store and connector required');

  async function reconcile(connection, row) {
    try {
      if (await containsInput(connection.rpc, row)) return delivered(await store.markDelivered(row.id, row.turnId));
    } catch { /* Missing/unavailable history never authorizes retransmission. */ }
    const current = await store.markUnconfirmed(row.id);
    const result = finalState(current); if (result) return result;
    throw unconfirmed();
  }

  return {
    async append(value) {
      // Snapshot the exact envelope before awaiting persistence or native I/O.
      let hash;
      try { validate(value); value = structuredClone(value); hash = codexLiveInputPayloadHash(value); }
      catch { throw new CodexLiveInputError('LIVE_INPUT_INVALID', 'הודעת הצירוף אינה תקינה.', 400); }
      let row;
      try { row = await store.get(value.profileId, value.clientRequestId); }
      catch { throw unavailable(); }
      if (row) { sameRequest(row, value, hash); const result = finalState(row); if (result) return result; }
      let connection;
      try { connection = await connect(value.connectionOptions); }
      catch { if (row) throw unconfirmed(); throw unavailable(); }
      try {
        // Existing pending/unknown attempts are history checks only. No code
        // path retries a native input that might already have been accepted.
        if (row) return await reconcile(connection, row);
        let turnId;
        try { turnId = await activeTurn(connection.rpc, value.sessionId); }
        catch (error) { throw error instanceof CodexLiveInputError ? error : unavailable(); }
        if (!turnId) {
          // Another concurrent request may have reserved this same ID during
          // the state read. It must not fall through to ordinary queue/send.
          row = await store.get(value.profileId, value.clientRequestId);
          if (!row) return null;
          sameRequest(row, value, hash); const result = finalState(row);
          return result || await reconcile(connection, row);
        }
        const reservation = await store.reserve({ profileId: value.profileId, sessionId: value.sessionId,
          clientRequestId: value.clientRequestId, payloadHash: hash, turnId });
        row = reservation.row; sameRequest(row, value, hash);
        if (!reservation.created) {
          const result = finalState(row); return result || await reconcile(connection, row);
        }
        const clientId = codexLiveInputClientId(value.clientRequestId);
        let accepted;
        try {
          accepted = await connection.rpc('turn/steer', {
            threadId: value.sessionId, expectedTurnId: turnId, clientUserMessageId: clientId,
            input: value.input,
            additionalContext: { [clientId]: { kind: 'untrusted', name: 'code_ai_live_input', value: value.contextText } },
          });
        } catch (error) {
          if (error?.nativeRejected && [-32600, -32602].includes(error.code)) {
            const current = await store.markNotDelivered(row.id, 'LIVE_TURN_ENDED');
            const result = finalState(current); if (result) return result;
            throw ended();
          }
          if (error?.nativeRejected && error.admission === 'notAccepted') {
            const current = await store.markNotDelivered(row.id, 'LIVE_INPUT_REJECTED');
            const result = finalState(current); if (result) return result;
          }
          await store.markUnconfirmed(row.id);
          return await reconcile(connection, row);
        }
        if (accepted?.turnId !== turnId) {
          await store.markUnconfirmed(row.id);
          return await reconcile(connection, row);
        }
        return delivered(await store.markDelivered(row.id, turnId));
      } catch (error) {
        if (error instanceof CodexLiveInputError) throw error;
        // A receipt/persistence failure after reservation cannot establish that
        // no native input ran. Keep the stable request ID for reconciliation.
        if (row) throw unconfirmed();
        throw unavailable();
      } finally { try { await connection.close(); } catch { /* Delivery is decided by native history/ACK, not socket cleanup. */ } }
    },
  };
}
