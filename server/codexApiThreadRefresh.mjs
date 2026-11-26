/** Refresh session-static API model metadata without changing the user's
 * selected execution settings or submitting any input. The caller supplies the
 * catalog file already configured for this managed native owner.
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isCodexApiModel } from '../shared/codexApiModels.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const settings = value => Object.fromEntries([
  'model', 'modelProvider', 'cwd', 'reasoningEffort', 'serviceTier',
  'approvalPolicy', 'approvalsReviewer', 'sandbox',
].map(key => [key, value[key]]));

function refusedBeforeDetach(error) {
  return error?.code === -32001
    && (error?.admission === 'notAccepted' || error?.delivery === 'notAccepted'
      || error?.data?.codeAiAdmission === 'notAccepted');
}

export async function refreshCodexApiThread({ rpc, threadResult, model, recovery, managedOwner, catalogFile }) {
  const thread = threadResult?.thread;
  if (!managedOwner || recovery || !isCodexApiModel(model) || !object(threadResult)
      || !object(thread) || typeof thread.id !== 'string' || !thread.id
      || thread.status?.type !== 'idle') return threadResult;
  if (typeof catalogFile !== 'string' || !path.isAbsolute(catalogFile)) {
    throw new Error('Configured API model catalog is unavailable; no input was submitted');
  }

  const threadId = thread.id;
  // A queued native input owns its existing delivery and settings. Never detach
  // it to refresh metadata, and never interpret an incomplete queue read as empty.
  const queue = await rpc('thread/queue/list', { threadId, limit: 1 });
  if (!object(queue) || !Array.isArray(queue.data)) {
    throw new Error('Native queue inspection unavailable; no input was submitted');
  }
  if (queue.data.length || queue.nextCursor) return threadResult;

  let detached;
  try {
    detached = await rpc('thread/unsubscribe', { threadId });
  } catch (error) {
    // Only a proven broker admission rejection establishes that nothing was
    // detached. A lost acknowledgement must propagate before any new input.
    if (refusedBeforeDetach(error)) return threadResult;
    throw error;
  }
  if (!object(detached) || !['unsubscribed', 'notSubscribed', 'notLoaded'].includes(detached.status)) {
    throw new Error('Native subscription refresh acknowledgement unavailable; no input was submitted');
  }
  // Codex 0.171 only refreshes this metadata when resubscribing with the same
  // catalog override. Plain resume and hot-reload do not refresh loaded models.
  // Do not pass model, effort, permissions, cwd or any other settings here.
  const refreshed = await rpc('thread/resume', {
    threadId, excludeTurns: true, config: { model_catalog_json: catalogFile },
  });
  if (!object(refreshed) || refreshed.thread?.id !== threadId
      || !isDeepStrictEqual(settings(refreshed), settings(threadResult))) {
    throw new Error('Native subscription refresh changed execution settings; no input was submitted');
  }
  return refreshed;
}
