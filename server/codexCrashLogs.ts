import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG } from './config.js';

const LOG_ROOT = CODEX_APP_CONFIG.logRoot;
const CLIENT_CRASH_LOG = path.join(LOG_ROOT, 'client-crashes.jsonl');
const SERVER_CRASH_LOG = path.join(LOG_ROOT, 'server-crashes.jsonl');

let appendTail: Promise<void> = Promise.resolve();

async function ensureLogRoot() {
  await fs.mkdir(LOG_ROOT, { recursive: true });
}

async function appendJsonLine(filePath: string, payload: Record<string, unknown>) {
  const line = `${JSON.stringify({
    loggedAt: new Date().toISOString(),
    ...payload,
  })}\n`;

  appendTail = appendTail.then(async () => {
    await ensureLogRoot();
    await fs.appendFile(filePath, line, 'utf-8');
  });

  await appendTail;
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
