import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';

function readPositiveInteger(value, fallback, label) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function canConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    // A timeout means the existing service is overloaded, not that the port
    // is free. Waiting is safer than racing it and creating another worker.
    socket.setTimeout(750, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED') {
        finish(false);
        return;
      }
      reject(error);
    });
  });
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const host = process.env.HOST?.trim() || '127.0.0.1';
const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const port = readPositiveInteger(process.env.PORT, 4000, 'PORT');
const waitMs = readPositiveInteger(
  process.env.CODE_AI_PM2_PORT_WAIT_MS,
  1_000,
  'CODE_AI_PM2_PORT_WAIT_MS',
);
const configuredTarget = process.env.CODE_AI_PM2_TARGET_MODULE?.trim();
const runtimeStorageRoot = process.env.CODEX_STORAGE_ROOT?.trim() || path.resolve('.code-ai');
const activationFile = process.env.CODE_AI_PM2_ACTIVATION_FILE?.trim()
  || path.join(runtimeStorageRoot, 'local', 'runtime-activation.json');

// An already-running singleton can accept an in-owner repair without restarting
// its accepted work. This private pointer makes the matching immutable successor
// authoritative on the NEXT start too. A malformed/stale pointer fails closed.
// Operators recovering an in-owner SQLite migration can explicitly require this
// pointer; ordinary portable installs can start their SQLite-capable bundle.
async function resolveTargetModuleUrl() {
  let metadata;
  try { metadata = await lstat(activationFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (process.env.CODE_AI_PM2_REQUIRE_ACTIVATION === '1') {
      try {
        await lstat(path.join(process.env.CODEX_QUEUE_ROOT?.trim() || path.join(runtimeStorageRoot, 'queue'), 'queue.sqlite'));
        throw new Error('SQLite queue requires its private runtime activation pointer; refusing stale runtime fallback');
      } catch (queueError) {
        if (queueError.code !== 'ENOENT') throw queueError;
      }
    }
    return configuredTarget ? pathToFileURL(path.resolve(configuredTarget)).href
      : new URL('../dist/server.js', import.meta.url).href;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576
      || (metadata.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('Private Code AI runtime activation pointer is unsafe');
  }
  const activation = JSON.parse(await readFile(activationFile, 'utf8'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (activation?.format !== 'code-ai-pm2-runtime-activation' || activation.version !== 1
      || typeof activation.targetModule !== 'string' || !path.isAbsolute(activation.targetModule)
      || !validHash(activation.targetSha256) || !Array.isArray(activation.integrity)
      || activation.integrity.length > 2048) {
    throw new Error('Code AI runtime activation pointer is invalid');
  }
  const checked = new Set();
  for (const entry of [{ file: activation.targetModule, sha256: activation.targetSha256 }, ...activation.integrity]) {
    if (!entry || typeof entry.file !== 'string' || !path.isAbsolute(entry.file)
        || !validHash(entry.sha256) || checked.has(entry.file)) {
      throw new Error('Code AI runtime activation integrity closure is invalid');
    }
    checked.add(entry.file);
    const file = await lstat(entry.file);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o022) !== 0
        || await realpath(entry.file) !== entry.file
        || digest(await readFile(entry.file)) !== entry.sha256) {
      throw new Error('Code AI runtime activation integrity check failed');
    }
  }
  console.log('[code-ai-entrypoint] Using verified runtime activation pointer');
  return pathToFileURL(activation.targetModule).href;
}

let waiting = true;
const stopWhileWaiting = (signal) => {
  if (!waiting) return;
  console.log(`[code-ai-entrypoint] ${signal} received while waiting; exiting cleanly`);
  process.exit(0);
};
const signalHandlers = new Map([
  ['SIGINT', () => stopWhileWaiting('SIGINT')],
  ['SIGTERM', () => stopWhileWaiting('SIGTERM')],
]);
for (const [signal, handler] of signalHandlers) {
  process.once(signal, handler);
}

let reportedOccupiedPort = false;
while (await canConnect(probeHost, port)) {
  if (!reportedOccupiedPort) {
    console.log(
      `[code-ai-entrypoint] ${probeHost}:${port} is already serving; waiting without starting a duplicate`,
    );
    reportedOccupiedPort = true;
  }
  await delay(waitMs);
}

waiting = false;
for (const [signal, handler] of signalHandlers) {
  process.removeListener(signal, handler);
}
console.log(`[code-ai-entrypoint] ${probeHost}:${port} is available; starting code-ai`);
await import(await resolveTargetModuleUrl());
