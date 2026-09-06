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
    },
  };
}
