/** Read-only BEAM census. Never sends input, starts an owner, or reads auth files. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (os.hostname() !== 'beam-10g') throw Error('Wrong host; inspection refused');
const unit = 'code-ai-remote-beam-10g.service';
const raw = execFileSync('systemctl', ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'WorkingDirectory', '-p', 'EnvironmentFiles'], { encoding: 'utf8' });
const service = Object.fromEntries(raw.trim().split('\n').map(x => x.split(/=(.*)/s).slice(0, 2)));
const pid = Number(service.MainPID);
if (!Number.isSafeInteger(pid) || pid < 1) throw Error('No live sidecar');
const permitted = new Set(['CODEX_APP_ROOT', 'CODEX_STORAGE_ROOT', 'CODEX_SHARED_PROFILE_IDS', 'CODEX_BIN', 'CODE_AI_CODEX_NATIVE_BIN']);
const environment = Object.fromEntries((await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').flatMap(x => {
  const i = x.indexOf('='); const key = x.slice(0, i);
  return permitted.has(key) ? [[key, x.slice(i + 1)]] : [];
}));
const command = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
const liveModule = command.find(x => path.isAbsolute(x) && /\.(?:mjs|js)$/.test(x));
const runtimeRoot = service.WorkingDirectory;
// dotenv writes are not necessarily reflected in /proc/PID/environ.
// Read only allowlisted non-secret path fields from the exact unit/runtime files.
const wrapper = liveModule ? await fs.readFile(liveModule, 'utf8') : '';
const envFiles = [...new Set([
  path.join(runtimeRoot, '.remote-agent.env'),
  '/opt/code-ai/.remote-agent.env',
  ...[...wrapper.matchAll(/["']([^"'\n]*\.env)["']/g)].map(m => m[1]).filter(x => path.isAbsolute(x) && /^[A-Za-z0-9_.\/-]+$/.test(x)),
  ...(service.EnvironmentFiles || '').split(' ').filter(x => path.isAbsolute(x) && /^[A-Za-z0-9_.\/-]+$/.test(x)),
])];
const environmentSources = [];
for (const file of envFiles) {
  const content = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (content === null) continue;
  const fields = Object.fromEntries(content.split('\n').flatMap(x => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(x); if (!m || !permitted.has(m[1])) return [];
    let v = m[2].trim(); if (/^['"]/.test(v)) v = v.slice(1, -1);
    return [[m[1], v]];
  }));
  environmentSources.push({ file, fields });
}
const programNames = ['codex-shared-modes/mcp.mjs', 'personal-chrome/personal_chrome_mcp_server.mjs', 'browser-mode/python/browser_mode_mcp_server.py', 'phone-mode/phone_mode_mcp_server.mjs', 'design-mode/design_mode_mcp_server.mjs', 'ux-mode/ux_mode_mcp_server.mjs', 'codexSharedAccountAuth.mjs', 'codexRuntimePrograms.mjs'];
const roots = [...new Set([environment.CODEX_APP_ROOT, ...environmentSources.map(x => x.fields.CODEX_APP_ROOT), runtimeRoot, liveModule && path.dirname(path.dirname(liveModule))].filter(Boolean))];
const programs = [];
for (const root of roots) for (const relative of programNames) {
  const places = await Promise.all(['server', 'dist'].map(async d => {
    const p = path.join(root, d, relative);
    return { location: p, present: await fs.stat(p).then(s => s.isFile()).catch(() => false) };
  }));
  programs.push({ root, program: relative, places });
}
const W = createRequire(path.join(runtimeRoot, 'package.json'))('ws');
const owners = [];
for (const [profile, home] of [['beam-root', '/root/.codex'], ['beam-admin', '/home/beamadmin/.codex']]) {
  const ownerPath = path.join(path.dirname(home), 'code-ai-native-owner', 'ownership.json');
  const before = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  if (before.codexHome !== home) throw Error('Owner identity mismatch');
  const ws = new W(`ws+unix://${home}/code-ai-shared-owner/owner.sock:/`, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
  let n = 0; const pending = new Map(); ws.on('error', () => {});
  ws.on('message', b => { let f; try { f = JSON.parse(b.toString()); } catch { return; }
    const p = pending.get(f.id); if (p) { pending.delete(f.id); clearTimeout(p.timer); p.resolve(f); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++n; const timer = setTimeout(() => { pending.delete(id); reject(Error('Read-only RPC timeout')); }, 10000);
    pending.set(id, { resolve, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const checks = [];
  try {
    await new Promise((y, x) => { ws.once('open', y); ws.once('error', x); });
    const init = await rpc('initialize', { clientInfo: { name: 'code-ai-beam-read-only-census', version: '1' }, capabilities: { experimentalApi: true } });
    if (init.result?.codexHome !== home || init.result?.codeAiSharedOwner?.version !== 1) throw Error('Canonical broker required');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const calls = [['configRequirements/read', null], ['config/read', { includeLayers: false, cwd: '/home/beamadmin' }], ['account/read', { refreshToken: false }], ['thread/loaded/list', {}]];
    if (profile === 'beam-admin') calls.push(
      ['thread/read', { threadId: '01a12cf1-70f9-75c1-978a-ca49cd084253', includeTurns: false }],
      ['thread/turns/list', { threadId: '01a12cf1-70f9-75c1-978a-ca49cd084253', limit: 3, itemsView: 'notLoaded', sortDirection: 'desc' }],
      ['thread/queue/list', { threadId: '01a12cf1-70f9-75c1-978a-ca49cd084253', limit: 100 }],
      ['thread/list', { parentThreadId: '01a12cf1-70f9-75c1-978a-ca49cd084253', limit: 20, useStateDbOnly: true }]
    );
    for (const [method, params] of calls) {
      const f = await rpc(method, params), e = f.error?.message || '';
      const row = { method, ok: Object.hasOwn(f, 'result'), errorCode: f.error?.code || null, errorClass: /workspace requirements/i.test(e) ? 'workspace-requirements' : /token.*refresh|logged out/i.test(e) ? 'auth-refresh' : e ? 'other' : null };
      if (method === 'account/read') {
        row.accountType = f.result?.account?.type;
        row.accountPresent = !!f.result?.account;
        row.requiresOpenaiAuth = f.result?.requiresOpenaiAuth;
        row.authFilePresent = await fs.stat(path.join(home, 'auth.json')).then(s => s.isFile()).catch(() => false);
      }
      if (method === 'thread/read') row.thread = { id: f.result?.thread?.id, status: f.result?.thread?.status?.type, activeFlags: f.result?.thread?.status?.activeFlags, path: f.result?.thread?.path };
      if (method === 'thread/turns/list') row.turns = f.result?.data?.map(t => ({ id: t.id, status: t.status, errorPresent: !!t.error }));
      if (['thread/queue/list', 'thread/list', 'thread/loaded/list'].includes(method)) row.entries = f.result?.data?.length;
      if (method === 'thread/list') { row.threadIds = f.result?.data?.map(t => t.id); row.hasMore = !!f.result?.nextCursor; }
      checks.push(row);
    }
    const after = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    if (after.nativePid !== before.nativePid || after.nativeIdentity.startTime !== before.nativeIdentity.startTime) throw Error('Owner changed during census');
    owners.push({ profile, nativePid: before.nativePid, runnerPid: before.runnerPid, nativeBinarySha256: before.nativeBinarySha256, brokerModuleSha256: before.brokerModuleSha256, ownerPreserved: true, checks });
  } finally { ws.terminate(); for (const p of pending.values()) clearTimeout(p.timer); }
}
console.log(JSON.stringify({ format: 'code-ai-beam-read-only-census', observedAt: new Date().toISOString(), hostname: os.hostname(), service, liveModule, environment, environmentSources, programs, owners, installedEffects: false }));
