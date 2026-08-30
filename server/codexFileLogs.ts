import path from 'path';
import { promises as fs } from 'fs';
import { CODEX_APP_CONFIG } from './config.js';

const FILE_LOG_ROOT = CODEX_APP_CONFIG.logRoot;
const FILE_LOG_PATH = path.join(FILE_LOG_ROOT, 'file-access.jsonl');

export interface CodexFileLogEntry {
  type: string;
  rawTarget?: string;
  resolvedPath?: string | null;
  status?: number;
  message?: string;
  matches?: string[];
  mimeType?: string | false;
  previewKind?: string;
  size?: number;
  lineNumber?: number | null;
  authUserId?: string | null;
  remoteIp?: string | null;
  profileId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function appendCodexFileLog(entry: CodexFileLogEntry) {
  await fs.mkdir(FILE_LOG_ROOT, { recursive: true });
  const payload = {
    ...entry,
    recordedAt: new Date().toISOString(),
  };
  await fs.appendFile(FILE_LOG_PATH, `${JSON.stringify(payload)}\n`, 'utf-8');
}

export async function readRecentCodexFileLogs(limit = 50) {
  try {
    const raw = await fs.readFile(FILE_LOG_PATH, 'utf-8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 500)));

    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .reverse();
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export { FILE_LOG_PATH as CODEX_FILE_LOG_PATH };
