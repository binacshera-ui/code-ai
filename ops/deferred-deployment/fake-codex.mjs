#!/usr/bin/env node
// Synthetic qualification provider. No model, authentication or network APIs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.160.1');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('Synthetic Code AI qualification CLI: app-server --stdio, debug models');
  process.exit(0);
}
const providerHome = process.env.CODEX_HOME;
if (!providerHome || !existsSync(path.join(providerHome, '.code-ai-synthetic-fixture'))) {
  console.error('Synthetic Codex requires an explicitly marked isolated provider home.');
  process.exit(64);
}
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [{
    slug: 'synthetic-codex', display_name: 'Synthetic qualification provider', visibility: 'list',
    description: 'No inference or network activity', default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium', description: 'Fixture only' }],
  }] }));
  process.exit(0);
}
if (!args.includes('app-server')) {
  console.error('Unsupported synthetic Codex invocation.');
  process.exit(64);
}

const indexPath = path.join(providerHome, '.fixture-session-index.json');
const auditPath = path.join(providerHome, '.fixture-audit.json');
let index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
let audit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : {
  initializeCount: 0, threadStartCount: 0, threadResumeCount: 0, turnStartCount: 0, answerCount: 0,
};
let initialized = false;
let acknowledged = false;
let threadId = '';
let turnId = '';
let rolloutPath = '';
let requestNumber = 0;
let pendingRequest = null;
const accepted = [];
const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const record = (type, payload) => appendFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
const saveAudit = () => writeFileSync(auditPath, JSON.stringify(audit) + '\n', { mode: 0o600 });
const notify = (method, params) => send({ method, params });
const respond = (id, result) => send({ id, result });

function threadMetadata() {
  return { id: threadId, sessionId: threadId, path: rolloutPath, cwd: process.cwd(),
    model: 'synthetic-codex', modelProvider: 'openai', ephemeral: false, turns: [] };
}

function startThread(params) {
  threadId = randomUUID();
  const created = new Date().toISOString();
  const [year, month, day] = created.slice(0, 10).split('-');
  const directory = path.join(providerHome, 'sessions', year, month, day);
  mkdirSync(directory, { recursive: true });
  rolloutPath = path.join(directory, `rollout-${created.replaceAll(':', '-')}-${threadId}.jsonl`);
  record('session_meta', { id: threadId, timestamp: created, cwd: params.cwd || process.cwd(), source: 'cli',
    originator: 'code-ai-synthetic-qualification', cli_version: '0.160.1', model_provider: 'openai' });
  index[threadId] = rolloutPath;
  writeFileSync(indexPath, JSON.stringify(index) + '\n', { mode: 0o600 });
  appendFileSync(path.join(providerHome, 'session_index.jsonl'), JSON.stringify({ id: threadId,
    thread_name: 'Native interactive fixture', updated_at: created }) + '\n');
  audit.threadStartCount++;
  saveAudit();
}

function askQuestion(isBlocking) {
  const question = isBlocking
    ? { id: 'destination', header: 'Destination', question: 'Where should the fixture result be written?',
      isOther: true, isSecret: false,
      options: [{ label: 'Local (Recommended)', description: 'Keep the result in this workspace.' },
        { label: 'Archive', description: 'Use the archive folder.' }] }
    : { id: 'note', header: 'Result note', question: 'Add a short free-text note while work continues.',
      isOther: false, isSecret: false, options: null };
  const itemId = `fixture-input-${++requestNumber}`;
  const id = 100 + requestNumber;
  const params = { threadId, turnId, itemId, questions: [question], isBlocking, autoResolutionMs: null };
  record('response_item', { type: 'function_call', name: 'request_user_input', call_id: itemId,
    arguments: JSON.stringify({ questions: [question] }) });
  pendingRequest = { id, itemId, questionId: question.id, isBlocking };
  send({ id, method: 'item/tool/requestUserInput', params });
  if (!isBlocking) {
    const text = 'Continuing the same task while the optional note is pending.';
    record('event_msg', { type: 'agent_message', message: text, phase: 'commentary' });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'fixture-progress', delta: text });
    notify('item/completed', { threadId, turnId, item: { id: 'fixture-progress', type: 'agentMessage',
      text, phase: 'commentary', questions: null } });
  }
}

function finishTurn() {
  const actualDemo = path.join(process.cwd(), 'demo', 'DAB-CRM-preview.html');
  const text = `Fixture completed: destination=${accepted[0]}, note=${accepted[1]}\n\n![תמונת בדיקה](${process.cwd()}/demo/nested/pixel.png)\n\n[פתיחת הדמו האינטראקטיבי](${process.cwd()}/demo/index.html)`
    + (existsSync(actualDemo) ? `\n\n[פתיחת הדמו המקורי של המשתמש](${actualDemo})` : '');
  record('event_msg', { type: 'agent_message', message: text, phase: 'final_answer' });
  record('response_item', { type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text }] });
  record('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: text });
  notify('item/completed', { threadId, turnId, item: { id: 'fixture-final', type: 'agentMessage',
    text, phase: 'final_answer', questions: null } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
}

input.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      if (message.params?.capabilities?.experimentalApi !== true) throw new Error('Experimental capability not enabled');
      initialized = true;
      audit.initializeCount++;
      saveAudit();
      respond(message.id, { userAgent: 'code-ai-synthetic/0.160.1' });
      return;
    }
    if (message.method === 'initialized') { acknowledged = true; return; }
    if (!initialized || !acknowledged) throw new Error('Not initialized');
    if (message.method === 'thread/start') {
      if (message.params?.ephemeral !== false) throw new Error('Fixture requires durable native sessions');
      startThread(message.params);
      respond(message.id, { thread: threadMetadata() });
      notify('thread/started', { thread: threadMetadata() });
      return;
    }
    if (message.method === 'thread/resume') {
      threadId = message.params.threadId;
      rolloutPath = index[threadId];
      if (!rolloutPath || !existsSync(rolloutPath)) throw new Error('Synthetic session was not found');
      audit.threadResumeCount++;
      saveAudit();
      respond(message.id, { thread: threadMetadata() });
      return;
    }
    if (message.method === 'turn/start') {
      if (message.params.threadId !== threadId || pendingRequest) throw new Error('Invalid synthetic turn owner');
      turnId = randomUUID();
      accepted.length = 0;
      record('event_msg', { type: 'task_started', turn_id: turnId });
      record('event_msg', { type: 'user_message', message: message.params.input.filter(item => item.type === 'text').map(item => item.text).join('\n') });
      audit.turnStartCount++;
      saveAudit();
      respond(message.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      askQuestion(true);
      return;
    }
    if (message.method === 'turn/interrupt') {
      respond(message.id, {});
      if (pendingRequest) notify('serverRequest/resolved', { threadId, requestId: pendingRequest.id });
      pendingRequest = null;
      record('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [], error: null } });
      return;
    }
    if (!message.method && pendingRequest && message.id === pendingRequest.id) {
      const answer = message.result?.answers?.[pendingRequest.questionId]?.answers;
      if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== 'string' || !answer[0].trim()) {
        throw new Error('Invalid native synthetic answer');
      }
      accepted.push(answer[0]);
      record('response_item', { type: 'function_call_output', call_id: pendingRequest.itemId, output: JSON.stringify(message.result) });
      notify('serverRequest/resolved', { threadId, requestId: pendingRequest.id });
      audit.answerCount++;
      saveAudit();
      const wasBlocking = pendingRequest.isBlocking;
      pendingRequest = null;
      if (wasBlocking) askQuestion(false);
      else finishTurn();
      return;
    }
    throw new Error('Unsupported synthetic protocol message');
  } catch {
    // Never echo request parameters/answers or authentication material.
    console.error('Synthetic native protocol failed.');
    process.exitCode = 65;
    input.close();
    process.stdin.destroy();
  }
});

// The native runner must wait for EOF close, not stop as soon as final text arrives.
input.on('close', () => { process.stdin.destroy(); });
