/** Ubuntu browser-owner diagnosis through existing processes; never sends input. */
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
if (os.hostname() !== 'gpu-lab' || process.getuid() !== 1000) throw Error('Wrong host');
const home = '/home/refael/.codex';
const ownerFile = '/home/refael/code-ai-native-owner/ownership.json';
const before = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
const threadId = '01a12ef6-be42-7962-bbe0-c99092522e96';
const cwd = '/home/refael/Documents/Codex/2026-10-12/t-v';
const root = execFileSync('systemctl', ['--user', 'show', 'code-ai-ubuntu-agent.service', '-p', 'WorkingDirectory', '--value'], { encoding: 'utf8' }).trim();
const W = createRequire(root + '/package.json')('ws');
const rows = [];
const classify = text => Object.fromEntries([
  'workspace requirements', 'invalid type', 'expected u32', 'never', 'sandbox_mode',
  'approval_policy', 'config.toml', 'Permission denied', 'No such file', 'not found',
  'thread', 'resume', 'model', 'context', 'token', 'logged out', 'unauthorized',
  'deserialize', 'unknown field', 'unsupported', 'loaded', 'rollout', 'persist',
  'already', 'lock', 'image', 'base64', 'utf', 'unexpected', 'timed out', 'busy',
].filter(x => text.toLowerCase().includes(x.toLowerCase())).map(x => [x, true]));
for (const [kind, socket] of [['broker', before.frontendSocket], ['native-read-only', before.backendSocket]]) {
  if (!socket.startsWith('/home/refael/')) throw Error('Unexpected socket');
  const ws = new W('ws+unix://' + socket + ':/', { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 5000 });
  let n = 0;
  const pending = new Map();
  ws.on('error', () => {});
  ws.on('message', b => { let f; try { f = JSON.parse(b.toString()); } catch { return; }
    const p = pending.get(f.id); if (!p) return;
    pending.delete(f.id); clearTimeout(p.timer); p.resolve(f);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++n, timer = setTimeout(() => { pending.delete(id); reject(Error('Read-only RPC timeout')); }, 20000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); });
    const init = await rpc('initialize', { clientInfo: { name: 'code-ai-ubuntu-error-readback', version: '1' }, capabilities: { experimentalApi: true } });
    if (init.result?.codexHome !== home) throw Error('Wrong Codex home');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const calls = [['configRequirements/read', null], ['config/read', { includeLayers: false, cwd }],
      ['account/read', { refreshToken: false }], ['thread/read', { threadId, includeTurns: false }],
      ['thread/turns/list', { threadId, limit: 3, itemsView: 'notLoaded', sortDirection: 'desc' }],
      ['thread/queue/list', { threadId, limit: 100 }],
      ['thread/resume', { threadId, cwd, excludeTurns: true }]];
    for (const [method, params] of calls) {
      const f = await rpc(method, params), e = f.error?.message || '';
      const row = { kind, method, ok: Object.hasOwn(f, 'result'), errorCode: f.error?.code ?? null,
        errorIndicators: classify(e), errorLength: e.length };
      // Report names and locations only, never values from arbitrary error text.
      if (e) row.errorLines = e.split('\n').map((s, i) => ({ line: i, indicators: classify(s) })).filter(x => Object.keys(x.indicators).length);
      if (method === 'account/read') row.accountType = f.result?.account?.type;
      if (method === 'config/read') row.model = f.result?.config?.model;
      if (method === 'thread/read' || method === 'thread/resume') row.thread = {
        id: f.result?.thread?.id, status: f.result?.thread?.status,
        cwd: f.result?.thread?.cwd, path: f.result?.thread?.path, model: f.result?.model,
      };
      if (method === 'thread/turns/list') row.turns = f.result?.data?.map(x => ({ id: x.id, status: x.status, errorPresent: !!x.error }));
      if (method === 'thread/queue/list') row.count = f.result?.data?.length;
      rows.push(row);
    }
  } finally { ws.terminate(); for (const p of pending.values()) clearTimeout(p.timer); }
}
const after = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
console.log(JSON.stringify({ observedAt: new Date().toISOString(), host: os.hostname(), root,
  nativePid: after.nativePid, nativeGenerationPreserved: before.nativePid === after.nativePid && before.nativeIdentity.startTime === after.nativeIdentity.startTime,
  inputSubmitted: false, rows }));
