import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

const LOG_ROOT = CODEX_APP_CONFIG.logRoot;
const CLIENT_CRASH_LOG = path.join(LOG_ROOT, 'client-crashes.jsonl');
const SERVER_CRASH_LOG = path.join(LOG_ROOT, 'server-crashes.jsonl');
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

function resolveMaxLogBytes(): number {
  const configured = Number(process.env.CODEX_CRASH_LOG_MAX_BYTES || DEFAULT_MAX_LOG_BYTES);
  return Number.isSafeInteger(configured) && configured >= 1_024
    ? configured
    : DEFAULT_MAX_LOG_BYTES;
}

const MAX_LOG_BYTES = resolveMaxLogBytes();

let appendTail: Promise<void> = Promise.resolve();

async function ensureLogRoot() {
  await fs.mkdir(LOG_ROOT, { recursive: true });
}

async function rotateLogIfNeeded(filePath: string, nextLineBytes: number) {
  const fileSize = await fs.stat(filePath)
    .then((stats) => stats.size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
  if (fileSize + nextLineBytes <= MAX_LOG_BYTES) {
    return;
  }

  const rotatedPath = `${filePath}.1`;
  await fs.rm(rotatedPath, { force: true });
  await fs.rename(filePath, rotatedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function appendJsonLine(filePath: string, payload: Record<string, unknown>) {
  const line = `${JSON.stringify({
    loggedAt: new Date().toISOString(),
    ...payload,
  })}\n`;

  const appendOperation = appendTail.catch(() => undefined).then(async () => {
    await ensureLogRoot();
    await rotateLogIfNeeded(filePath, Buffer.byteLength(line));
    await fs.appendFile(filePath, line, 'utf-8');
  });
  appendTail = appendOperation;

  await appendOperation;
}

export async function recordCodexClientCrash(payload: Record<string, unknown>) {
  await appendJsonLine(CLIENT_CRASH_LOG, payload);
}

export async function recordCodexServerCrash(payload: Record<string, unknown>) {
  await appendJsonLine(SERVER_CRASH_LOG, payload);
}

export {
  CLIENT_CRASH_LOG,
  SERVER_CRASH_LOG,
};
