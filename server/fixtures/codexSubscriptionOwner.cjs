#!/usr/bin/env node
// Isolated protocol fixture, never an installed native owner or model provider.
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const socket = process.argv.find(arg => arg.startsWith('unix://')).slice(7);
const owner = path.dirname(socket), home = process.env.CODEX_HOME;
const threads = new Map([
  ['own', { status: 'active', source: 'vscode' }],
  ['child', { status: 'active', parent: 'own' }],
  ['idle-child', { status: 'idle', parent: 'own' }],
  ['old-root', { status: 'notLoaded', source: 'vscode' }],
  ['orphan', { status: 'idle', parent: 'old-root' }],
]);
const historyFile = path.join(owner, 'fixture-history-preserved');
fs.writeFileSync(historyFile, 'synthetic persisted history');
fs.appendFileSync(path.join(owner, 'fixture-started-pids'), process.pid + '\n');
const server = createServer(), sockets = new WebSocketServer({ server });
const answers = new Set();
let submissions = 0;
const metadata = id => {
  const value = threads.get(id);
  if (!value) throw Error('missing fixture thread');
  return { id, ephemeral: false, historyMode: 'paginated', status: { type: value.status },
    source: value.parent ? { subAgent: { thread_spawn: { parent_thread_id: value.parent, depth: 1 } } } : value.source };
};
const settings = () => ({ model: 'fixture-model', reasoningEffort: 'medium', cwd: owner,
  approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, collaborationMode: { mode: 'default' } });
function maybeCollect(id) {
  setTimeout(() => {
    const thread = threads.get(id);
    if (thread?.status !== 'idle' || [...sockets.clients].some(socket => socket.subscriptions?.has(id))) return;
    thread.status = 'notLoaded';
    for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ method: 'thread/closed', params: { threadId: id } }));
  }, 1_500).unref();
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
      else if (frame.method === 'thread/loaded/list') send({ data: [...threads].filter(([, t]) => t.status !== 'notLoaded').map(([id]) => id), nextCursor: null });
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
      else if (frame.method === 'thread/queue/list' || frame.method === 'thread/backgroundTerminals/list') send({ data: [], nextCursor: null });
      else if (frame.method === 'thread/goal/get') send({ goal: null });
      else if (frame.method === 'thread/unsubscribe') {
        const removed = socket.subscriptions.delete(params.threadId);
        send({ status: threads.get(params.threadId).status === 'notLoaded' ? 'notLoaded' : removed ? 'unsubscribed' : 'notSubscribed' });
        maybeCollect(params.threadId);
      } else if (frame.method === 'thread/queue/add' || frame.method === 'turn/start') { submissions++; throw Error('Input replay is forbidden in this fixture'); }
      else if (frame.method === 'fixture/subscribeAll') {
        for (const peer of sockets.clients) if (peer.clientName && peer.clientName !== 'fixture-control') {
          for (const [id, thread] of threads) if (thread.status !== 'notLoaded') peer.subscriptions.add(id);
        }
        send({});
      } else if (frame.method === 'fixture/state') send({ pid: process.pid, submissions,
        answers: [...answers], historyPreserved: fs.existsSync(historyFile),
        threads: Object.fromEntries([...threads].map(([id, thread]) => [id, { status: thread.status,
          subscribers: [...sockets.clients].filter(peer => peer.subscriptions?.has(id)).map(peer => peer.clientName) }])) });
      else throw Error('Unsupported fixture operation');
    } catch { socket.send(JSON.stringify({ id: frame.id, error: { code: -32600, message: 'Isolated fixture refused operation' } })); }
  });
});
server.listen(socket);
process.on('SIGTERM', () => {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(() => server.close(() => process.exit(0)));
});
