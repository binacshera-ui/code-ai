import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const targetModuleUrl = configuredTarget
  ? pathToFileURL(path.resolve(configuredTarget)).href
  : new URL('../dist/server.js', import.meta.url).href;

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
await import(targetModuleUrl);
