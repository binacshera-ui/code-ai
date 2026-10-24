import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, Script } from 'node:vm';
import test from 'node:test';
import { buildIncidentDecisionCenterHtml, createIncidentDecisionCenterService, requestIncidentJson } from './incidentDecisionCenter.js';

const fixtureRoots: string[] = [];
test.after(async () => {
  await Promise.all(fixtureRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

function canonicalFixture() {
  const contextRoot = mkdtempSync(path.join(os.tmpdir(), 'incident-owner-test-'));
  fixtureRoots.push(contextRoot);
  const cases = new Map<string, any>();
  const writes: Array<{ pathname: string; body: any }> = [];
  const signals: Array<{ caseId: string; type: string; key: string }> = [];
  const queue = new Map<string, any>();
  let afterDecision: ((caseId: string, decisionId: string) => Promise<void>) | null = null;
  let loseDecisionResponse = false;
  let loseQueueResponse = false;
  const requestJson = async (pathname: string, options: RequestInit = {}) => {
    if (options.method === 'GET') {
      if (pathname.startsWith('/v1/incident-cases?') || pathname === '/v1/incident-cases') {
        return { incident_cases: [...cases.values()].map((pkg) => pkg.incident_case) };
      }
      const caseId = pathname.split('/')[3];
      return { package: cases.get(caseId) || null };
    }
    const body = JSON.parse(String(options.body || '{}'));
    writes.push({ pathname, body });
    if (pathname === '/v1/incident-cases') {
      const caseId = body.incident_case_id;
      if (!cases.has(caseId)) cases.set(caseId, {
        incident_case: { ...body, status: 'waiting_investigator', created_at: '2026-10-20T08:00:00Z' },
        reports: [], decisions: [], executions: [], events: [],
      });
      return { incident_case: cases.get(caseId).incident_case };
    }
    const caseId = pathname.split('/')[3];
    const pkg = cases.get(caseId);
    if (!pkg) throw new Error('case_missing');
    if (pathname.endsWith('/reports')) {
      if (!pkg.reports.find((entry: any) => entry.idempotency_key === body.idempotency_key)) {
        pkg.reports.push({ ...body, incident_report_id: `report_${pkg.reports.length + 1}` });
        pkg.incident_case.status = 'waiting_operator';
      }
      signals.push({ caseId, type: 'investigator_report_submitted', key: body.idempotency_key });
      return { incident_case: pkg.incident_case };
    }
    if (pathname.endsWith('/decisions')) {
      let decision = pkg.decisions.find((entry: any) => entry.idempotency_key === body.idempotency_key);
      if (!decision) {
        decision = { ...body, incident_decision_id: `decision_${pkg.decisions.length + 1}` };
        pkg.decisions.push(decision);
        pkg.incident_case.status = body.status;
        pkg.incident_case.last_decision_id = decision.incident_decision_id;
      }
      signals.push({ caseId, type: body.signal_type || 'operator_decision_recorded', key: decision.incident_decision_id });
      if (afterDecision) await afterDecision(caseId, decision.incident_decision_id).catch(() => {});
      if (loseDecisionResponse) {
        loseDecisionResponse = false;
        throw new Error('upstream_response_lost_after_commit');
      }
      return { incident_decision: decision, incident_case: pkg.incident_case };
    }
    if (pathname.endsWith('/messages')) {
      pkg.events.push({ ...body, incident_case_event_id: `event_${pkg.events.length + 1}` });
      return { incident_case: pkg.incident_case };
    }
    if (pathname.endsWith('/executions')) {
      pkg.executions.push(body);
      pkg.incident_case.status = body.case_status || body.status;
      return { incident_case: pkg.incident_case };
    }
    if (pathname.endsWith('/complete')) {
      pkg.incident_case.status = 'completed';
      return { incident_case: pkg.incident_case };
    }
    throw new Error(`unexpected_path:${pathname}`);
  };
  const enqueue = async (input: any) => {
    let item = queue.get(input.clientRequestId);
    if (!item) {
      item = { ...input, id: `queue_${queue.size + 1}`, status: 'queued' };
      queue.set(input.clientRequestId, item);
    }
    if (loseQueueResponse) {
      loseQueueResponse = false;
      throw new Error('queue_response_lost_after_commit');
    }
    return item;
  };
  return {
    cases, writes, signals, queue, requestJson, enqueue, contextRoot,
    onDecision: (handler: NonNullable<typeof afterDecision>) => { afterDecision = handler; },
    loseDecisionResponse: () => { loseDecisionResponse = true; },
    loseQueueResponse: () => { loseQueueResponse = true; },
  };
}

const parkedInput = {
  requestId: 'park_native_turn_1', title: 'תקלה בתמיכה', summary: 'התקלה זוהתה, אך נדרשת הכרעה על דרך התיקון.',
  operatorQuestion: 'האם לפשט את הנתיב הקיים?', failureTicketId: 'failure_123',
  investigatorProfileId: 'developer', investigatorSessionId: '00000000-0000-4000-8000-000000000103',
};

test('decision mode parks one canonical case with its original owner and ticket, without pausing or queueing work', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const first = await service.parkCase(parkedInput);
  const second = await service.parkCase(parkedInput);
  assert.equal(first.caseRecord?.caseId, second.caseRecord?.caseId);
  assert.equal(fixture.cases.size, 1);
  assert.equal(first.caseRecord?.status, 'waiting_operator');
  assert.equal(first.caseRecord?.investigatorSessionId, parkedInput.investigatorSessionId);
  assert.equal(first.caseRecord?.failureTicketId, parkedInput.failureTicketId);
  const pkg = fixture.cases.get(first.caseRecord!.caseId);
  assert.equal(pkg.reports.length, 1);
  assert.equal(pkg.reports[0].operator_question, parkedInput.operatorQuestion);
  assert.equal(fixture.queue.size, 0);
  assert.equal(first.wakeResult, null);
  assert.ok(fixture.signals.every((signal) => signal.type === 'investigator_report_submitted'));
});

test('a sidecar stamps its own configured case origin and cannot fabricate another wake target', async () => {
  const fixture = canonicalFixture();
  const previous = process.env.CODEX_REMOTE_INCIDENT_SERVER_ID;
  process.env.CODEX_REMOTE_INCIDENT_SERVER_ID = 'remote-a';
  try {
    const service = createIncidentDecisionCenterService(fixture);
    const parked = await service.parkCase({ ...parkedInput, metadata: { codeAiServerId: 'remote-b', preserved: true } });
    assert.equal(parked.caseRecord?.metadata.codeAiServerId, 'remote-a');
    assert.equal(parked.caseRecord?.metadata.preserved, true);
    assert.equal(fixture.writes.find((write) => write.pathname === '/v1/incident-cases')?.body.metadata.codeAiServerId, 'remote-a');
  } finally {
    if (previous === undefined) delete process.env.CODEX_REMOTE_INCIDENT_SERVER_ID;
    else process.env.CODEX_REMOTE_INCIDENT_SERVER_ID = previous;
  }
});

test('a remote case verdict on main delegates once before any local context or queue admission', async () => {
  const fixture = canonicalFixture();
  const sidecar = createIncidentDecisionCenterService({ ...fixture, serverId: 'remote-a' });
  const parked = await sidecar.parkCase(parkedInput);
  const delegated: any[] = [];
  const main = createIncidentDecisionCenterService({
    ...fixture, serverId: 'local',
    delegateWake: async (serverId, payload) => {
      delegated.push({ serverId, ...payload });
      return { queue_item_id: 'remote_queue', queue_status: 'queued', session_id: parkedInput.investigatorSessionId, profile_id: parkedInput.investigatorProfileId, context_file_path: '/remote/context.json' };
    },
  });
  const result = await main.recordOperatorVerdict(parked.caseRecord!.caseId, { requestId: 'remote_verdict_1', summary: 'תקנו באותו סשן מרוחק.' });
  assert.equal(result.wakeResult.status, 'queued');
  assert.deepEqual(delegated, [{
    serverId: 'remote-a', caseId: parked.caseRecord!.caseId, taskType: 'execute_decision',
    decisionId: 'decision_1', idempotencyKey: `execute_decision:${parked.caseRecord!.caseId}:decision_1`,
  }]);
  assert.equal(fixture.queue.size, 0);
  assert.deepEqual(await fs.readdir(fixture.contextRoot), []);
  assert.equal(fixture.writes.filter((write) => write.body.kind === 'wake_requested' || write.body.kind === 'wake_failed').length, 0);
});

test('the owning sidecar wakes the original same-case session locally and preserves decision admission across forwarded retries', async () => {
  const fixture = canonicalFixture();
  let delegatedAgain = 0;
  const owner = createIncidentDecisionCenterService({
    ...fixture, serverId: 'remote-b', delegateWake: async () => { delegatedAgain += 1; throw new Error('must_not_delegate_from_owner'); },
  });
  const parked = await owner.parkCase(parkedInput);
  await owner.recordDecision(parked.caseRecord!.caseId, { decisionKind: 'approved_for_execution', summary: 'owner decision' });
  const task = { caseId: parked.caseRecord!.caseId, taskType: 'execute_decision', decisionId: 'decision_1', idempotencyKey: 'forwarded:event_1' };
  const first = await owner.wakeSessionTask(task);
  const second = await owner.wakeSessionTask({ ...task, idempotencyKey: 'legacy:event_2' });
  assert.equal(delegatedAgain, 0);
  assert.equal(first.queue_item_id, second.queue_item_id);
  assert.equal(fixture.queue.size, 1);
  const [item] = fixture.queue.values();
  assert.equal(item.sessionId, parkedInput.investigatorSessionId);
  assert.equal(item.queueKey, parkedInput.investigatorSessionId);
  assert.equal(item.profileId, parkedInput.investigatorProfileId);
  assert.match(item.prompt, new RegExp(parked.caseRecord!.caseId));
  assert.equal((await fs.readdir(path.join(fixture.contextRoot, task.caseId))).length, 1);
});

test('local and legacy cases retain local admission without remote delegation', async () => {
  for (const legacy of [false, true]) {
    const fixture = canonicalFixture();
    const service = createIncidentDecisionCenterService({
      ...fixture, serverId: 'local', delegateWake: async () => { throw new Error('unexpected_remote_delegation'); },
    });
    const parked = await service.parkCase(parkedInput);
    if (legacy) delete fixture.cases.get(parked.caseRecord!.caseId).incident_case.metadata.codeAiServerId;
    await service.wakeSessionTask({ caseId: parked.caseRecord!.caseId, taskType: 'operator_response', idempotencyKey: 'local:event_1' });
    assert.equal(fixture.queue.size, 1);
  }
});

test('unknown or malformed remote origins surface failure and never fall back to local admission', async () => {
  const fixture = canonicalFixture();
  const owner = createIncidentDecisionCenterService({ ...fixture, serverId: 'missing-host' });
  const parked = await owner.parkCase(parkedInput);
  let delegated = 0;
  const main = createIncidentDecisionCenterService({
    ...fixture, serverId: 'local', delegateWake: async () => { delegated += 1; throw new Error('incident_remote_wake_endpoint_unavailable'); },
  });
  const task = { caseId: parked.caseRecord!.caseId, taskType: 'operator_response', idempotencyKey: 'unknown:event_1' };
  await assert.rejects(main.wakeSessionTask(task), /incident_remote_wake_endpoint_unavailable/);
  fixture.cases.get(task.caseId).incident_case.metadata.codeAiServerId = '../private';
  await assert.rejects(main.wakeSessionTask(task), /incident_origin_server_id_invalid/);
  assert.equal(delegated, 1);
  assert.equal(fixture.queue.size, 0);
  assert.deepEqual(await fs.readdir(fixture.contextRoot), []);
  assert.equal(fixture.writes.filter((write) => write.body.kind === 'wake_failed').length, 0);
});

test('canonical transport exposes non-success HTTP status for scoped gateway ownership preflight', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'incident_case_not_found' }, { status: 404 }));
  await assert.rejects(requestIncidentJson('/v1/incident-cases/missing/package', {}, 'https://incident.example'), (error: any) => error.statusCode === 404 && error.message === 'incident_case_not_found');
});

test('existing case identity is reused and another investigator cannot silently steal it', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const first = await service.parkCase(parkedInput);
  const before = fixture.writes.length;
  await assert.rejects(service.parkCase({ ...parkedInput, requestId: 'park_2', investigatorSessionId: 'another-session' }), /owner_mismatch/);
  assert.equal(fixture.writes.length, before);
  await service.parkCase({ ...parkedInput, requestId: 'park_2', caseId: first.caseRecord!.caseId });
  assert.equal(fixture.writes.filter((write) => write.pathname === '/v1/incident-cases').length, 1);
  assert.equal(fixture.cases.get(first.caseRecord!.caseId).reports.length, 2);
});

test('saved owner verdict survives lost responses and process recreation; direct and delayed workflow wakes share one admission', async () => {
  const fixture = canonicalFixture();
  const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-verdict-'));
  try {
    let service = createIncidentDecisionCenterService({ ...fixture, contextRoot });
    const parked = await service.parkCase(parkedInput);
    const caseId = parked.caseRecord!.caseId;
    fixture.onDecision(async (id, decisionId) => {
      await service.wakeSessionTask({ caseId: id, taskType: 'execute_decision', idempotencyKey: `execute_decision:${id}:${decisionId}`, decisionId });
    });
    fixture.loseDecisionResponse();
    const verdict = { requestId: 'owner_verdict_morning_1', summary: 'אחדו את הנתיבים ותקנו במסגרת אותו טיקט.' };
    await assert.rejects(service.recordOperatorVerdict(caseId, verdict), /response_lost/);
    // No in-memory verdict registry is needed for restart/retry correctness.
    service = createIncidentDecisionCenterService({ ...fixture, contextRoot });
    const saved = await service.recordOperatorVerdict(caseId, verdict);
    assert.equal(fixture.cases.get(caseId).decisions.length, 1);
    assert.equal(fixture.queue.size, 1);
    assert.equal(saved.caseRecord?.status, 'approved_for_execution');
    assert.equal(saved.wakeResult.owner, 'code_ai');
    assert.equal(saved.wakeResult.status, 'queued');
    const [item] = fixture.queue.values();
    assert.equal(item.sessionId, parkedInput.investigatorSessionId);
    assert.equal(item.profileId, parkedInput.investigatorProfileId);
    assert.equal(item.queueKey, parkedInput.investigatorSessionId);
    assert.match(item.prompt, new RegExp(caseId));
    assert.match(item.prompt, /failure_123/);
    assert.match(item.prompt, /דוח ביצוע אינו סגירת טיקט/);
    const contextFiles = await fs.readdir(path.join(contextRoot, caseId));
    assert.equal(contextFiles.length, 1);
    const contextPath = path.join(contextRoot, caseId, contextFiles[0]);
    assert.equal((await fs.stat(contextPath)).mode & 0o777, 0o600);
    const savedContext = JSON.parse(await fs.readFile(contextPath, 'utf8'));
    assert.equal(savedContext.decisions[0].summary, verdict.summary);
    assert.equal(savedContext.wake_request.incident_decision_id, 'decision_1');
    assert.equal(fixture.writes.filter((write) => write.pathname.endsWith('/complete')).length, 0);
    await service.recordOperatorVerdict(caseId, { ...verdict, requestId: 'owner_verdict_morning_2', summary: 'הכרעה נוספת וממוקדת.' });
    assert.equal(fixture.queue.size, 2, 'a genuinely new verdict is a new task, not a retry');
    const delayed = await service.wakeSessionTask({ caseId, taskType: 'execute_decision', idempotencyKey: 'delayed:first-decision', decisionId: 'decision_1' });
    const delayedItem = [...fixture.queue.values()].find((entry) => entry.id === delayed.queue_item_id);
    assert.match(delayedItem.prompt, /הרלוונטית למשימה זו: decision_1/);
  } finally {
    await fs.rm(contextRoot, { recursive: true, force: true });
  }
});

test('new CodeAI verdict dispatches without global workflow and a later legacy callback cannot enqueue a second turn', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const parked = await service.parkCase(parkedInput);
  const result = await service.recordOperatorVerdict(parked.caseRecord!.caseId, { requestId: 'verdict_1', summary: 'תקנו את הבעיה שנמצאה.' });
  assert.equal(fixture.queue.size, 1);
  assert.equal(result.wakeResult.status, 'queued');
  assert.equal(result.wakeResult.owner, 'code_ai');
  assert.equal(fixture.signals.at(-1)?.type, 'incident_event', 'new CodeAI path does not request a competing legacy wake');
  assert.notEqual(result.caseRecord?.status, 'completed');
  await service.wakeSessionTask({
    caseId: parked.caseRecord!.caseId, taskType: 'execute_decision', decisionId: 'decision_1', idempotencyKey: 'different_legacy_event_id',
  });
  assert.equal(fixture.queue.size, 1, 'decision identity, not sender event id, owns admission');
  await assert.rejects(service.recordOperatorVerdict(parked.caseRecord!.caseId, {
    requestId: 'verdict_1', summary: 'תוכן חדש עם אותו מזהה בקשה אינו retry.',
  }), /payload_mismatch/);
});

test('a saved verdict reports dispatch pending after unknown queue acceptance; owner retry safely reconciles the same task', async () => {
  const fixture = canonicalFixture();
  let service = createIncidentDecisionCenterService(fixture);
  const parked = await service.parkCase(parkedInput);
  const caseId = parked.caseRecord!.caseId;
  const verdict = { requestId: 'verdict_admission_unknown', summary: 'אחדו את הנתיב וודאו פתרון.' };
  fixture.loseQueueResponse();
  const pending = await service.recordOperatorVerdict(caseId, verdict);
  assert.equal(pending.wakeResult.status, 'dispatch_pending');
  assert.equal(pending.wakeResult.incident_decision_id, 'decision_1');
  assert.equal(fixture.cases.get(caseId).decisions.length, 1);
  assert.equal(fixture.queue.size, 1);
  service = createIncidentDecisionCenterService(fixture);
  const retried = await service.recordOperatorVerdict(caseId, verdict);
  assert.equal(retried.wakeResult.status, 'queued');
  assert.equal(fixture.cases.get(caseId).decisions.length, 1);
  assert.equal(fixture.queue.size, 1);
  assert.equal(fixture.signals.filter((signal) => signal.type === 'incident_event').length, 2);
});

test('legacy decision callers retain their external workflow contract rather than silently gaining a second dispatcher', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const parked = await service.parkCase(parkedInput);
  await service.recordDecision(parked.caseRecord!.caseId, { decisionKind: 'approved_for_execution', summary: 'legacy approval' });
  assert.equal(fixture.signals.at(-1)?.type, 'operator_decision_recorded');
  assert.equal(fixture.queue.size, 0);
});

test('a lost queue acceptance response is retried with the same queue clientRequestId and immutable context', async () => {
  const fixture = canonicalFixture();
  const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-wake-'));
  try {
    const service = createIncidentDecisionCenterService({ ...fixture, contextRoot });
    const parked = await service.parkCase(parkedInput);
    const task = { caseId: parked.caseRecord!.caseId, taskType: 'operator_decision', idempotencyKey: 'canonical:event_7' };
    fixture.loseQueueResponse();
    await assert.rejects(service.wakeSessionTask(task), /queue_response_lost/);
    const resumed = await service.wakeSessionTask(task);
    assert.equal(fixture.queue.size, 1);
    assert.equal(resumed.queue_item_id, 'queue_1');
    assert.equal((await fs.readdir(path.join(contextRoot, task.caseId))).length, 1);
    assert.equal(fixture.writes.filter((write) => write.body.kind === 'wake_requested').length, 1);
  } finally {
    await fs.rm(contextRoot, { recursive: true, force: true });
  }
});

test('invalid paths, ownerless verdicts, oversized input, and completed cases are rejected before unsafe writes', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  await assert.rejects(service.getCase('../private'), /case_id_invalid/);
  await assert.rejects(service.wakeSessionTask({ caseId: 'safe', taskType: '../outside' }), /task_type_invalid/);
  await assert.rejects(service.parkCase({ ...parkedInput, title: 'x'.repeat(241) }), /title_invalid/);
  await assert.rejects(service.recordOperatorVerdict('missing', { requestId: 'valid', summary: ' ' }), /verdict_invalid/);
  await assert.rejects(service.parkCase({ ...parkedInput, requestId: '../unsafe' }), /request_id_invalid/);
  assert.equal(fixture.writes.length, 0);
  const parked = await service.parkCase(parkedInput);
  const caseId = parked.caseRecord!.caseId;
  const pkg = fixture.cases.get(caseId);
  pkg.incident_case.investigator_session_id = null;
  await assert.rejects(service.recordOperatorVerdict(caseId, { requestId: 'valid', summary: 'הכרעה' }), /target_missing/);
  pkg.incident_case.investigator_session_id = parkedInput.investigatorSessionId;
  pkg.incident_case.status = 'completed';
  const before = fixture.writes.length;
  await assert.rejects(service.recordOperatorVerdict(caseId, { requestId: 'valid', summary: 'הכרעה' }), /already_completed/);
  await assert.rejects(service.parkCase({ ...parkedInput, caseId }), /already_completed/);
  assert.equal(fixture.writes.length, before);
});

test('decision-center HTML exposes free-text verdict and durable retry id without claiming completion', () => {
  const html = buildIncidentDecisionCenterHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new Script(script);
  assert.match(html, /שמור הכרעה והמשך טיפול/);
  assert.match(html, /requestSignature === signature/);
  assert.match(html, /requestId,/);
  assert.match(html, /\/verdict/);
  assert.match(html, /ההשלמה עדיין ממתינה לביצוע ולאימות/);
  assert.match(html, /await loadCases\(false\)/, 'successful submission does not resurrect cleared textarea drafts');
});

function decisionBrowserFixture(search = '', storedServer: string | null = null, storageBlocked = false) {
  const script = buildIncidentDecisionCenterHtml().match(/<script>([\s\S]*?)<\/script>/)![1];
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '', innerHTML: '', querySelectorAll: () => [] });
    return elements.get(id);
  };
  element('operator-note').value = 'המשיכו בטיפול מרחוק.';
  element('operator-action').value = 'operator_verdict';
  let postResult = { wakeResult: { status: 'queued' } };
  const context = createContext({
    window: {
      location: { search },
      localStorage: {
        getItem: (key: string) => {
          if (storageBlocked) throw new Error('storage_unavailable');
          return key === 'code-ai.serverId' ? storedServer : null;
        },
        setItem: () => {},
      },
    },
    document: { getElementById: element, querySelectorAll: () => [] },
    URLSearchParams, crypto: { randomUUID: () => 'browser-verdict-request-1' }, setInterval: () => {},
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      const body = options?.method === 'POST' ? postResult : url.includes('./incident-cases/') ? { caseRecord: null } : { cases: [] };
      return { ok: true, json: async () => body };
    },
  });
  new Script(script + '\nglobalThis.testApi = { state, loadCases, loadCase, submitAction, caseServerId };').runInContext(context);
  return { api: (context as any).testApi, requests, setPostResult: (value: typeof postResult) => { postResult = value; } };
}

test('HTML listing chooses explicit URL server, then app storage, then local without losing explicit main mode', async () => {
  for (const [query, stored, expected, blocked] of [
    ['?server=local', 'remote-a', 'local', false],
    ['?server=remote-b', 'remote-a', 'remote-b', false],
    ['', 'remote-a', 'remote-a', false],
    ['', null, 'local', false],
    ['', null, 'local', true],
  ] as const) {
    const browser = decisionBrowserFixture(query, stored, blocked);
    await browser.api.loadCases(false);
    assert.equal(browser.api.state.serverId, expected);
    assert.equal((browser.requests[0].options.headers as any)['x-code-ai-server-id'], expected);
  }
});

test('HTML main/global listing routes remote detail and actions to case origin while list refresh stays on main', async () => {
  const browser = decisionBrowserFixture('?server=local', 'remote-b');
  await browser.api.loadCases(false);
  browser.requests.length = 0;
  const remote = { caseId: 'icase_from_remote', metadata: { codeAiServerId: 'remote-a' } };
  browser.api.state.cases = [remote];
  await browser.api.loadCase(remote.caseId);
  await browser.api.submitAction(remote, 'operator_verdict');
  assert.equal((browser.requests.find((entry) => entry.url.endsWith('/icase_from_remote'))!.options.headers as any)['x-code-ai-server-id'], 'remote-a');
  assert.equal((browser.requests.find((entry) => entry.url.endsWith('/verdict'))!.options.headers as any)['x-code-ai-server-id'], 'remote-a');
  assert.equal((browser.requests.find((entry) => entry.url === './incident-cases')!.options.headers as any)['x-code-ai-server-id'], 'local');
  assert.equal(browser.api.state.serverId, 'local');
});

test('HTML remote context preserves legacy origin fallback and retry request identity for dispatch-pending verdicts', async () => {
  const browser = decisionBrowserFixture('', 'remote-b');
  await browser.api.loadCases(false);
  const legacy = { caseId: 'legacy_remote_case', metadata: {} };
  assert.equal(browser.api.caseServerId(legacy), 'remote-b');
  browser.setPostResult({ wakeResult: { status: 'dispatch_pending' } });
  await browser.api.submitAction(legacy, 'operator_verdict');
  await browser.api.submitAction(legacy, 'operator_verdict');
  const posts = browser.requests.filter((entry) => entry.options.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(String(posts[0].options.body)).requestId, JSON.parse(String(posts[1].options.body)).requestId);
  assert.ok(posts.every((entry) => (entry.options.headers as any)['x-code-ai-server-id'] === 'remote-b'));
  assert.equal(browser.api.state.drafts[legacy.caseId].note, 'המשיכו בטיפול מרחוק.');
});

test('investigator execution completed stores verification evidence and waits for owner confirmation instead of closing the case', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const parked = await service.parkCase(parkedInput);
  const result = await service.appendMessage(parked.caseRecord!.caseId, {
    author: 'investigator', kind: 'investigator_execution', status: 'completed', text: 'התיקון אומת.',
    messagePayload: { test_results: ['regression passed'], verification_results: ['live readback matched'] },
  });
  assert.equal(result.caseRecord?.status, 'waiting_completion_confirmation');
  const execution = fixture.writes.find((write) => write.pathname.endsWith('/executions'));
  assert.equal(execution?.body.status, 'completed');
  assert.equal(execution?.body.case_status, 'waiting_completion_confirmation');
  assert.deepEqual(execution?.body.execution_report.verification_results, ['live readback matched']);
  assert.equal(fixture.writes.filter((write) => write.pathname.endsWith('/complete')).length, 0);
});

test('only the operator closes the case and closing it never fabricates linked failure-ticket closure', async () => {
  const fixture = canonicalFixture();
  const service = createIncidentDecisionCenterService(fixture);
  const parked = await service.parkCase(parkedInput);
  await assert.rejects(service.completeCase(parked.caseRecord!.caseId, { author: 'investigator', summary: 'done' }), /requires_operator/);
  const result = await service.completeCase(parked.caseRecord!.caseId, { author: 'operator', summary: 'אושר שהטיפול הושלם.' });
  assert.equal(result.caseRecord?.status, 'completed');
  assert.deepEqual(result.linkedTicketCompletion, { failureTicketId: 'failure_123', status: 'not_verified' });
  assert.match(buildIncidentDecisionCenterHtml(), /סגירת טיקט הכשל המקושר לא אומתה כאן/);
});


test('canonical transport requires explicit service configuration before any network call', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected_network_call'); });
  await assert.rejects(requestIncidentJson('/v1/incident-cases', {}, ''), /CODEX_INCIDENT_FAILURE_URL is required/);
  assert.equal(fetch.mock.callCount(), 0);
});
