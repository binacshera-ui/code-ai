/** Actual native startup flags, isolated home, no inference/accounts/history. */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { nativeOwnerArguments } from '../ops/native-owner/profile-artifacts.mjs';

let root, owner, ws;
try {
  const [bin, expectedSha] = process.argv.slice(2);
  if (!bin || !path.isAbsolute(bin) || !/^[a-f0-9]{64}$/.test(expectedSha || '')) throw new Error('Explicit pinned native program required');
  if (createHash('sha256').update(await readFile(bin)).digest('hex') !== expectedSha) throw new Error('Native program identity mismatch');
  root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-native-baseline-'));
  // Qualification workspaces may be nested; keep the native Unix address below
  // the platform's 108-byte sockaddr_un limit without changing product paths.
  const home = path.join(root, 'h'), ownerDirectory = path.join(root, 'o');
  await mkdir(home, { mode: 0o700 });
  await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  const plan = { format: 'code-ai-native-owner-profile', version: 1, profileId: 'baseline-fixture',
    userHome: root, codexHome: home, ownerDirectory, nativeBinary: bin, nativeBinarySha256: expectedSha,
    nodeBinary: process.execPath, brokerModule: path.join(root, 'not-invoked-broker.mjs'), brokerModuleSha256: '0'.repeat(64),
    dispatcherModule: path.join(root, 'not-invoked-dispatcher.mjs'), adapterModule: path.join(root, 'not-invoked-adapter.mjs'),
    runnerModule: path.join(root, 'not-invoked-runner.mjs'), guiLauncherModule: path.join(root, 'not-invoked-launcher.mjs'),
    frontendSocket: path.join(home, 'code-ai-shared-owner', 'owner.sock'), desktopExecutable: bin,
    guiBooleanRequirements: { 'features.code_mode_host': true,
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': true,
      'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled': true } };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI/i.test(key)));
  Object.assign(env, { HOME: root, CODEX_HOME: home });
  const versionResult = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  const nativeVersion = /^codex-cli ([0-9A-Za-z.+-]+)\s*$/m.exec(versionResult.stdout || '')?.[1] || null;
  owner = spawn(bin, nativeOwnerArguments(plan), { env, cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  owner.stderr.resume(); owner.on('error', () => {});
  const socketPath = path.join(ownerDirectory, 'engine.sock'), deadline = Date.now() + 10000;
  while (!await stat(socketPath).then(info => info.isSocket(), () => false)) {
    if (owner.exitCode !== null || Date.now() > deadline) throw new Error('Native flags unavailable');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  ws = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(new Error('Fixture unavailable'))); });
  const pending = new Map(); let next = 0;
  ws.on('message', bytes => { let frame; try { frame = JSON.parse(bytes.toString()); } catch { return; }
    const item = pending.get(frame.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(frame.id);
    frame.error ? item.reject(new Error('Native fixture request refused')) : item.resolve(frame.result); });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++next;
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('Native fixture timeout')); }, 5000) });
    ws.send(JSON.stringify({ id, method, params })); });
  const initialize = await call('initialize', { clientInfo: { name: 'code-ai-baseline-contract', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  const config = (await call('config/read', { includeLayers: false })).config;
  const checks = { pinnedProgramMatches: true, nativeVersionDetected: versionResult.status === 0 && !!nativeVersion,
    isolatedOwnerInitialized: initialize.codexHome === home,
    remoteCompactionEnabled: config?.features?.remote_compaction_v2 === true,
    defaultModeUserInputEnabled: config?.features?.default_mode_request_user_input === true,
    mcpCredentialStoreFile: config?.mcp_oauth_credentials_store === 'file',
    codeModeHostRetained: config?.features?.code_mode_host === true,
    guiAppPluginRetained: config?.plugins?.['codex-app-tools@openai-bundled']?.mcp_servers?.codex_app?.enabled === true,
    guiReviewPluginRetained: config?.plugins?.['code-review@openai-bundled']?.mcp_servers?.['code-review']?.enabled === true };
  console.log(JSON.stringify({ format: 'code-ai-native-baseline-contract', version: 1,
    nativeVersion, nativeBinarySha256: expectedSha, checks, passed: Object.values(checks).every(Boolean),
    installedEffects: false, modelTurnsRequested: 0, realHistoriesRead: false, credentialsRead: false }));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch {
  process.stderr.write('CODE_AI_NATIVE_BASELINE_CONTRACT_UNAVAILABLE\n'); process.exitCode = 1;
} finally {
  ws?.terminate();
  if (owner?.pid) {
    try { process.kill(-owner.pid, 'SIGTERM'); } catch { /* Only this isolated process group. */ }
    await new Promise(resolve => {
      if (owner.exitCode !== null || owner.signalCode !== null) return resolve();
      const timer = setTimeout(() => { try { process.kill(-owner.pid, 'SIGKILL'); } catch {} resolve(); }, 2000);
      owner.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (root) await rm(root, { recursive: true, force: true });
}
