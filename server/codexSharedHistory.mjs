const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Long live turns can exceed 2,000 items without being large in bytes.
const MAX_ITEM_PAGES = 1000;
const MAX_TURN_ITEM_BYTES = 128 * 1024 * 1024;

/** Select native history by stable input/turn ID, never guessed recency.
 * Pagination bounds item count, not bytes: one item can contain inline images.
 */
export async function readSharedHistoryTurns(rpc, threadId, clientId, turnId) {
  const meta = await rpc('thread/read', {threadId,includeTurns:false});
  if (!object(meta) || !object(meta.thread) || (meta.thread.id != null && meta.thread.id !== threadId)) throw Error('Shared history metadata unavailable');
  if (meta.thread.historyMode !== 'paginated') {
    const legacy = await rpc('thread/read', {threadId,includeTurns:true});
    if (!object(legacy) || !object(legacy.thread) || !Array.isArray(legacy.thread.turns)) throw Error('Shared history unavailable');
    return legacy.thread.turns;
  }
  let cursor = null;
  const result = [], seen = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await rpc('thread/turns/list', {threadId,cursor,limit:20,itemsView:'notLoaded',sortDirection:'desc'});
    if (!object(response) || !Array.isArray(response.data)) throw Error('Shared turn page unavailable');
    for (const turn of response.data) {
      if (!object(turn) || typeof turn.id !== 'string') throw Error('Shared turn identity unavailable');
      if (turnId && turn.id !== turnId) continue;
      let itemCursor = null, itemBytes = 0; const items = [], itemCursors = new Set();
      for (let itemPage = 0; itemPage < MAX_ITEM_PAGES; itemPage++) {
        const part = await rpc('thread/items/list', {threadId,turnId:turn.id,cursor:itemCursor,limit:20,sortDirection:'asc'});
        if (!object(part) || !Array.isArray(part.data)) throw Error('Shared item page unavailable');
        for (const entry of part.data) {
          if (!object(entry) || !object(entry.item) || entry.turnId !== turn.id) throw Error('Shared item custody unavailable');
          itemBytes += Buffer.byteLength(JSON.stringify(entry.item));
          if (itemBytes > MAX_TURN_ITEM_BYTES) throw Error('Shared history exceeds recovery budget');
          items.push(entry.item);
        }
        if (!part.nextCursor) break;
        if (typeof part.nextCursor !== 'string' || itemCursors.has(part.nextCursor) || itemPage === MAX_ITEM_PAGES - 1) throw Error('Shared item pagination unavailable');
        itemCursors.add(part.nextCursor); itemCursor = part.nextCursor;
      }
      if (!clientId || items.some(i => object(i) && i.type === 'userMessage' && i.clientId === clientId)) {
        result.push({...turn,items});
        if (clientId || turnId) return result;
      }
    }
    if (!response.nextCursor) return result;
    if (typeof response.nextCursor !== 'string' || seen.has(response.nextCursor)) throw Error('Shared history pagination unavailable');
    seen.add(response.nextCursor); cursor = response.nextCursor;
  }
  throw Error('Shared history exceeds reconciliation bound');
}
