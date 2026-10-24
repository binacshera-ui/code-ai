#!/usr/bin/env node
/**
 * Native GUI/IDE CLI override. Server stdio is a client of the existing owner;
 * this dispatcher never starts an owner, removes locks, or reads credentials.
 */
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const fixedError = 'CODE_AI_NATIVE_SHARED_LAUNCH_UNAVAILABLE\n';
const booleanKeys = new Set([
  'features.code_mode_host',
  'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled',
  'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled',
]);
const globalValueOptions = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model',
  '-p', '--profile', '-C', '--cd', '--add-dir', '-s', '--sandbox', '-a', '--ask-for-approval',
  '-i', '--image', '--local-provider']);
const globalBooleanOptions = new Set(['--oss', '--search', '--full-auto', '--no-alt-screen',
  '--dangerously-bypass-approvals-and-sandbox']);

export function parseAppServerArguments(args) {
  // The first command token decides the transport. A later prompt/file argument
  // spelled "app-server" is not a command and must reach the original CLI.
  let serverIndex = 0;
  while (args[serverIndex]?.startsWith('-')) {
    const option = args[serverIndex];
    if (globalValueOptions.has(option)) serverIndex += 2;
    else if (globalBooleanOptions.has(option) || option.includes('=')) serverIndex++;
    else return null;
  }
  if (args[serverIndex] !== 'app-server') return null;
  if (['generate-ts', 'generate-json-schema'].includes(args[serverIndex + 1])
      || (args[serverIndex + 1] === 'daemon' && args[serverIndex + 2] === 'version')) return null;
  const overrides = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (i === serverIndex || arg === '--analytics-default-enabled') continue;
    if (arg === '--listen') {
      if (args[++i] !== 'stdio://') throw new Error('Unsupported transport');
      continue;
    }
    if (arg === '--listen=stdio://') continue;
    if (arg !== '-c' && arg !== '--config') throw new Error('Unsupported server argument');
    const value = args[++i];
    const match = typeof value === 'string' && /^([^=]+)=(true|false)$/.exec(value);
    if (!match || !booleanKeys.has(match[1]) || overrides.has(match[1])) throw new Error('Unsupported configuration');
    overrides.set(match[1], match[2] === 'true');
  }
  return { overrides };
}

export function configMatchesOverrides(config, overrides) {
  if (!config || typeof config !== 'object') return false;
  for (const [key, expected] of overrides) {
    let value = config;
    for (const segment of key.split('.')) value = value?.[segment];
    if (value !== expected) return false;
  }
  return true;
}

async function privateEndpoint(socketPath, home) {
  const expectedHome = await realpath(home);
  const socket = await lstat(socketPath);
  const parent = await lstat(path.dirname(socketPath));
  const actualPath = await realpath(socketPath);
  const actualSocket = await lstat(actualPath);
  const actualParent = await lstat(path.dirname(actualPath));
  const uid = process.getuid();
  if ((!socket.isSocket() && !socket.isSymbolicLink()) || !actualSocket.isSocket()
      || [socket, parent, actualSocket, actualParent].some(s => s.uid !== uid)
      || (parent.mode & 0o077) !== 0 || (actualParent.mode & 0o077) !== 0) throw new Error('Unsupported endpoint');
  return expectedHome;
}

async function compareOwnerConfiguration(socketPath, home, overrides) {
  const expectedHome = await privateEndpoint(socketPath, home);
  const ws = new WebSocket(`ws+unix://${socketPath}:/`, {
    maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5_000, perMessageDeflate: false,
  });
  let next = 0;
  const pending = new Map();
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Owner unavailable')); }
    pending.clear();
  };
  ws.on('error', fail); ws.on('close', fail);
  ws.on('message', (bytes, binary) => {
    if (binary) { ws.terminate(); return; }
    let frame;
    try { frame = JSON.parse(bytes.toString()); } catch { ws.terminate(); return; }
    const request = pending.get(frame?.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error('Owner request rejected'));
    else request.resolve(frame.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject, timer: setTimeout(() => {
      pending.delete(id); reject(new Error('Owner request timed out'));
    }, 5_000) });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', () => reject(new Error('Owner unavailable')));
    });
    const initialized = await call('initialize', {
      clientInfo: { name: 'code-ai-native-launch-preflight', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    if (typeof initialized?.codexHome !== 'string'
        || await realpath(initialized.codexHome).catch(() => null) !== expectedHome) throw new Error('Owner identity mismatch');
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const result = await call('config/read', { includeLayers: false });
    // Compare only supported booleans in memory. Never emit the config body.
    if (!configMatchesOverrides(result?.config, overrides)) throw new Error('Owner configuration mismatch');
  } finally { ws.terminate(); }
}

async function childCommand(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Command unavailable')));
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 128 : 1); resolve();
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

export async function dispatchNativeCli(args, env = process.env) {
  const nativePath = env.CODE_AI_CODEX_NATIVE_BIN;
  if (!nativePath || !path.isAbsolute(nativePath)) throw new Error('Native binary required');
  if (await realpath(nativePath) === await realpath(fileURLToPath(import.meta.url))) throw new Error('Recursive dispatcher');
  const server = parseAppServerArguments(args);
  if (!server) return childCommand(nativePath, args, env);
  const home = env.CODEX_HOME || (env.HOME ? path.join(env.HOME, '.codex') : null);
  const socket = env.CODE_AI_CODEX_SHARED_SOCKET || (home ? path.join(home, 'app-server-control/app-server-control.sock') : null);
  const adapter = env.CODE_AI_CODEX_SHARED_STDIO || fileURLToPath(new URL('./codex-shared-stdio.mjs', import.meta.url));
  if (process.platform === 'win32' || !home || !socket || !path.isAbsolute(home)
      || !path.isAbsolute(socket) || socket.includes(':') || !path.isAbsolute(adapter)) throw new Error('Unsupported launch');
  await compareOwnerConfiguration(socket, home, server.overrides);
  return childCommand(process.execPath, [adapter, socket], { ...env, CODEX_HOME: home });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dispatchNativeCli(process.argv.slice(2)).catch(() => {
    process.stderr.write(fixedError);
    process.exitCode = 1;
  });
}
