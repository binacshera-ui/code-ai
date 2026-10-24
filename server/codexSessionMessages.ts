/** Adapt the public message events emitted by newer Codex rollouts to our
 * existing timeline format. response_item messages are intentionally left
 * alone: they repeat these events and also contain injected context. */
export function normalizeCodexSessionRow(row: any): any {
  if (row?.type !== 'event_msg' || row.payload?.type !== 'item_completed') return row;
  const item = row.payload.item;
  if (!item || !['UserMessage', 'AgentMessage'].includes(item.type)) return row;
  const message = Array.isArray(item.content)
    ? item.content
      .filter((part: any) => ['text', 'Text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string')
      .map((part: any) => part.text)
      .join('\n')
    : typeof item.content === 'string' ? item.content : '';
  return {
    ...row,
    payload: {
      ...row.payload,
      type: item.type === 'UserMessage' ? 'user_message' : 'agent_message',
      message,
      phase: item.phase === 'commentary' ? 'commentary' : 'final',
      nativeItemId: typeof item.id==='string'?item.id:undefined,
      clientUserMessageId: typeof item.clientId==='string'?item.clientId:undefined,
      messageProjectionSource:'item_completed',
    },
  };
}

/** One public message can be recorded both as a legacy event and an item.
 * Deduplicate proven item/client identities or two representations at the SAME
 * timestamp. Equal text from real follow-up/retry turns must remain visible.
 */
export function createCodexMessageProjection(initial: any[] = []) {
  const identities=new Set<string>(),representations=new Map<string,string>();
  function remember(role:string,kind:string,text:string,timestamp:string,itemId?:string,clientId?:string,source?:string) {
    const keys=[itemId?'item:'+itemId:null,clientId&&role==='user'?'client:'+clientId:null].filter((x):x is string=>!!x);
    const key=JSON.stringify([role,kind,text.trim(),timestamp]);
    const duplicate=keys.some(k=>identities.has(k))||!!timestamp&&!!source&&representations.has(key)&&representations.get(key)!==source;
    for(const identity of keys)identities.add(identity);if(timestamp&&source)representations.set(key,source);
    // Display-only metadata has a bounded window; original transcripts remain untouched.
    if(identities.size>4096)identities.delete(identities.values().next().value!);
    if(representations.size>512)representations.delete(representations.keys().next().value!);
    return duplicate;
  }
  for(const e of initial)if(e.entryType==='message')remember(e.role,e.kind,e.text||'',e.timestamp,e.nativeItemId,e.clientUserMessageId,e.messageProjectionSource);
  return (raw:any):any=>{
    const row=normalizeCodexSessionRow(raw);if(row?.type!=='event_msg')return row;
    const p=row.payload||{};if(p.type==='task_started')representations.clear();
    if(!['user_message','agent_message'].includes(p.type)||typeof p.message!=='string')return row;
    const role=p.type==='user_message'?'user':'assistant',kind=role==='user'?'prompt':p.phase==='commentary'?'commentary':'final';
    const source=p.messageProjectionSource||'legacy_event',itemId=p.nativeItemId||(typeof p.item_id==='string'?p.item_id:undefined),clientId=p.clientUserMessageId||p.client_user_message_id;
    if(remember(role,kind,p.message,row.timestamp||'',itemId,clientId,source))return null;
    return {...row,payload:{...p,nativeItemId:itemId,clientUserMessageId:clientId,messageProjectionSource:source}};
  };
}
