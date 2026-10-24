/**
 * Installed-native submission contract. Synthetic private CODEX_HOME only;
 * no real account, history, credential, model, or installed configuration.
 * Usage: node SCRIPT ABSOLUTE_CODEX_BIN [--bridge ABSOLUTE_BRIDGE] [--steer]
 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { recoverReservedQueuedInput } from '../server/codexQueuedRecovery.mjs';

const bin = process.argv[2];
const bridgeIndex = process.argv.indexOf('--bridge');
const bridge = bridgeIndex < 0
  ? fileURLToPath(new URL('./codex-shared-stdio.mjs', import.meta.url))
  : process.argv[bridgeIndex + 1];
if (!bin || !path.isAbsolute(bin) || !bridge || !path.isAbsolute(bridge)) {
  throw new Error('Explicit absolute native binary and bridge required');
}
const steer = process.argv.includes('--steer');
const brokerEnabled = process.argv.includes('--broker');
const disconnect = process.argv.includes('--disconnect');
const restartBroker = process.argv.includes('--restart-broker');
const interruptOwn = process.argv.includes('--interrupt-own');
const recoverInterrupted = process.argv.includes('--recover-interrupted');
if (recoverInterrupted && !interruptOwn) throw new Error('Interrupted recovery requires the interruption scenario');
if (disconnect && !brokerEnabled) throw new Error('Disconnect qualification requires the managed broker');
if (restartBroker && !brokerEnabled) throw new Error('Restart qualification requires the managed broker');
if (interruptOwn && !brokerEnabled) throw new Error('Interruption qualification requires the managed broker');
const brokerScriptIndex = process.argv.indexOf('--broker-script');
const brokerScript = brokerScriptIndex < 0
  ? fileURLToPath(new URL('../server/codexSharedOwnerBroker.mjs', import.meta.url))
  : process.argv[brokerScriptIndex + 1];
if (brokerEnabled && (!brokerScript || !path.isAbsolute(brokerScript))) throw new Error('Absolute broker fixture required');
const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-native-submit-contract-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
const pinnedCwd = path.join(root, 'pinned-workspace');
await mkdir(home, { mode: 0o700 });
await mkdir(cwd, { mode: 0o700 });
await mkdir(pinnedCwd, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
Object.assign(env, { CODEX_HOME: home, HOME: root });
const owners = [], clients = [], requests = [], checks = {};
let freshProviderCalls = 0;
let stage = 'fixture-preparation', lastRpc = null, releaseDesktop;
const desktopHeld = new Promise(resolve => { releaseDesktop = resolve; });
const provider = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
    req.resume(); res.writeHead(404).end(); return;
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const fresh = JSON.stringify(body.input).includes('Synthetic fresh Default constructor qualification.');
    const recovery = JSON.stringify(body.input).includes('Synthetic recovery after interruption.');
    // Synthetic request only. Keep model/effort metadata; never log request bodies.
    const ordinal = fresh ? ++freshProviderCalls : requests.push({ model: body.model,
      effort: body.reasoning?.effort ?? null, pinnedCwdInModelContext: JSON.stringify(body.input).includes(pinnedCwd) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ type: 'response.created', response: { id: `fixture-${ordinal}` } });
    if (!fresh && ordinal === 1) await desktopHeld;
    if (!fresh && !recovery && !steer && (brokerEnabled ? (interruptOwn ? [1, 3, 4] : [1, 3, 5]).includes(ordinal) : [2, 4].includes(ordinal))) {
      event({ type: 'response.output_item.done', item: {
        type: 'function_call', id: `question-item-${ordinal}`, call_id: `question-${ordinal}`,
        name: 'request_user_input', arguments: JSON.stringify({ questions: [{
          id: 'fixture_answer', header: 'Contract', question: 'Continue this synthetic turn?',
          options: [{ label: 'Yes', description: 'Continue the isolated fixture.' },
            { label: 'No', description: 'Stop the isolated fixture.' }],
        }] }),
      } });
    } else {
      event({ type: 'response.output_item.done', item: {
        type: 'message', role: 'assistant', id: `answer-${ordinal}`,
        content: [{ type: 'output_text', text: 'Synthetic contract answer.' }],
      } });
    }
    event({ type: 'response.completed', response: {
      id: `fixture-${ordinal}`, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    } });
    res.end();
  } catch {
    res.destroy();
  }
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
await writeFile(path.join(home, 'config.toml'), [
  'model = "mock-model"', 'model_provider = "contract"',
  'model_reasoning_effort = "medium"', `approval_policy = "${brokerEnabled ? 'on-request' : 'never'}"`, 'sandbox_mode = "read-only"',
  '[model_providers.contract]', 'name = "Isolated fake provider"',
  `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
  'wire_api = "responses"', 'requires_openai_auth = false',
].join('\n') + '\n', { mode: 0o600 });

async function waitFor(predicate, limit = 30_000) {
  const deadline = Date.now() + limit;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Isolated condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function owner(socket) {
  const proc = spawn(bin, ['app-server', '--listen', `unix://${socket}`], {
    env, cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  owners.push(proc);
  proc.stderr.resume();
  let failed = false;
  proc.on('error', () => { failed = true; });
  await waitFor(async () => {
    if (failed || proc.exitCode !== null) throw new Error('Synthetic owner failed');
    return stat(socket).then(s => s.isSocket(), () => false);
  }, 15_000);
  return socket;
}

async function client(socket, clientName = 'code-ai') {
  const proc = spawn(process.execPath, [bridge, socket], {
    env, cwd, stdio: ['pipe', 'pipe', 'pipe'],
  });
  clients.push(proc);
  proc.stderr.resume();
  let next = 0, buffer = '';
  const pending = new Map(), events = [];
  const fail = () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer); call.reject(new Error('Synthetic client closed'));
    }
    pending.clear();
  };
  proc.on('close', fail); proc.on('error', fail); proc.stdin.on('error', fail);
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let frame;
      try { frame = JSON.parse(raw); } catch { fail(); return; }
      // Server request IDs may equal outstanding client request IDs. A method
      // distinguishes a server request; do not accidentally consume it as a reply.
      const call = !frame.method && pending.get(frame.id);
      if (call) {
        pending.delete(frame.id); clearTimeout(call.timer); call.resolve(frame);
      } else events.push(frame);
    }
  });
  const send = frame => proc.stdin.write(JSON.stringify(frame) + '\n');
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error('Synthetic RPC timed out'));
    }, 15_000);
    pending.set(id, { resolve: frame => {
      lastRpc = { method, ok: !frame.error, code: frame.error?.code ?? null };
      resolve(frame);
    }, reject, timer });
    send({ id, method, params });
  });
  const init = await call('initialize', {
    clientInfo: { name: clientName, version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  assert.equal(init.error, undefined);
  assert.equal(init.result.codexHome, home);
  send({ method: 'initialized', params: {} });
  return { call, send, events, initialize: init.result, close: () => proc.stdin.end() };
}

const input = text => [{ type: 'text', text, text_elements: [] }];
const question = (client, turnId) => client.events.find(frame =>
  frame.method === 'item/tool/requestUserInput' || frame.method === 'tool/requestUserInput'
    ? frame.params?.turnId === turnId : false);
const user = (client, clientId) => client.events.find(frame =>
  frame.method === 'item/started' && frame.params?.item?.type === 'userMessage'
    && frame.params.item.clientId === clientId);
const completed = (client, turnId) => client.events.some(frame =>
  frame.method === 'turn/completed' && frame.params?.turn?.id === turnId);
const answer = (client, frame) => client.send({ id: frame.id, result: {
  answers: { fixture_answer: { answers: ['Yes'] } },
} });

try {
  const backendSocket = await owner(path.join(root, 'desktop.sock'));
  let desktopSocket = backendSocket;
  let brokerProcess;
  const launchBroker = async () => {
    const proc = spawn(process.execPath, [brokerScript, desktopSocket, backendSocket, path.join(root, 'reservations.json')],
      { env, cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    owners.push(proc); proc.stderr.resume();
    await waitFor(() => {
      if (proc.exitCode !== null) throw new Error('Synthetic broker failed');
      return stat(desktopSocket).then(s => s.isSocket(), () => false);
    }, 15_000);
    brokerProcess = proc;
  };
  if (brokerEnabled) {
    desktopSocket = path.join(root, 'broker.sock');
    await launchBroker();
  }
  let desktop = await client(desktopSocket, 'codex-desktop-contract');
  let web = await client(desktopSocket);
  if (brokerEnabled) {
    assert.deepEqual(web.initialize.codeAiSharedOwner, { version: 1, turnSettings: true, historyReads: 'canonical-v1' });
    checks.managedOwnerHandshakeRequiredAndPresent = true;
    stage = 'fresh-default-constructor-noop-settings';
    const fresh = await web.call('thread/start', { cwd, ephemeral: false });
    assert.equal(fresh.error, undefined);
    const freshThreadId = fresh.result.thread.id;
    stage = 'fresh-default-constructor-queue-readback';
    const freshQueue = await web.call('thread/queue/list', { threadId: freshThreadId, limit: 1 });
    assert.equal(freshQueue.error, undefined);
    stage = 'fresh-default-constructor-noop-settings';
    const submitted = await web.call('thread/queue/add', {
      threadId: freshThreadId, input: input('Synthetic fresh Default constructor qualification.'),
      clientUserMessageId: 'fresh-default-contract',
      codeAiTurnSettings: { model: 'mock-model', effort: 'medium', cwd,
        approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
      codeAiExpectedCollaborationMode: 'default',
    });
    if (submitted.error) {
      const metadata = await readFile(path.join(root, 'reservations.json'), 'utf8').then(JSON.parse, () => null);
      stage = `fresh-default-constructor-${metadata?.records?.find(record => record.threadId === freshThreadId)?.phase ?? 'before-journal'}`;
    }
    assert.equal(submitted.error, undefined);
    await waitFor(() => user(web, 'fresh-default-contract'));
    const freshTurnId = user(web, 'fresh-default-contract').params.turnId;
    await waitFor(() => completed(web, freshTurnId));
    const rollout = fresh.result.thread.path;
    assert.ok(typeof rollout === 'string' && rollout.startsWith(home + path.sep));
    const contexts = (await readFile(rollout, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
      .filter(frame => frame.type === 'turn_context').map(frame => frame.payload);
    assert.ok(contexts.some(context => context.turn_id === freshTurnId && context.collaboration_mode?.mode === 'default'));
    checks.freshDefaultConstructorAdmitsNoopSettingsAndCapturesDefault = true;
  }
  const started = await desktop.call('thread/start', { cwd, ephemeral: false });
  assert.equal(started.error, undefined);
  const threadId = started.result.thread.id;
  const external = await desktop.call('turn/start', {
    threadId, input: input('Synthetic desktop held turn.'), clientUserMessageId: 'desktop-contract',
    collaborationMode: { mode: 'plan', settings: {
      model: 'mock-model', reasoning_effort: 'medium', developer_instructions: null,
    } },
  });
  assert.equal(external.error, undefined);
  const desktopTurnId = external.result.turn.id;
  await waitFor(() => requests.length === 1);
  const resumed = await web.call('thread/resume', { threadId, excludeTurns: true });
  assert.equal(resumed.error, undefined);
  checks.sameOwnerResumeNoWriterConflict = true;
  if (steer) {
    stage = 'busy-turn-start-steer';
    const result = await web.call('turn/start', {
      threadId, input: input('Synthetic web start during desktop work.'),
      clientUserMessageId: 'unsafe-start-contract', model: 'mock-requested', effort: 'high',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.result.turn.id, desktopTurnId);
    checks.busyTurnStartSteersExistingTurn = true;
    checks.turnStartHasNoAtomicIdlePrecondition = true;
    releaseDesktop();
    await waitFor(() => completed(desktop, desktopTurnId));
  } else {
    stage = 'shared-queue-config-and-cancellation';
    if (brokerEnabled) {
      const mismatch = await web.call('thread/queue/add', {
        threadId, input: input('Synthetic rejected Default mode in Plan owner.'), clientUserMessageId: 'mode-mismatch-contract',
        codeAiTurnSettings: { model: 'mock-mode-mismatch', effort: 'high', cwd: pinnedCwd,
          approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
        codeAiExpectedCollaborationMode: 'default',
      });
      assert.equal(mismatch.error?.data?.reason, 'native-collaboration-mode-mismatch');
      const pending = await web.call('thread/queue/list', { threadId, limit: 10 });
      assert.equal(pending.result.data.some(item => item.clientUserMessageId === 'mode-mismatch-contract'), false);
      assert.equal(requests.length, 1);
      checks.incompatiblePlanOwnerRefusedBeforeQueueCustody = true;
      const removablePinned = await web.call('thread/queue/add', {
        threadId, input: input('Synthetic pinned pending cancellation.'), clientUserMessageId: 'cancel-pinned-contract',
        codeAiTurnSettings: { model: 'mock-removable', effort: 'high', cwd: pinnedCwd,
          approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
        codeAiExpectedCollaborationMode: 'plan',
      });
      assert.equal(removablePinned.error, undefined);
      const removed = await web.call('thread/queue/delete', {
        threadId, queuedSubmissionId: removablePinned.result.queuedSubmission.id,
      });
      assert.equal(removed.result.deleted, true);
      const restored = await web.call('thread/resume', { threadId, excludeTurns: true });
      assert.equal(restored.result.model, 'mock-model');
      assert.equal(restored.result.reasoningEffort, 'medium');
      assert.equal(restored.result.cwd, cwd);
      assert.equal(restored.result.approvalPolicy, 'on-request');
      assert.equal(requests.length, 1);
      checks.brokerCancelPendingRestoresOriginalDefaults = true;
    }
    const queued = await web.call('thread/queue/add', {
      threadId, input: input('Synthetic common-owner queued turn.'), clientUserMessageId: 'web-contract',
      ...(brokerEnabled ? { codeAiTurnSettings: { model: 'mock-requested', effort: 'high',
        cwd: pinnedCwd, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
        codeAiExpectedCollaborationMode: 'plan' }
        : { model: 'mock-requested', effort: 'high' }),
    });
    assert.equal(queued.error, undefined);
    assert.equal(queued.result.queuedSubmission.clientUserMessageId, 'web-contract');
    checks.queueAddAcceptsInputWhileDesktopBusy = true;
    const notIdle = await web.call('thread/queue/start', {
      threadId, queuedSubmissionId: queued.result.queuedSubmission.id,
    });
    assert.equal(notIdle.error?.code, brokerEnabled ? -32001 : -32600);
    const removable = await web.call('thread/queue/add', {
      threadId, input: input('Synthetic cancellable queued turn.'), clientUserMessageId: 'cancel-contract',
    });
    if (brokerEnabled) {
      assert.equal(removable.error?.code, -32001);
      checks.secondQueuedAdmissionRejectedBeforeInput = true;
    } else {
      assert.equal(removable.error, undefined);
      assert.equal((await web.call('thread/queue/delete', {
        threadId, queuedSubmissionId: removable.result.queuedSubmission.id,
      })).result.deleted, true);
    }
    assert.equal(requests.length, 1);
    checks.queueStartBusyRefusedWithoutSteer = true;
    checks.cancelPendingPreservesDesktopTurn = true;
    const update = await desktop.call('thread/settings/update', {
      threadId, model: 'mock-owner-updated', effort: 'low',
    });
    if (brokerEnabled) {
      assert.equal(update.error?.code, -32001);
      checks.foreignSettingsRaceRejectedBeforeMutation = true;
    } else assert.equal(update.error, undefined);
    if (disconnect) {
      web.close();
      await new Promise(resolve => setTimeout(resolve, 150));
      checks.frontendDisconnectDoesNotCancelPendingNativeInput = true;
    }
    if (restartBroker) {
      stage = 'metadata-reservation-broker-restart-close';
      const exited = once(brokerProcess, 'close');
      brokerProcess.kill('SIGTERM');
      await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Synthetic broker close timed out')), 10_000))]);
      assert.equal(await stat(backendSocket).then(value => value.isSocket()), true);
      assert.equal(requests.length, 1);
      stage = 'metadata-reservation-broker-restart-open';
      await launchBroker();
      stage = 'metadata-reservation-broker-restart-rejoin';
      desktop = await client(desktopSocket, 'codex-desktop-contract');
      web = await client(desktopSocket);
      for (const c of [desktop, web]) assert.equal((await c.call('thread/resume', {
        threadId, excludeTurns: true,
      })).error, undefined);
      const admission = await desktop.call('thread/settings/update', { threadId, model: 'mock-after-restart-foreign' });
      assert.equal(admission.error?.code, -32001);
      const queue = await web.call('thread/queue/list', { threadId, limit: 10 });
      assert.equal(queue.result.data.filter(item => item.clientUserMessageId === 'web-contract').length, 1);
      checks.brokerRestartKeepsNativeOwnerAndQueuedInputExactlyOnce = true;
      checks.durableReservationBlocksForeignConfigAfterBrokerRestart = true;
    }
    releaseDesktop();
    if (brokerEnabled) {
      stage = 'desktop-captured-settings-preserved';
      await waitFor(() => question(desktop, desktopTurnId));
      answer(desktop, question(desktop, desktopTurnId));
      await waitFor(() => requests.length >= 3);
      assert.equal(requests[1].model, 'mock-model');
      assert.equal(requests[1].effort, 'medium');
      assert.equal(requests[1].pinnedCwdInModelContext, false);
      checks.desktopContinuationKeepsOriginalModelEffortCwd = true;
    }
    stage = 'common-owner-question-round-trip';
    let recoveredTurnId;
    if (disconnect && !restartBroker) {
      // Another subscribed native client observes proof of dispatch. Rejoining
      // resumes the same native owner and replays its still-pending request;
      // the broker neither manufactures an answer nor replays user input.
      await waitFor(() => user(desktop, 'web-contract'));
      const provedTurnId = user(desktop, 'web-contract').params.turnId;
      await waitFor(() => question(desktop, provedTurnId));
      web = await client(desktopSocket);
      const rejoin = await web.call('thread/resume', { threadId, excludeTurns: false });
      assert.equal(rejoin.error, undefined);
      const replayedTurn = rejoin.result.thread.turns.find(turn => turn.id === provedTurnId);
      assert.ok(replayedTurn?.items.some(item => item.type === 'userMessage' && item.clientId === 'web-contract'));
      recoveredTurnId = provedTurnId;
      await waitFor(() => question(web, provedTurnId));
      checks.lateCommonOwnerRejoinReplaysOwnQuestionWithoutInputReplay = true;
    }
    if (!recoveredTurnId) await waitFor(() => user(web, 'web-contract'));
    const webTurnId = recoveredTurnId ?? user(web, 'web-contract').params.turnId;
    assert.notEqual(webTurnId, desktopTurnId);
    await waitFor(() => question(web, webTurnId));
    if (brokerEnabled) {
      assert.equal(requests[2].model, 'mock-requested');
      assert.equal(requests[2].effort, 'high');
      assert.equal(requests[2].pinnedCwdInModelContext, true);
      checks.reservedTurnStartsWithRequestedModelEffortCwd = true;
      const mutation = await desktop.call('turn/settings/update', {
        threadId, turnId: webTurnId, model: 'mock-foreign-active-mutation',
      });
      assert.equal(mutation.error?.code, -32001);
      checks.foreignOwnTurnSettingsMutationRejected = true;
      const active = await web.call('thread/resume', { threadId, excludeTurns: true });
      assert.equal(active.result.approvalPolicy, 'never');
      assert.equal(active.result.sandbox.type, 'dangerFullAccess');
      checks.activeMcpAuthorizationPolicyRemainsPinned = true;
    } else {
      assert.equal(requests[1].model, 'mock-owner-updated');
      checks.queueIgnoresUnrecognizedPerSubmissionModel = true;
      checks.queueInheritsOwnerSettingsAtExecution = true;
    }
    checks.stableClientIdProvesOwnTurn = true;
    checks.commonOwnerDeliversOwnQuestionToWeb = true;
    if (interruptOwn) {
      const pendingDelete = await web.call('thread/queue/delete', {
        threadId, queuedSubmissionId: queued.result.queuedSubmission.id,
      });
      assert.equal(pendingDelete.result.deleted, false);
      assert.equal(completed(web, webTurnId), false);
      const interrupted = await web.call('turn/interrupt', { threadId, turnId: webTurnId });
      assert.equal(interrupted.error, undefined);
    } else answer(web, question(web, webTurnId));
    await waitFor(() => completed(web, webTurnId));
    if (brokerEnabled) {
      await waitFor(async () => {
        const metadata = JSON.parse(await readFile(path.join(root, 'reservations.json'), 'utf8'));
        return metadata.records.find(record => record.threadId === threadId)?.phase === 'released';
      });
      if (interruptOwn) {
        assert.equal(web.events.find(frame => frame.method === 'turn/completed'
          && frame.params?.turn?.id === webTurnId).params.turn.status, 'interrupted');
        assert.equal(requests.length, 3);
        checks.provenOwnActiveInterruptCancelsOnlyRequestedTurn = true;
        checks.startedQueueDeleteNeverGuessesOrCancelsOwnerTurn = true;
      } else {
        assert.equal(requests[3].model, 'mock-requested');
        assert.equal(requests[3].effort, 'high');
        assert.equal(requests[3].pinnedCwdInModelContext, true);
        checks.ownContinuationKeepsPinnedSettingsAfterFutureRestore = true;
      }
      const current = await desktop.call('thread/resume', { threadId, excludeTurns: true });
      assert.equal(current.result.model, 'mock-model');
      assert.equal(current.result.reasoningEffort, 'medium');
      assert.equal(current.result.cwd, cwd);
      assert.equal(current.result.approvalPolicy, 'on-request');
      assert.deepEqual(current.result.sandbox, { type: 'readOnly', networkAccess: false });
      checks.futureGuiDefaultsExactlyRestored = true;
      const metadata = JSON.parse(await readFile(path.join(root, 'reservations.json'), 'utf8'));
      assert.equal(JSON.stringify(metadata).includes('Synthetic common-owner queued turn.'), false);
      assert.equal(metadata.records.find(record => record.threadId === threadId).phase, 'released');
      checks.privateJournalContainsMetadataOnly = true;
    }
    if (!interruptOwn) checks.commonOwnerAcceptsWebQuestionAnswer = true;
    if (interruptOwn) {
      const rollout = started.result.thread.path;
      assert.ok(typeof rollout === 'string' && rollout.startsWith(home + path.sep));
      const contexts = (await readFile(rollout, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
        .filter(frame => frame.type === 'turn_context').map(frame => frame.payload);
      assert.ok(contexts.some(context => context.turn_id === webTurnId && context.cwd === pinnedCwd
        && context.approval_policy === 'never' && context.sandbox_policy.type === 'danger-full-access'));
      checks.nativeInterruptedOwnTurnHadScopedRequestedPolicy = true;
      if (recoverInterrupted) {
        stage = 'interrupted-idle-queue-recovery';
        const next = await web.call('thread/queue/add', {threadId, input:input('Synthetic recovery after interruption.'),
          clientUserMessageId:'after-interrupt',codeAiTurnSettings:{model:'mock-requested',effort:'high',cwd:pinnedCwd,
            approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}},codeAiExpectedCollaborationMode:'plan'});
        assert.equal(next.error,undefined);
        const raw = await client(backendSocket,'code-ai-owned-queue-recovery');
        const rpc = async(method,params)=>{const result=await raw.call(method,params);if(result.error){const e=Error('Synthetic native rejection');e.nativeRejected=true;e.code=result.error.code;throw e;}return result.result;};
        const status = await recoverReservedQueuedInput({rpc,threadId,queuedSubmissionId:next.result.queuedSubmission.id,
          clientUserMessageId:'after-interrupt',readReservation:async()=>JSON.parse(await readFile(path.join(root,'reservations.json'),'utf8')).records.find(r=>r.threadId===threadId)});
        assert.ok(['start-requested','not-reserved','busy','not-first','changed','native-race'].includes(status));
        await waitFor(()=>user(web,'after-interrupt'));
        const recoveredId=user(web,'after-interrupt').params.turnId;
        await waitFor(()=>completed(web,recoveredId));
        const history=await raw.call('thread/read',{threadId,includeTurns:true});
        assert.equal(history.error,undefined);
        assert.equal(history.result.thread.turns.filter(t=>t.items.some(i=>i.type==='userMessage'&&i.clientId==='after-interrupt')).length,1);
        checks.interruptedThenQueuedInputRecoveredExactlyOnce=true;
        checks.recoveryNeverResentInputOrSteeredExistingTurn=true;
      }
    } else {
    stage = 'external-owner-unloaded-enqueue';
    const peerSocket = await owner(path.join(root, 'peer.sock'));
    const peer = await client(peerSocket);
    const loaded = await peer.call('thread/loaded/list', {});
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.result.data.includes(threadId), false);
    const peerQueued = await peer.call('thread/queue/add', {
      threadId, input: input('Synthetic external-owner queued turn.'),
      clientUserMessageId: 'peer-contract',
    });
    assert.equal(peerQueued.error, undefined);
    checks.unloadedOtherOwnerEnqueueAccepted = true;
    await waitFor(() => user(desktop, 'peer-contract'), 35_000);
    const peerTurnId = user(desktop, 'peer-contract').params.turnId;
    await waitFor(() => question(desktop, peerTurnId));
    checks.originalWriterConsumesOtherOwnerQueue = true;
    assert.equal(question(peer, peerTurnId), undefined);
    checks.otherOwnerCannotReceiveQuestion = true;
    const resumeConflict = await peer.call('thread/resume', { threadId, excludeTurns: true });
    assert.ok(resumeConflict.error);
    checks.otherOwnerResumeStillBlockedByWriter = true;
    const interrupt = await peer.call('turn/interrupt', { threadId, turnId: peerTurnId });
    assert.ok(interrupt.error);
    assert.equal(completed(desktop, peerTurnId), false);
    checks.otherOwnerCannotInterruptStartedTurn = true;
    answer(desktop, question(desktop, peerTurnId));
    await waitFor(() => completed(desktop, peerTurnId));
    const history = await peer.call('thread/read', { threadId, includeTurns: true });
    assert.equal(history.error, undefined);
    assert.equal(history.result.thread.turns.filter(turn => turn.items.some(item =>
      item.type === 'userMessage' && item.clientId === 'peer-contract')).length, 1);
    checks.otherOwnerReadsPersistedOwnTurnExactlyOnce = true;
    const loadedAfter = await peer.call('thread/loaded/list', {});
    assert.equal(loadedAfter.result.data.includes(threadId), false);
    checks.externalQueueNeverAcquiresWriter = true;
    if (brokerEnabled) {
      const next = interruptOwn ? 3 : 4;
      assert.equal(requests[next].model, 'mock-model');
      assert.equal(requests[next].effort, 'medium');
      assert.equal(requests[next + 1].model, 'mock-model');
      assert.equal(requests[next + 1].effort, 'medium');
      const rollout = started.result.thread.path;
      assert.ok(typeof rollout === 'string' && rollout.startsWith(home + path.sep));
      const contexts = (await readFile(rollout, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
        .filter(frame => frame.type === 'turn_context').map(frame => frame.payload);
      const own = contexts.filter(context => context.turn_id === webTurnId);
      assert.ok(own.length);
      assert.ok(own.every(context => context.cwd === pinnedCwd && context.approval_policy === 'never'
        && context.sandbox_policy.type === 'danger-full-access'));
      const foreign = contexts.filter(context => [desktopTurnId, peerTurnId].includes(context.turn_id));
      assert.ok(foreign.length >= 2);
      assert.ok(foreign.every(context => context.cwd === cwd && context.approval_policy === 'on-request'
        && context.sandbox_policy.type === 'read-only'));
      checks.nativeCapturedOwnPolicyScopedWithoutChangingGuiTurns = true;
    }
    for (const c of [desktop, web, peer]) c.close();
    }
    desktop.close(); web.close();
  }
  const version = await new Promise(resolve => execFile(bin, ['--version'], { env, cwd, timeout: 5_000 },
    (error, stdout) => resolve(error ? null : stdout.trim())));
  console.log(JSON.stringify({
    format: 'code-ai-native-submit-contract', version: 1, nativeVersion: version,
    synthetic: true, installedEffects: false, realCredentialsRead: false, realProviderCalls: 0,
    fakeProviderCalls: requests.length + freshProviderCalls, passed: Object.keys(checks).length, checks,
    requestedEffortObserved: requests.map(item => item.effort),
    broker: brokerEnabled, perSubmissionSettingsSupported: brokerEnabled, liveGuiMigrationProven: false,
    disconnect,
    restartBroker,
    interruptOwn,
    externalEnqueueIsFullIntegration: false,
  }));
} catch (error) {
  console.error(JSON.stringify({ format: 'code-ai-native-submit-contract', failed: true,
    stage, lastRpc, failureKind: error?.name ?? 'Error', failureCode: error?.code ?? null,
    assertionOperator: error?.operator ?? null,
    passed: Object.keys(checks).length, checks, synthetic: true,
    installedEffects: false, realCredentialsRead: false, realProviderCalls: 0,
    fakeProviderCalls: requests.length + freshProviderCalls }));
  process.exitCode = 1;
} finally {
  releaseDesktop();
  for (const client of clients) client.kill('SIGTERM');
  for (const owner of owners) {
    if (!owner.pid || owner.exitCode !== null) continue;
    try { process.kill(-owner.pid, 'SIGTERM'); } catch { /* Own disposable fixture only. */ }
    await Promise.race([once(owner, 'close'), new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (owner.exitCode === null && owner.signalCode === null) {
      try { process.kill(-owner.pid, 'SIGKILL'); } catch { /* Own disposable fixture only. */ }
    }
  }
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
