import type { CodexRationalRun } from '../../../../shared/codexWorkModes';

type Request = <T>(url: string, init?: RequestInit) => Promise<T>;
export interface WorkModeOwnerScope { profileId: string; sessionKey: string }
interface QueueItem { id: string; status: string; workModeRunId?: string | null }

const held = (run: CodexRationalRun) => run.enabled && !run.holdReleasedAt
  && ['expired', 'incomplete'].includes(run.status);
const query = (scope: WorkModeOwnerScope) => new URLSearchParams({
  profileId: scope.profileId, sessionKey: scope.sessionKey,
});

/** Only call at an explicit owner action, never from status polling or a timer. */
export async function releaseWorkModeHoldsForUser(request: Request, scope: WorkModeOwnerScope) {
  const { runs } = await request<{ runs: CodexRationalRun[] }>(
    `/api/codex/work-mode-runs?${query(scope)}`);
  const holds = runs.filter(held);
  if (holds.some(run => run.profileId !== scope.profileId || !run.finishedAt)) {
    throw new Error('בקשת העצירה עדיין באימות. ההודעה לא נשלחה; אפשר לשלוח שוב לאחר אישור העצירה.');
  }
  for (const run of holds) await releaseRun(request, scope, run);
}

async function releaseRun(request: Request, scope: WorkModeOwnerScope, run: CodexRationalRun) {
  await request(`/api/codex/work-mode-runs/${encodeURIComponent(run.runId)}/release`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope),
  });
}

/** Stop once through the existing writer; release only this plan after confirmed cancellation. */
export async function stopQueueItemForUser<T extends QueueItem>(request: Request, itemId: string,
  scope: WorkModeOwnerScope, onUpdate: (item: T) => void,
  options: { attempts?: number; wait?: () => Promise<void> } = {}) {
  let { item } = await request<{ item: T }>(`/api/codex/queue/items/${encodeURIComponent(itemId)}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
  });
  const runId = item.workModeRunId;
  const wait = options.wait || (() => new Promise<void>(resolve => setTimeout(resolve, 500)));
  for (let attempt = 0; ; attempt++) {
    if (item.id !== itemId) throw new Error('השרת החזיר הרצה אחרת; לא שוחררה תוכנית.');
    onUpdate(item);
    if (!runId || !['cancelling', 'cancelled'].includes(item.status)) return;
    if (item.status === 'cancelled') {
      const { runs } = await request<{ runs: CodexRationalRun[] }>(
        `/api/codex/work-mode-runs?${query(scope)}`);
      const run = runs.find(run => run.runId === runId);
      if (run && run.profileId !== scope.profileId) throw new Error('התוכנית שייכת לפרופיל אחר.');
      if (run?.finishedAt) {
        if (run.outcome === 'cancelled' && held(run)) await releaseRun(request, scope, run);
        return;
      }
    }
    // A timeout is pending cancellation, never proof of a stop. A later explicit
    // send checks the persisted run again; no input is replayed here.
    if (attempt >= (options.attempts ?? 20)) return;
    await wait();
    ({ item } = await request<{ item: T }>(
      `/api/codex/queue/items/${encodeURIComponent(itemId)}?includeSession=false`));
  }
}
