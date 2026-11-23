#!/usr/bin/env node
// Isolated protocol fixture, never an installed native owner or model provider.
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const socket = process.argv.find(arg => arg.startsWith('unix://')).slice(7);
const owner = path.dirname(socket), home = process.env.CODEX_HOME;
const threads = new Map([
  ['own', { status: 'active', source: 'vscode' }],
  ['child', { status: 'active', parent: 'own' }],
  ['idle-child', { status: 'idle', parent: 'own' }],
  ['terminal-child', { status: 'idle', parent: 'own' }],
  ['old-root', { status: 'notLoaded', source: 'vscode' }],
  ['orphan', { status: 'idle', parent: 'old-root' }],
]);
const historyFile = path.join(owner, 'fixture-history-preserved');
fs.writeFileSync(historyFile, 'synthetic persisted history');
fs.appendFileSync(path.join(owner, 'fixture-started-pids'), process.pid + '\n');
const server = createServer(), sockets = new WebSocketServer({ server });
const answers = new Set();
const unsubscribes = [];
const terminal = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
let submissions = 0, expiredGraceChecks = 0, refusedRetentionSweeps = 0;
const metadata = id => {
  const value = threads.get(id);
  if (!value) throw Error('missing fixture thread');
  return { id, ephemeral: false, historyMode: 'paginated', status: { type: value.status },
    source: value.parent ? { subAgent: { thread_spawn: { parent_thread_id: value.parent, depth: 1 } } } : value.source };
};
const settings = () => ({ model: 'fixture-model', reasoningEffort: 'medium', cwd: owner,
  approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, collaborationMode: { mode: 'default' } });
function collectIfUnsubscribed(id) {
  const thread = threads.get(id);
  if (thread?.status !== 'idle' || [...sockets.clients].some(socket => socket.subscriptions?.has(id))) return;
  thread.status = 'notLoaded';
  if (id === 'terminal-child') terminal.kill('SIGTERM');
  for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ method: 'thread/closed', params: { threadId: id } }));
}
function maybeCollect(id) {
  setTimeout(() => collectIfUnsubscribed(id),
  // Accelerate only orphan reclamation. The protected tree's grace must
  // exceed the handoff/recovery deadline, as native's thirty-minute grace does.
    id === 'orphan' ? 1_500 : 30_000).unref();
}
sockets.on('connection', socket => {
  socket.subscriptions = new Set();
  socket.on('close', () => { for (const id of socket.subscriptions) maybeCollect(id); });
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString()), params = frame.params ?? {};
    if (!frame.method) { answers.add(String(frame.id)); return; }
    if (frame.method === 'initialized') return;
    const send = result => socket.send(JSON.stringify({ id: frame.id, result }));
    try {
      if (frame.method === 'initialize') { socket.clientName = params.clientInfo.name; send({ codexHome: home }); }
      else if (frame.method === 'thread/loaded/list') {
        if (socket.clientName === 'code-ai-broker-retention' && refusedRetentionSweeps > 0) {
          refusedRetentionSweeps--; throw Error('Synthetic retention inspection failure');
        }
        send({ data: [...threads].filter(([, t]) => t.status !== 'notLoaded').map(([id]) => id), nextCursor: null });
      }
      else if (frame.method === 'thread/read') send({ thread: metadata(params.threadId) });
      else if (frame.method === 'thread/resume') {
        socket.subscriptions.add(params.threadId);
        send({ ...settings(), thread: metadata(params.threadId) });
        if (['own', 'child'].includes(params.threadId)) socket.send(JSON.stringify({
          id: 'question-' + params.threadId, method: 'item/tool/requestUserInput',
          params: { threadId: params.threadId, turnId: params.threadId + '-turn', questions: [] },
        }));
      } else if (frame.method === 'thread/turns/list') send({ data: [{ id: params.threadId + '-turn', status: threads.get(params.threadId).status === 'active' ? 'inProgress' : 'completed' }], nextCursor: null });
      else if (frame.method === 'thread/items/list') send({ data: [{ turnId: params.threadId + '-turn', item: { type: 'userMessage', clientId: 'own-input' } }], nextCursor: null });
      else if (frame.method === 'thread/queue/list') send({ data: [], nextCursor: null });
      else if (frame.method === 'thread/backgroundTerminals/list') send({ data: params.threadId === 'terminal-child'
        && terminal.exitCode === null && terminal.signalCode === null ? [{ id: 'fixture-terminal', pid: terminal.pid }] : [], nextCursor: null });
      else if (frame.method === 'thread/goal/get') send({ goal: null });
      else if (frame.method === 'thread/unsubscribe') {
        unsubscribes.push({ threadId: params.threadId, clientName: socket.clientName });
        const removed = socket.subscriptions.delete(params.threadId);
        send({ status: threads.get(params.threadId).status === 'notLoaded' ? 'notLoaded' : removed ? 'unsubscribed' : 'notSubscribed' });
        maybeCollect(params.threadId);
      } else if (frame.method === 'thread/queue/add' || frame.method === 'turn/start') { submissions++; throw Error('Input replay is forbidden in this fixture'); }
      else if (frame.method === 'fixture/subscribeAll') {
        for (const peer of sockets.clients) if (peer.clientName && peer.clientName !== 'fixture-control') {
          for (const [id, thread] of threads) if (thread.status !== 'notLoaded') peer.subscriptions.add(id);
        }
        send({});
      } else if (frame.method === 'fixture/failNextRetentionSweep') { refusedRetentionSweeps++; send({});
      } else if (frame.method === 'fixture/advancePastIdleGrace') {
        // Synthetic time advancement makes every unobserved idle thread
        // eligible now; it does not change a production timer or grace value.
        expiredGraceChecks++;
        for (const id of threads.keys()) collectIfUnsubscribed(id);
        send({ expiredGraceChecks });
      } else if (frame.method === 'fixture/state') send({ pid: process.pid, submissions, unsubscribes, expiredGraceChecks,
        terminalPid: terminal.pid, terminalAlive: terminal.exitCode === null && terminal.signalCode === null,
        answers: [...answers], historyPreserved: fs.existsSync(historyFile),
        threads: Object.fromEntries([...threads].map(([id, thread]) => [id, { status: thread.status,
          subscribers: [...sockets.clients].filter(peer => peer.subscriptions?.has(id)).map(peer => peer.clientName) }])) });
      else throw Error('Unsupported fixture operation');
    } catch { socket.send(JSON.stringify({ id: frame.id, error: { code: -32600, message: 'Isolated fixture refused operation' } })); }
  });
});
server.listen(socket);
process.on('SIGTERM', () => {
  terminal.kill('SIGTERM');
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(() => server.close(() => process.exit(0)));
});
