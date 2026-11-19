import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const installationRecord = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'code-ai', 'codex-gemini.json');
export const defaultRuntime = path.join(os.homedir(), '.local/share/code-ai/codex-gemini');

export async function resolveRuntime() {
  if (process.env.CODE_AI_GEMINI_RUNTIME) return path.resolve(process.env.CODE_AI_GEMINI_RUNTIME);
  try {
    const record = JSON.parse(await readFile(installationRecord, 'utf8'));
    if (typeof record.runtimeRoot !== 'string' || !path.isAbsolute(record.runtimeRoot)) throw new Error('Invalid Gemini installation record');
    return record.runtimeRoot;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return defaultRuntime;
  }
}
