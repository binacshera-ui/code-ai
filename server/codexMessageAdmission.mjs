/** Serialize duplicate HTTP admissions, not messages or agent turns. This keeps
 * a lost-ACK retry from crossing from the regular queue path into live delivery. */
const pending = new Map();
export async function withCodexMessageAdmission(profileId, requestId, operation) {
  const key = JSON.stringify([profileId, requestId]);
  const previous = pending.get(key) || Promise.resolve();
  const work = previous.catch(() => {}).then(operation);
  const tail = work.then(() => {}, () => {});
  pending.set(key, tail);
  try { return await work; }
  finally { if (pending.get(key) === tail) pending.delete(key); }
}

export function shouldAppendLiveMessage({ route, sessionId, draft, scheduledAt, recurrence, provider }) {
  return route === '/messages' && !draft && !!sessionId && !sessionId.startsWith('draft')
    && !scheduledAt && !recurrence && provider === 'codex';
}
