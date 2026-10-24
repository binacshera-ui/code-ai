/** Refresh authoritative native settings events on the one idle imported thread. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
assert.equal(os.hostname(), 'gpu-lab'); assert.equal(process.getuid(), 1000);
const base = '/home/refael/.local/lib/code-ai/browser-shared-20261012-v1';
const ownerFile = '/home/refael/code-ai-native-owner/ownership.json';
const before = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
const threadId = '01a12ef6-be42-7962-bbe0-c99092522e96';
const W = createRequire('/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-large-frames-477ce0f0-4633-4871-a370-42778e15a465/package.json')('ws');
const ws = new W('ws+unix://' + before.frontendSocket + ':/', { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 5000 });
let next = 0; const pending = new Map(), observed = [];
ws.on('error', () => {});
ws.on('message', b => {
  const f = JSON.parse(b.toString());
  if (f.method === 'thread/settings/updated' && f.params?.threadId === threadId)
    observed.push({ effort: f.params.threadSettings?.effort, mode: f.params.threadSettings?.collaborationMode?.mode });
  const p = pending.get(f.id); if (p) { clearTimeout(p.timer); pending.delete(f.id); p.resolve(f); }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout')); }, 20000);
  pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const read = async () => {
  const f = await rpc('thread/resume', { threadId, excludeTurns: true });
  assert.ok(f.result, 'resume'); return f.result;
};
const semantic = x => Object.fromEntries(['model', 'reasoningEffort', 'modelProvider', 'cwd', 'approvalPolicy',
  'sandbox', 'activePermissionProfile', 'runtimeWorkspaceRoots', 'serviceTier', 'collaborationMode'].map(k => [k, x[k]]));
const result = { format: 'code-ai-ubuntu-thread-settings-refresh', version: 1, threadId, inputsSubmitted: false };
let original, changed = false;
try {
  await new Promise((y, x) => { ws.once('open', y); ws.once('error', x); });
  const init = await rpc('initialize', { clientInfo: { name: 'code-ai-thread-settings-repair', version: '1' }, capabilities: { experimentalApi: true } });
  assert.equal(init.result?.codeAiSharedOwner?.version, 1); ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  original = await read();
  assert.equal(original.thread.status.type, 'idle'); assert.equal(original.collaborationMode.mode, 'default');
  assert.equal(original.reasoningEffort, 'xhigh');
  const queue = await rpc('thread/queue/list', { threadId, limit: 100 }); assert.deepEqual(queue.result?.data, []);
  const journal = JSON.parse(await fs.readFile('/home/refael/code-ai-native-owner/broker-journal.json', 'utf8'));
  const record = journal.records.find(x => x.threadId === threadId);
  assert.equal(record?.phase, 'released'); assert.equal(record?.turnComplete, true); assert.equal(record?.turnId, null);
  changed = true;
  const first = await rpc('thread/settings/update', { threadId, effort: 'high' }); assert.ok(first.result, 'update');
  assert.equal((await read()).reasoningEffort, 'high');
  const restored = await rpc('thread/settings/update', { threadId, effort: original.reasoningEffort }); assert.ok(restored.result, 'restore');
  const final = await read(); assert.deepEqual(semantic(final), semantic(original)); changed = false;
  assert.ok(observed.some(x => x.effort === 'high' && x.mode === 'default'));
  assert.ok(observed.some(x => x.effort === 'xhigh' && x.mode === 'default'));
  const after = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  assert.equal(after.nativePid, before.nativePid); assert.equal(after.nativeIdentity.startTime, before.nativeIdentity.startTime);
  result.success = true; result.settingsRestoredExactly = true; result.nativeModeEvents = observed;
  result.ownerGenerationPreserved = true;
} catch (e) {
  if (changed && original) {
    await rpc('thread/settings/update', { threadId, effort: original.reasoningEffort });
    result.settingsRestoredExactly = JSON.stringify(semantic(await read())) === JSON.stringify(semantic(original));
  }
  result.success = false; result.errorCode = e.code || e.name; process.exitCode = 1;
} finally {
  ws.terminate(); for (const p of pending.values()) clearTimeout(p.timer);
  result.observedAt = new Date().toISOString();
  await fs.writeFile(base + '/settings-refresh.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
