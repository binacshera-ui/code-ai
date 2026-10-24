import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { once } from 'node:events';
import { fleetClient } from '../focus-notifications-20261020/fleet-live.mjs';

const root = '/root/projects/code-ai', ops = root + '/ops/native-image-input-20261021';
const id = 'e7c9ac52-e667-4c11-a679-72ee53eea76e', sessionId = '01a15d20-ccb1-78c0-b0d1-baa9ee4bbced';
const file = ops + '/recovery.json';
const report = JSON.parse(await fs.readFile(file, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
}));
const save = () => fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
assert.equal(JSON.parse(await fs.readFile(ops + '/activation.json', 'utf8')).complete, true);
const api = await fleetClient();
let { item } = await api('local', '/queue/items/' + id + '?includeSession=false');
assert.equal(item.sessionId, sessionId); assert.equal(item.profileId, 'developer');
const socket = new WebSocket('ws+unix:///home/developer/.codex/code-ai-shared-owner/owner.sock:/', { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
await once(socket, 'open');
const pending = new Map(); let nextId = 0;
socket.on('message', bytes => { const f = JSON.parse(bytes.toString()), p = pending.get(f.id); if (p) { pending.delete(f.id); p(f); } });
const rpc = (method, params) => new Promise((resolve, reject) => {
  const n = ++nextId, timer = setTimeout(() => reject(Error('Read-only native RPC timed out')), 10000);
  pending.set(n, frame => { clearTimeout(timer); frame.error ? reject(Error('Read-only native RPC rejected')) : resolve(frame.result); });
  socket.send(JSON.stringify({ id: n, method, params }));
});
try {
  await rpc('initialize', { clientInfo: { name: 'code-ai-image-recovery-readonly', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  if (!report.retryAttemptedAt && item.status === 'failed') {
    assert.equal(item.error, 'Shared native submission was refused before accepting input');
    assert.equal(item.nativeSubmission, null);
    const journal = JSON.parse(await fs.readFile('/home/developer/code-ai-native-owner/broker-journal.json', 'utf8'));
    const prior = journal.records.find(r => r.threadId === sessionId);
    assert.equal(prior.clientId, 'code-ai:' + id); assert.equal(prior.phase, 'released');
    assert.equal(prior.queuedId, null); assert.equal(prior.turnId, null); assert.equal(prior.turnComplete, true);
    const queue = await rpc('thread/queue/list', { threadId: sessionId, limit: 100 });
    assert.equal(queue.data.length, 0);
    const thread = (await rpc('thread/read', { threadId: sessionId, includeTurns: false })).thread;
    assert.equal(thread.status.type, 'idle');
    assert.equal((await fs.readFile(thread.path, 'utf8')).includes('code-ai:' + id), false);
    await fs.writeFile(ops + '/original-failure-private.json', JSON.stringify(item, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    report.originalInputWasNotAccepted = true;
    report.retryAttemptedAt = new Date().toISOString(); report.itemId = id; report.sessionId = sessionId; await save();
    ({ item } = await api('local', '/queue/items/' + id + '/retry', {}));
    assert.equal(item.id, id); // No alternate conversation or extra user message.
  }
  const deadline = Date.now() + 45000;
  while (!item.nativeSubmission?.turnId && !['failed', 'cancelled'].includes(item.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    ({ item } = await api('local', '/queue/items/' + id + '?includeSession=false'));
  }
  Object.assign(report, { status: item.status, error: item.error || null, nativeSubmission: item.nativeSubmission || null, checkedAt: new Date().toISOString() });
  if (item.nativeSubmission?.turnId) {
    const page = await rpc('thread/items/list', { threadId: sessionId, turnId: item.nativeSubmission.turnId, limit: 20, sortDirection: 'asc' });
    const users = page.data.map(row => row.item).filter(row => row.type === 'userMessage' && row.clientId === 'code-ai:' + id);
    assert.equal(users.length, 1);
    const content = JSON.stringify(users[0]);
    assert.match(content, /location-arrow\.svg/);
    assert.equal((users[0].content || []).some(c => ['localImage', 'image'].includes(c.type)), false);
    report.acceptedExactlyOnce = true; report.svgPreservedAsAttachedFile = true;
  }
  await save(); console.log(JSON.stringify(report));
} finally { socket.terminate(); }
