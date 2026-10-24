/** Apply the qualified official-host registry change and retire its idle extra writer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
assert.equal(os.hostname(), 'gpu-lab'); assert.equal(process.getuid(), 1000);
const base = '/home/refael/.local/lib/code-ai/browser-shared-20261012-v1';
const receipt = JSON.parse(await fs.readFile(base + '/qualification.json', 'utf8'));
assert.equal(receipt.passed, true); assert.equal(receipt.sharedOwnerVerified, true);
const registry = '/home/refael/.local/state/openai-codex/chrome-native-hosts-v2.json';
const current = await fs.readFile(registry, 'utf8'), candidate = JSON.parse(current);
const qualified = JSON.parse(await fs.readFile(receipt.fixture + '/openai-codex/chrome-native-hosts-v2.json', 'utf8'));
assert.equal(candidate.entries.length, 1);
assert.equal(candidate.entries[0].paths.codexCliPath, '/home/refael/.codex/plugins/.plugin-appserver/codex');
candidate.entries[0].paths.codexCliPath = receipt.cli;
assert.deepEqual(candidate, qualified);
const ownerFile = '/home/refael/code-ai-native-owner/ownership.json';
const before = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
assert.equal(before.nativePid, receipt.nativePid);
const hostPid = 15852, pluginPid = 391486;
const threadId = '01a12ef6-be42-7962-bbe0-c99092522e96';
const failedId = 'c698a65d-da8e-4d22-8a1c-2623b0533588';
const rollout = '/home/refael/.codex/sessions/2026/10/12/rollout-2026-10-12T10-14-44-' + threadId + '.jsonl';
async function identity(pid) {
  const raw = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
  return { pid, exe: await fs.readlink('/proc/' + pid + '/exe'), start: raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] };
}
const host = await identity(hostPid), plugin = await identity(pluginPid);
assert.ok(host.exe.endsWith('/extension-host/linux/x64/extension-host'));
assert.equal(plugin.exe, '/home/refael/.codex/plugins/.plugin-appserver/codex');
const status = await fs.readFile('/proc/' + pluginPid + '/status', 'utf8');
assert.equal(Number(/^PPid:\s+(\d+)/m.exec(status)[1]), hostPid);
async function assertIdlePlugin() {
  assert.deepEqual(await identity(pluginPid), plugin);
  const held = [];
  for (const f of await fs.readdir('/proc/' + pluginPid + '/fd')) {
    const link = await fs.readlink('/proc/' + pluginPid + '/fd/' + f).catch(() => null);
    if (link?.includes('/thread-writer-locks/') && link.endsWith('.lock')) held.push(link);
  }
  assert.deepEqual(held, ['/home/refael/.codex/thread-writer-locks/' + threadId + '.lock']);
  const raw = await fs.readFile(rollout, 'utf8'); let active = false, finished = false;
  for (const line of raw.trim().split('\n')) {
    const row = JSON.parse(line);
    if (row.type !== 'event_msg') continue;
    if (row.payload?.type === 'task_started') { active = true; finished = false; }
    if (['task_complete', 'turn_aborted'].includes(row.payload?.type)) { active = false; finished = true; }
  }
  assert.equal(active, false, 'Plugin still executing'); assert.equal(finished, true);
  return raw;
}
const history = await assertIdlePlugin();
const recovery = base + '/recovery'; await fs.mkdir(recovery, { mode: 0o700 });
await fs.writeFile(recovery + '/chrome-native-hosts-v2.before.json', current, { mode: 0o600, flag: 'wx' });
await fs.writeFile(recovery + '/conversation-before.jsonl', history, { mode: 0o600, flag: 'wx' });
const queue = JSON.parse(await fs.readFile('/home/refael/.code-ai-remote/ubuntu-gpu-lab/queue/state.json', 'utf8'));
const failed = queue.items.find(x => x.id === failedId);
assert.equal(failed?.status, 'failed'); assert.equal(failed?.sessionId, threadId); assert.equal(failed?.nativeSubmission, undefined);
await fs.writeFile(recovery + '/failed-item-before.json', JSON.stringify(failed), { mode: 0o600, flag: 'wx' });
const digest = x => createHash('sha256').update(x).digest('hex');
const result = { format: 'code-ai-ubuntu-browser-shared-owner-repair', version: 1, threadId, failedId,
  recovery, changedFields: ['entries[0].paths.codexCliPath'], historyBeforeSha256: digest(history),
  previousHostPid: hostPid, previousPluginPid: pluginPid, sharedNativePid: before.nativePid,
  lockFilesRemoved: false, nativeHistoryDeleted: false, credentialsChanged: false, inputsSubmitted: false };
let installed = false;
try {
  assert.equal(await fs.readFile(registry, 'utf8'), current);
  const staging = registry + '.code-ai-owner-candidate';
  await fs.writeFile(staging, JSON.stringify(candidate, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(staging, registry); installed = true;
  // Freeze only this transport's ingress while checking its exact writer is idle.
  assert.deepEqual(await identity(hostPid), host); process.kill(hostPid, 'SIGSTOP');
  try {
    assert.equal(await assertIdlePlugin(), history, 'History advanced during activation');
    process.kill(hostPid, 'SIGTERM');
  } finally { try { process.kill(hostPid, 'SIGCONT'); } catch {} }
  const alive = async record => { try { return JSON.stringify(await identity(record.pid)) === JSON.stringify(record); } catch { return false; } };
  const sleep = ms => new Promise(y => setTimeout(y, ms));
  for (let i = 0; i < 20 && await alive(host); i++) await sleep(100);
  assert.equal(await alive(host), false, 'Original host still running');
  if (await alive(plugin)) { await assertIdlePlugin(); process.kill(pluginPid, 'SIGTERM'); }
  for (let i = 0; i < 40 && await alive(plugin); i++) await sleep(100);
  assert.equal(await alive(plugin), false, 'Original plugin writer still running');
  result.idlePluginWriterClosed = true;
  const W = createRequire('/home/refael/.code-ai/remote-agent/ubuntu-gpu-lab/releases/native-large-frames-477ce0f0-4633-4871-a370-42778e15a465/package.json')('ws');
  const ws = new W('ws+unix://' + before.frontendSocket + ':/', { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
  let next = 0; const pending = new Map(); ws.on('error', () => {});
  ws.on('message', b => { const f = JSON.parse(b.toString()), p = pending.get(f.id); if (p) { clearTimeout(p.timer); pending.delete(f.id); p.resolve(f); } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout')); }, 20000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((y, x) => { ws.once('open', y); ws.once('error', x); });
    const init = await rpc('initialize', { clientInfo: { name: 'code-ai-browser-owner-activation', version: '1' }, capabilities: { experimentalApi: true } });
    assert.equal(init.result?.codeAiSharedOwner?.version, 1); ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const resumed = await rpc('thread/resume', { threadId, excludeTurns: true });
    result.resumeErrorCode = resumed.error?.code ?? null;
    assert.equal(resumed.result?.thread?.id, threadId);
    result.sameConversationResumed = true;
  } finally { ws.terminate(); for (const p of pending.values()) clearTimeout(p.timer); }
  const after = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  assert.equal(after.nativePid, before.nativePid); assert.equal(after.nativeIdentity.startTime, before.nativeIdentity.startTime);
  result.ownerGenerationPreserved = true;
  const afterHistory = await fs.readFile(rollout, 'utf8');
  assert.ok(afterHistory.startsWith(history)); result.originalHistoryPrefixPreserved = true;
  result.activated = true;
} catch (error) {
  if (installed) { const f = registry + '.code-ai-rollback'; await fs.writeFile(f, current, { mode: 0o600 }); await fs.rename(f, registry); }
  result.activated = false; result.registryRolledBack = installed; result.failure = error.code || error.name; process.exitCode = 1;
}
result.observedAt = new Date().toISOString();
await fs.writeFile(base + '/activation.json', JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
