import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInteractiveFixture } from '../deferred-deployment/api-smoke.mjs';
const candidate = process.argv[2];
assert.ok(candidate?.startsWith('/mnt/hdd/code-ai-builds/focus-notifications-20261020-'));
const cases = new Map();
const upstream = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const data of req) raw += data;
    const body = raw ? JSON.parse(raw) : {};
    const parts = req.url.split('/').filter(Boolean);
    res.setHeader('content-type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (parts.length === 2 && req.method === 'POST') {
      const id = body.incident_case_id;
      if (!cases.has(id)) cases.set(id, { incident_case: { ...body, status: 'waiting_investigator', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, events: [], reports: [], decisions: [], executions: [] });
      return send({ incident_case: cases.get(id).incident_case });
    }
    if (parts.length === 2) return send({ incident_cases: [...cases.values()].map(c => c.incident_case) });
    const entry = cases.get(parts[2]);
    if (!entry) { res.statusCode = 404; return send({ error: 'synthetic_case_not_found' }); }
    if (parts[3] === 'package') return send({ package: entry });
    if (parts[3] === 'reports') {
      let report = entry.reports.find(x => x.idempotency_key === body.idempotency_key);
      if (!report) { report = { ...body, incident_report_id: `report_${randomUUID()}` }; entry.reports.push(report); }
      entry.incident_case.status = 'waiting_operator'; return send({ incident_report: report });
    }
    if (parts[3] === 'decisions') {
      let decision = entry.decisions.find(x => x.idempotency_key === body.idempotency_key);
      if (!decision) { decision = { ...body, incident_decision_id: `decision_${randomUUID()}` }; entry.decisions.push(decision); }
      entry.incident_case.status = 'approved_for_execution'; return send({ incident_decision: decision });
    }
    if (parts[3] === 'messages') {
      if (!entry.events.some(x => x.idempotency_key === body.idempotency_key)) entry.events.push({ ...body, incident_case_event_id: `event_${randomUUID()}` });
      Object.assign(entry.incident_case, body.case_patch || {}); return send({ ok: true });
    }
    res.statusCode = 404; send({ error: 'synthetic_route_not_found' });
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const fixture = await createInteractiveFixture(path.join(candidate, 'dist/server.js'),
  new URL('./fake-codex.mjs', import.meta.url).pathname, { incidentEndpoint: `http://127.0.0.1:${upstream.address().port}` });
try {
  await fixture.start();
  await fixture.request('/api/codex/device-unlock', 'POST', { password: fixture.devicePassword });
  const first = await fixture.request('/api/codex/queue/items', 'POST', { profileId: fixture.profileId,
    cwd: fixture.cwd, queueKey: 'draft:incident-original', prompt: 'Synthetic original support conversation' }, 202);
  const original = await fixture.poll(async () => {
    const { item } = await fixture.request(`/api/codex/queue/items/${first.item.id}?includeSession=false`);
    return item.status === 'completed' ? item : false;
  });
  const parked = await fixture.request('/api/codex/incident-cases/park', 'POST', {
    requestId: 'synthetic-park-one', title: 'תקלה בתמיכה', summary: 'מקרה סינתטי, מזוהה וממתין להכרעת בעלים',
    operatorQuestion: 'מה דרך התיקון המאושרת?', failureTicketId: 'synthetic_ticket_no_real_mail',
    investigatorProfileId: fixture.profileId, investigatorSessionId: original.sessionId,
  }, 201);
  const caseId = parked.caseRecord.caseId;
  assert.equal(parked.caseRecord.status, 'waiting_operator');
  const verdict = { requestId: 'synthetic-verdict-one', summary: 'אבחן ובדוק בתיק הסינתטי בלבד; אל תבצע פנייה חיצונית.' };
  const accepted = await fixture.request(`/api/codex/incident-cases/${caseId}/verdict`, 'POST', verdict, 202);
  assert.notEqual(accepted.wakeResult.status, 'dispatch_pending');
  assert.equal(accepted.wakeResult.owner, 'code_ai');
  assert.equal(accepted.wakeResult.session_id, original.sessionId);
  const retry = await fixture.request(`/api/codex/incident-cases/${caseId}/verdict`, 'POST', verdict, 202);
  assert.equal(retry.wakeResult.queue_item_id, accepted.wakeResult.queue_item_id);
  await fixture.request(`/api/codex/incident-cases/${caseId}/verdict`, 'POST', { ...verdict, summary: 'Changed text with same request identity' }, 400);
  const completed = await fixture.poll(async () => {
    const { item } = await fixture.request(`/api/codex/queue/items/${accepted.wakeResult.queue_item_id}?includeSession=false`);
    if (item.status === 'failed') throw Error(`Decision continuation failed: ${item.error}`);
    return item.status === 'completed' ? item : false;
  });
  assert.equal(completed.sessionId, original.sessionId);
  assert.equal(cases.get(caseId).decisions.length, 1);
  assert.notEqual(cases.get(caseId).incident_case.status, 'completed');
  const browser = spawn('/root/projects/code-ai/.venv/bin/python', [new URL('./decision-browser.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  browser.stdin.end(JSON.stringify({ origin: fixture.origin, cookie: fixture.cookie, caseId }));
  let output = '', diagnostic = '';
  browser.stdout.on('data', bytes => output += bytes); browser.stderr.on('data', bytes => diagnostic += bytes);
  const [code] = await once(browser, 'exit');
  if (code !== 0) throw Error(diagnostic.slice(-3000));
  const result = { ok: true, canonicalService: 'loopback synthetic fixture',
    sameCaseAndSession: true, sameVerdictRetrySingleAdmission: true, noFabricatedTicketClosure: true,
    browser: JSON.parse(output), realModel: false, realTicketWrites: false, deployed: false };
  await writeFile(path.join(candidate, 'decision-acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await fixture.stop(); await new Promise(resolve => upstream.close(resolve)); }
