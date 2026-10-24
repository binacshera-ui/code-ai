/** Native desktop transport proof using installed program code and synthetic home only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function nativeTransportChild() {
  const [chunk, resourcesPath, cwd, threadId] = process.argv.slice(3);
  const imported = createRequire(import.meta.url)(chunk);
  assert.equal(typeof imported._, 'function', 'Native transport class missing');
  const transport = new imported._({
    hostConfig: { kind: 'local', id: 'local' }, repoRoot: cwd, resourcesPath,
    defaultOriginator: 'code_ai_synthetic_gui_launch',
    getConfigOverrides: async () => [
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
      'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true',
    ],
  });
  const connection = await transport.connect();
  const pending = new Map(); let next = 0;
  connection.onmessage = ({ data }) => {
    const frame = data?.message ?? (typeof data === 'string' ? JSON.parse(data) : data);
    const request = pending.get(frame?.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error('Native synthetic request failed'));
    else request.resolve(frame.result);
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject, timer: setTimeout(() => {
      pending.delete(id); reject(new Error('Native synthetic request timed out'));
    }, 8_000) });
    connection.send(JSON.stringify({ id, method, params }));
  });
  try {
    const initialized = await call('initialize', { clientInfo: { name: 'code-ai-native-gui-launch-contract', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    connection.send(JSON.stringify({ method: 'initialized', params: {} }));
    const resumed = await call('thread/resume', { threadId, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
    if (!process.send) throw new Error('Fixture coordination channel missing');
    process.send({ stage: 'synthetic-gui-thread-loaded' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture peer timed out')), 8_000);
      process.once('message', message => {
        clearTimeout(timer);
        if (message?.stage === 'synthetic-peer-resumed') resolve();
        else reject(new Error('Unexpected fixture stage'));
      });
    });
    console.log(JSON.stringify({ format: 'code-ai-native-gui-transport-child-proof',
      originalInstalledTransportUsed: true, guiTransportKind: transport.kind,
      homeMatches: initialized.codexHome === process.env.CODEX_HOME,
      sameSyntheticThread: resumed.thread.id === threadId, modelTurnsRequested: 0 }));
  } finally { connection.close(); }
}

async function sharedPeer(adapter, socket, cwd, env) {
  const child = spawn(process.execPath, [adapter, socket], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); let buffer = '', next = 0; const pending = new Map();
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture peer closed')); }
    pending.clear();
  };
  child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
  child.stdout.on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let frame; try { frame = JSON.parse(line); } catch { fail(); continue; }
      const request = pending.get(frame.id); if (!request) continue;
      clearTimeout(request.timer); pending.delete(frame.id);
      if (frame.error) request.reject(new Error('Fixture peer request failed')); else request.resolve(frame.result);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject, timer: setTimeout(() => {
      pending.delete(id); reject(new Error('Fixture peer request timed out'));
    }, 8_000) });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const initialized = await call('initialize', { clientInfo: { name: 'code-ai-native-gui-peer-contract', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  return { child, call, homeMatches: initialized.codexHome === env.CODEX_HOME };
}

function extractTransport(archive, destination) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12); assert.ok(length < 20_000_000);
    const header = Buffer.alloc(length); fs.readSync(fd, header, 0, length, 16);
    const tree = JSON.parse(header.toString()); const files = tree.files?.['.vite']?.files?.build?.files;
    const chunks = Object.entries(files ?? {}).filter(([name, e]) => /^application-network-startup-[A-Za-z0-9_-]+\.js$/.test(name) && !e.unpacked && !e.files);
    assert.equal(chunks.length, 1);
    let total = 0; const visited = new Set();
    const extract = name => {
      if (visited.has(name)) return;
      assert.ok(/^[A-Za-z0-9_-]+\.js$/.test(name)); const entry = files[name];
      assert.ok(entry && !entry.unpacked && !entry.files && entry.size < 12_000_000);
      total += entry.size; assert.ok(total < 30_000_000);
      const bytes = Buffer.alloc(entry.size); fs.readSync(fd, bytes, 0, bytes.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
      visited.add(name); fs.writeFileSync(path.join(destination, name), bytes, { mode: 0o600 });
      for (const match of bytes.toString().matchAll(/require\(["']\.\/([^"']+)["']\)/g)) extract(match[1]);
    };
    extract(chunks[0][0]);
    return { path: path.join(destination, chunks[0][0]), chunks: visited.size,
      sha256: createHash('sha256').update(fs.readFileSync(path.join(destination, chunks[0][0]))).digest('hex') };
  } finally { fs.closeSync(fd); }
}

async function fixtureMain() {
  const [native, archive, nodeModules] = process.argv.slice(2);
  for (const p of [native, archive, nodeModules]) assert.ok(p && path.isAbsolute(p), 'Explicit installed program paths required');
  assert.ok(archive.endsWith('/app.asar'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-native-launch-'));
  const home = path.join(root, 'codex'), cwd = path.join(root, 'workspace'), program = path.join(root, 'program');
  const id = randomUUID(), timestamp = new Date().toISOString();
  await mkdir(home); await mkdir(cwd); await mkdir(program);
  await mkdir(path.join(home, 'sessions/2026/10/10'), { recursive: true });
  await writeFile(path.join(home, 'config.toml'), 'approval_policy="never"\nsandbox_mode="read-only"\n');
  await writeFile(path.join(home, 'sessions/2026/10/10', `rollout-${id}.jsonl`), [
    { timestamp, type: 'session_meta', payload: { id, timestamp, cwd, originator: 'code_ai_synthetic_gui_launch', cli_version: '0.162.0', source: 'cli', model_provider: 'openai' } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic launch contract, no model work.' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const transport = extractTransport(archive, program);
  const scripts = path.join(root, 'scripts'); await mkdir(scripts);
  await copyFile(fileURLToPath(import.meta.url), path.join(scripts, 'codex-native-launch-contract.mjs'));
  for (const name of ['codex-shared-cli.mjs', 'codex-shared-stdio.mjs']) await copyFile(path.join(here, name), path.join(scripts, name));
  await symlink(nodeModules, path.join(root, 'node_modules'));
  const launcher = path.join(root, 'native-cli');
  await writeFile(launcher, `#!${process.execPath}\nawait import(${JSON.stringify(path.join(scripts, 'codex-shared-cli.mjs'))}).then(m=>m.dispatchNativeCli(process.argv.slice(2))).catch(()=>{process.stderr.write('CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\\n');process.exitCode=1});\n`, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CODEX|OPENAI|DISPLAY|WAYLAND|XDG/i.test(key)));
  Object.assign(env, { HOME: root, CODEX_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    CODEX_CLI_PATH: launcher, CODE_AI_CODEX_NATIVE_BIN: native,
    CODE_AI_CODEX_SHARED_STDIO: path.join(scripts, 'codex-shared-stdio.mjs') });
  // No real daemon is inspected or stopped. This process owns every child below.
  const owner = spawn(native, ['-c', 'features.code_mode_host=true',
    '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
    '-c', 'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true',
    'app-server', '--listen', 'unix://'], { cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  owner.stderr.resume(); const children = [];
  const socket = path.join(home, 'app-server-control/app-server-control.sock');
  try {
    const deadline = Date.now() + 10_000;
    while (!await stat(socket).then(s => s.isSocket(), () => false)) {
      if (owner.exitCode !== null || Date.now() > deadline) throw new Error('Synthetic owner unavailable');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const child = spawn(process.execPath, [path.join(scripts, 'codex-native-launch-contract.mjs'), '--native-class-child',
      transport.path, path.dirname(archive), cwd, id], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); let stdout = '', stderr = '';
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    const completion = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    let peer, peerResumeSucceeded = false;
    try {
      await Promise.race([
        once(child, 'message').then(([message]) => { assert.equal(message?.stage, 'synthetic-gui-thread-loaded'); }),
        completion.then(() => { throw new Error('Synthetic GUI closed before coordination'); }),
      ]);
      peer = await sharedPeer(path.join(scripts, 'codex-shared-stdio.mjs'), socket, cwd, env);
      children.push(peer.child);
      const resumed = await peer.call('thread/resume', { threadId: id, cwd, excludeTurns: true, approvalPolicy: 'never', sandbox: 'read-only' });
      peerResumeSucceeded = resumed.thread.id === id;
      child.send({ stage: 'synthetic-peer-resumed' });
    } catch { child.kill('SIGTERM'); }
    const [exitCode] = await completion; clearTimeout(timer);
    let peerContinuesAfterGuiClose = false;
    if (peer) {
      const readback = await peer.call('thread/read', { threadId: id, includeTurns: false });
      peerContinuesAfterGuiClose = readback.thread.id === id;
      peer.child.stdin.end();
    }
    const lines = stdout.trim().split('\n');
    const proofLine = lines.find(line => line.startsWith('{"format":"code-ai-native-gui-transport-child-proof"'));
    let proof; try { proof = JSON.parse(proofLine); } catch {}
    // No raw stderr/config/logs in a failure report. Stage and exit status suffice.
    const checks = { extractedActualInstalledTransport: transport.chunks > 1,
      fixtureProcessSucceeded: exitCode === 0, actualGuiClassReturnedSharedClient: Boolean(proof?.originalInstalledTransportUsed),
      nativeHomeMatches: proof?.homeMatches === true, sameSyntheticThread: proof?.sameSyntheticThread === true,
      guiIdleWhilePeerResumedSameThread: peerResumeSucceeded, peerHomeMatches: peer?.homeMatches === true,
      peerContinuesAfterGuiDisconnect: peerContinuesAfterGuiClose,
      ownerStillAliveAfterGuiDisconnect: owner.exitCode === null,
      fixtureRequestedNoModelTurns: proof?.modelTurnsRequested === 0 };
    console.log(JSON.stringify({ format: 'code-ai-native-gui-launch-contract', version: 1,
      installedTransportSha256: transport.sha256, extractedProgramChunks: transport.chunks,
      checks, passed: Object.values(checks).every(Boolean), guiTransportKind: proof?.guiTransportKind ?? null,
      failureMetadata: exitCode ? { exitCode, stderrPresent: Boolean(stderr), missingModule: /Cannot find module/.test(stderr),
        protocolTimeout: /timed out/.test(stderr), ownerConfigRefused: stderr.includes('CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE') } : null,
      installedEffects: false, liveGuiAttachProven: false, modelTurnsRequested: 0, realHistoriesRead: false, credentialsRead: false }));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (owner.pid) { try { process.kill(-owner.pid, 'SIGTERM'); } catch {} }
    await Promise.race([once(owner, 'close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2_000))]);
    if (owner.exitCode === null && owner.pid) { try { process.kill(-owner.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}

try {
  if (process.argv[2] === '--native-class-child') await nativeTransportChild();
  else await fixtureMain();
} catch {
  // Fixed fixture diagnostics only. Do not copy native logs into conversation history.
  process.stderr.write('CODE_AI_NATIVE_LAUNCH_CONTRACT_FAILED\n'); process.exitCode = 1;
}
