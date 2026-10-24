#!/usr/bin/env node
// Synthetic native protocol; refuses unmarked homes, never performs inference.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Synthetic app-server'); process.exit(0); }
const home = process.env.CODEX_HOME;
if (!home || !fs.existsSync(path.join(home, '.code-ai-synthetic-fixture'))) process.exit(64);
if (process.argv.includes('models')) { console.log(JSON.stringify({ models: [{ slug: 'synthetic-codex', display_name: 'Synthetic', visibility: 'list' }] })); process.exit(0); }
let threadId, turnId, rollout, scenario;
let finishTimer;
const threads = new Map();
const auditPath = path.join(home, 'focus-audit.json');
let audit = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath)) : { starts: 0, steers: 0, focusedPrompts: 0 };
const save = () => fs.writeFileSync(auditPath, JSON.stringify(audit));
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const record = (type, payload) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
const metadata = () => ({ id: threadId, sessionId: threadId, path: rollout, cwd: process.cwd(), model: 'synthetic-codex', modelProvider: 'openai', turns: [] });
function finish() {
  if (scenario === 'usage') {
    const error = { message: 'Synthetic quota exhausted', codexErrorInfo: 'usageLimitExceeded' };
    record('event_msg', { type: 'task_complete', turn_id: turnId, error });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error, items: [] } });
  } else {
    const text = 'בוצע מסלול הבדיקה המבודד.';
    record('event_msg', { type: 'agent_message', message: text, phase: 'final_answer' });
    record('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: text });
    notify('item/completed', { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text, phase: 'final_answer' } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return reply(msg.id, { userAgent: 'synthetic-focus' });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    threadId = randomUUID();
    const directory = path.join(home, 'sessions', '2026', '10', '20'); fs.mkdirSync(directory, { recursive: true });
    rollout = path.join(directory, `rollout-2026-10-20-${threadId}.jsonl`);
    threads.set(threadId, rollout);
    record('session_meta', { id: threadId, cwd: process.cwd(), timestamp: new Date().toISOString(), source: 'cli', originator: 'synthetic', cli_version: '0.163.0', model_provider: 'openai' });
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: threadId, thread_name: 'Focused fixture', updated_at: new Date().toISOString() }) + '\n');
    return reply(msg.id, { thread: metadata() });
  }
  if (msg.method === 'thread/resume' || msg.method === 'thread/read') {
    threadId = msg.params.threadId;
    const directory = path.join(home, 'sessions', '2026', '10', '20');
    rollout = threads.get(threadId) || (fs.existsSync(path.join(directory, `rollout-2026-10-20-${threadId}.jsonl`))
      ? path.join(directory, `rollout-2026-10-20-${threadId}.jsonl`) : null);
    if (!rollout) throw Error('Unknown synthetic thread');
    return reply(msg.id, { thread: metadata() });
  }
  if (msg.method === 'turn/start') {
    turnId = randomUUID(); audit.starts++;
    const prompt = msg.params.input.filter(x => x.type === 'text').map(x => x.text).join('\n');
    scenario = prompt.includes('QUALIFY_USAGE_LIMIT') ? 'usage'
      : prompt.includes('QUALIFY_RATIONAL_COMPLETE') ? 'rational-complete'
      : prompt.includes('QUALIFY_RATIONAL_EXPIRE') ? 'rational-expire'
      : prompt.includes('QUALIFY_RATIONAL_INCOMPLETE') ? 'rational-incomplete' : 'focus';
    if (prompt.includes('מצב שיקול דעת הנדסי פעיל')) audit.focusedPrompts++;
    save(); record('event_msg', { type: 'user_message', message: prompt });
    record('event_msg', { type: 'task_started', turn_id: turnId });
    reply(msg.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    if (scenario === 'focus') for (let i = 0; i < 7; i++) notify('item/completed', { threadId, turnId,
      item: { id: `failure-${i}`, type: 'commandExecution', status: 'completed', command: 'fixture-only-command', cwd: process.cwd(), exitCode: 1, aggregatedOutput: 'same synthetic failure' } });
    if (scenario.startsWith('rational')) {
      void (async () => {
        const file = JSON.parse(prompt.match(/--context ("[^"\n]+")/)?.[1] || 'null');
        if (!file) throw Error('Missing scoped work-mode context');
        const context = JSON.parse(fs.readFileSync(file, 'utf8'));
        async function control(action) {
          const response = await fetch(context.endpoint, { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${context.token}` },
            body: JSON.stringify({ ...action, runId: context.runId }) });
          const value = await response.json();
          if (!response.ok) throw Error(value.error);
          return value;
        }
        const { run } = await control({ action: 'plan', tasks: [{ title: 'משימת בדיקה מבודדת', estimatedMinutes: 1 }] });
        if (scenario === 'rational-complete') await control({ action: 'complete', taskId: run.tasks[0].id, evidence: 'בוצע ונבדק בתרחיש native סינתטי' });
        if (scenario !== 'rational-expire') finishTimer = setTimeout(finish, 650);
      })().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
    } else finishTimer = setTimeout(finish, 650);
    return;
  }
  if (msg.method === 'turn/interrupt') {
    clearTimeout(finishTimer);
    record('event_msg', { type: 'turn_aborted', turn_id: turnId });
    reply(msg.id, {});
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
    return;
  }
  if (msg.method === 'turn/steer') {
    if (msg.params.expectedTurnId !== turnId) throw Error('Wrong turn');
    audit.steers++; save(); return reply(msg.id, { turnId });
  }
  reply(msg.id, {});
});
