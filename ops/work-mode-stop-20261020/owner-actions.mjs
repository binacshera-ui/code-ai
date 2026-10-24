// client/src/components/codex/workModeOwnerActions.ts
var held = (run) => run.enabled && !run.holdReleasedAt && ["expired", "incomplete"].includes(run.status);
var query = (scope) => new URLSearchParams({
  profileId: scope.profileId,
  sessionKey: scope.sessionKey
});
async function releaseWorkModeHoldsForUser(request, scope) {
  const { runs } = await request(
    `/api/codex/work-mode-runs?${query(scope)}`
  );
  const holds = runs.filter(held);
  if (holds.some((run) => run.profileId !== scope.profileId || !run.finishedAt)) {
    throw new Error("\u05D1\u05E7\u05E9\u05EA \u05D4\u05E2\u05E6\u05D9\u05E8\u05D4 \u05E2\u05D3\u05D9\u05D9\u05DF \u05D1\u05D0\u05D9\u05DE\u05D5\u05EA. \u05D4\u05D4\u05D5\u05D3\u05E2\u05D4 \u05DC\u05D0 \u05E0\u05E9\u05DC\u05D7\u05D4; \u05D0\u05E4\u05E9\u05E8 \u05DC\u05E9\u05DC\u05D5\u05D7 \u05E9\u05D5\u05D1 \u05DC\u05D0\u05D7\u05E8 \u05D0\u05D9\u05E9\u05D5\u05E8 \u05D4\u05E2\u05E6\u05D9\u05E8\u05D4.");
  }
  for (const run of holds) await releaseRun(request, scope, run);
}
async function releaseRun(request, scope, run) {
  await request(`/api/codex/work-mode-runs/${encodeURIComponent(run.runId)}/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scope)
  });
}
async function stopQueueItemForUser(request, itemId, scope, onUpdate, options = {}) {
  let { item } = await request(`/api/codex/queue/items/${encodeURIComponent(itemId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" }
  });
  const runId = item.workModeRunId;
  const wait = options.wait || (() => new Promise((resolve) => setTimeout(resolve, 500)));
  for (let attempt = 0; ; attempt++) {
    if (item.id !== itemId) throw new Error("\u05D4\u05E9\u05E8\u05EA \u05D4\u05D7\u05D6\u05D9\u05E8 \u05D4\u05E8\u05E6\u05D4 \u05D0\u05D7\u05E8\u05EA; \u05DC\u05D0 \u05E9\u05D5\u05D7\u05E8\u05E8\u05D4 \u05EA\u05D5\u05DB\u05E0\u05D9\u05EA.");
    onUpdate(item);
    if (!runId || !["cancelling", "cancelled"].includes(item.status)) return;
    if (item.status === "cancelled") {
      const { runs } = await request(
        `/api/codex/work-mode-runs?${query(scope)}`
      );
      const run = runs.find((run2) => run2.runId === runId);
      if (run && run.profileId !== scope.profileId) throw new Error("\u05D4\u05EA\u05D5\u05DB\u05E0\u05D9\u05EA \u05E9\u05D9\u05D9\u05DB\u05EA \u05DC\u05E4\u05E8\u05D5\u05E4\u05D9\u05DC \u05D0\u05D7\u05E8.");
      if (run?.finishedAt) {
        if (run.outcome === "cancelled" && held(run)) await releaseRun(request, scope, run);
        return;
      }
    }
    if (attempt >= (options.attempts ?? 20)) return;
    await wait();
    ({ item } = await request(
      `/api/codex/queue/items/${encodeURIComponent(itemId)}?includeSession=false`
    ));
  }
}
export {
  releaseWorkModeHoldsForUser,
  stopQueueItemForUser
};
