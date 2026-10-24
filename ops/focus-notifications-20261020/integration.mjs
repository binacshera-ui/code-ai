import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInteractiveFixture } from '../deferred-deployment/api-smoke.mjs';
const candidate = process.argv[2];
assert.ok(candidate?.startsWith('/mnt/hdd/code-ai-builds/focus-notifications-20261020-'));
const delivered = [];
const sink = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  delivered.push({ body, priority: req.headers.priority }); res.end('{}');
});
sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  const fixture = await createInteractiveFixture(path.join(candidate, 'dist/server.js'),
  new URL('./fake-codex.mjs', import.meta.url).pathname, { timeoutMs: 160_000,
    notificationEndpoint: `http://127.0.0.1:${sink.address().port}/fixture-notifications` });
const checks = [];
try {
  await fixture.start();
  await fixture.request('/api/codex/session-focus-mode?profileId=interactive-fixture&sessionKey=draft:focus', 'GET', undefined, 403, false);
  await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
  const profileId = fixture.profileId;
  const route = key => `/api/codex/session-focus-mode?profileId=${profileId}&sessionKey=${encodeURIComponent(key)}`;
  const saved = await fixture.request('/api/codex/session-focus-mode', 'POST', { profileId, sessionKey: 'draft:focus', focusMode: { enabled: true, goal: 'תוצר מוכח אחד' } });
  assert.equal(saved.focusMode.enabled, true);
  assert.equal((await fixture.request(route('draft:other'))).focusMode.enabled, false);
  await fixture.request('/api/codex/session-focus-mode', 'POST', { profileId, sessionKey: 'draft:focus', focusMode: { enabled: 'true', goal: '' } }, 400);
  checks.push('authenticated focus API; strict validation; per-session opt-in isolation');
  async function run(queueKey, prompt, status) {
    const queued = await fixture.request('/api/codex/queue/items', 'POST', { profileId, cwd: fixture.cwd, queueKey, prompt }, 202);
    return fixture.poll(async () => {
      const { item } = await fixture.request(`/api/codex/queue/items/${queued.item.id}?includeSession=false`);
      if (item.status === status) return item;
      if (item.status === 'failed') throw Error(`Synthetic run failed: ${item.error}`);
      return false;
    });
  }
  const focused = await run('draft:focus', 'QUALIFY_REPEATED_FAILURE', 'completed');
  assert.equal(focused.progressGuardWarning?.intervention, 'applied');
  const audit = JSON.parse(await readFile(path.join(fixture.home, 'focus-audit.json'), 'utf8'));
  assert.equal(audit.starts, 1); assert.equal(audit.steers, 1); assert.equal(audit.focusedPrompts, 1);
  assert.equal((await fixture.request(route(focused.sessionId))).focusMode.goal, 'תוצר מוכח אחד');
  checks.push('queue -> focused prompt -> native repeated failure -> durable claim -> same-turn steer -> healthy completion; draft rebind');
  const failed = await run('draft:quota', 'QUALIFY_USAGE_LIMIT', 'failed');
  assert.equal(failed.failureKind, 'usage_limit'); assert.equal(failed.attempts, 1);
  const listed = await fixture.request(`/api/codex/queue/items?profile=${profileId}&queueKey=${failed.sessionId}`);
  assert.equal(listed.items.find(x => x.id === failed.id).failureKind, 'usage_limit');
  await fixture.poll(() => delivered.some(x => x.priority === 'high' && x.body.includes('מכסת השימוש')));
  assert.equal(delivered.filter(x => x.priority === 'high').length, 1);
  checks.push('authoritative failed native turn -> failed queue/list contract -> one high-priority alert to loopback sink, no real phone');
  const sessionRows = await fixture.request(`/api/codex/sessions?profile=${profileId}`);
  // Deliberately allow the stale catalog: the deep link must fetch detail even
  // when that just-created session has not reached the sidebar snapshot yet.
  assert.ok(sessionRows.sessions.length > 0);
  await fixture.request(`/api/codex/sessions/${failed.sessionId}?profile=${profileId}`);
  // Reproduce the actual missed path: a GUI-created native rollout with no
  // queue input. No browser/SSE is open while the outbox observes its failure.
  await fixture.poll(async () => {
    try { return JSON.parse(await readFile(path.join(fixture.storage, 'session-final-notifications.json'), 'utf8')).nativeFailureCursor; }
    catch { return false; }
  });
  const nativeId = randomUUID(), turnId = randomUUID();
  const nativeDirectory = path.join(fixture.home, 'sessions', '2026', '10', '20');
  await mkdir(nativeDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(path.join(nativeDirectory, `rollout-2026-10-20T08-00-00-${nativeId}.jsonl`), [
    { type: 'session_meta', timestamp, payload: { id: nativeId, timestamp, cwd: fixture.cwd, source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Synthetic GUI-created native failure' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: turnId, root_turn_id: turnId,
      last_agent_message: null, error: { message: 'Selected model is at capacity. Please try a different model.' } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await fixture.poll(() => delivered.some(x => x.priority === 'high' && x.body.includes('עמוס')));
  const queueState = JSON.parse(await readFile(path.join(fixture.storage, 'queue/state.json'), 'utf8'));
  assert.equal(queueState.items.some(item => item.sessionId === nativeId || item.queueKey === nativeId), false);
  assert.equal(delivered.filter(x => x.priority === 'high' && x.body.includes('עמוס')).length, 1);
  await fixture.poll(async () => {
    const nativeList = await fixture.request(`/api/codex/sessions?profile=${profileId}`);
    return nativeList.sessions.find(s => s.id === nativeId)?.nativeRunStatus === 'failed';
  });
  checks.push('exact capacity task_complete.error outside queue -> one existing-outbox alert with browser closed; no synthetic queue row; failed sidebar status');
  const enableBudget = async sessionKey => fixture.request('/api/codex/session-focus-mode', 'POST', {
    profileId, sessionKey, focusMode: { enabled: false, goal: '', rationalEnabled: true, planningMinutes: 1, taskMinutes: 2, decisionEnabled: false } });
  const runsFor = async sessionKey => (await fixture.request(`/api/codex/work-mode-runs?profileId=${profileId}&sessionKey=${encodeURIComponent(sessionKey)}`)).runs;
  await enableBudget('draft:budget-complete');
  const budgetCompleted = await run('draft:budget-complete', 'QUALIFY_RATIONAL_COMPLETE', 'completed');
  const completedRun = (await runsFor(budgetCompleted.sessionId))[0];
  assert.equal(completedRun.status, 'completed'); assert.equal(completedRun.tasks[0].status, 'completed');
  assert.ok(completedRun.tasks[0].evidence); assert.equal('tokenHash' in completedRun, false);
  await fixture.request('/api/codex/work-mode-control', 'POST', { runId: completedRun.runId, action: 'status' }, 403, false);
  checks.push('budget mode -> scoped native plan -> explicit evidenced checkmark -> completed queue and public plan, no exposed capability');
  await enableBudget('draft:budget-incomplete');
  const incomplete = await run('draft:budget-incomplete', 'QUALIFY_RATIONAL_INCOMPLETE', 'failed');
  const heldRun = (await runsFor(incomplete.sessionId))[0];
  assert.equal(heldRun.status, 'incomplete');
  const next = await fixture.request('/api/codex/queue/items', 'POST', {
    profileId, cwd: fixture.cwd, queueKey: incomplete.sessionId, sessionId: incomplete.sessionId,
    prompt: 'QUALIFY_RATIONAL_COMPLETE' }, 202);
  await run('draft:unrelated-budget-check', 'Ordinary synthetic task unaffected by another conversation hold', 'completed');
  assert.equal((await fixture.request(`/api/codex/queue/items/${next.item.id}?includeSession=false`)).item.status, 'queued');
  await fixture.request(`/api/codex/work-mode-runs/${heldRun.runId}/release`, 'POST', { profileId, sessionKey: 'another-session' }, 409);
  await fixture.request(`/api/codex/work-mode-runs/${heldRun.runId}/release`, 'POST', { profileId, sessionKey: incomplete.sessionId });
  await fixture.poll(async () => {
    const { item } = await fixture.request(`/api/codex/queue/items/${next.item.id}?includeSession=false`);
    if (item.status === 'failed') throw Error(`Released follow-up failed: ${item.error}`);
    return item.status === 'completed';
  });
  checks.push('unfinished checklist -> incomplete failure and session-only durable hold; unrelated work continues; owner release resumes queued follow-up');
  await enableBudget('draft:budget-expire');
  const expiring = await fixture.request('/api/codex/queue/items', 'POST', {
    profileId, cwd: fixture.cwd, queueKey: 'draft:budget-expire', prompt: 'QUALIFY_RATIONAL_EXPIRE' }, 202);
  const expiredItem = await fixture.poll(async () => {
    const { item } = await fixture.request(`/api/codex/queue/items/${expiring.item.id}?includeSession=false`);
    if (item.status === 'failed') throw Error(`Expiring native run failed: ${item.error}`);
    return item.status === 'cancelled' ? item : false;
  });
  const expired = (await runsFor(expiredItem.sessionId))[0];
  assert.equal(expired.status, 'expired'); assert.equal(expired.tasks[0].status, 'pending');
  await fixture.poll(() => delivered.some(value => value.body.includes('הזמן שהוקצב')));
  assert.equal(delivered.filter(value => value.body.includes('הזמן שהוקצב')).length, 1);
  checks.push('real one-minute deadline -> exact owning native turn interrupted -> cancelled queue + persisted expired plan + one outbox reminder');
  const browser = spawn('/root/projects/code-ai/.venv/bin/python', [new URL('./browser-check.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  browser.stdin.end(JSON.stringify({ origin: fixture.origin, cookie: fixture.cookie, profileId, failedSessionId: nativeId, nativeOnly: true, focusedSessionId: focused.sessionId,
    rationalSessionId: expiredItem.sessionId, artifactRoot: candidate }));
  let output = '', diagnostic = '';
  browser.stdout.on('data', data => output += data); browser.stderr.on('data', data => diagnostic += data);
  const [code] = await once(browser, 'exit');
  if (code !== 0) throw Error(`Isolated browser qualification failed: ${diagnostic.slice(-3000)}`);
  const browserResult = JSON.parse(output.trim());
  const result = { ok: true, checks, browser: browserResult, realInference: false, phoneReceiptTested: false, deployed: false, candidate };
  await writeFile(path.join(candidate, 'feature-acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await fixture.stop(); await new Promise(resolve => sink.close(resolve));
}
