import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('rotates crash logs before they can grow without a bound', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'code-ai-crash-logs-'));
  process.env.CODEX_LOG_ROOT = temporaryRoot;
  process.env.CODEX_CRASH_LOG_MAX_BYTES = '1024';

  try {
    const { SERVER_CRASH_LOG, recordCodexServerCrash } = await import('./codexCrashLogs.js');
    for (let index = 0; index < 40; index += 1) {
      await recordCodexServerCrash({
        type: 'testCrash',
        index,
        message: 'bounded-crash-log-entry'.repeat(3),
      });
    }

    const currentStats = await stat(SERVER_CRASH_LOG);
    const rotatedStats = await stat(`${SERVER_CRASH_LOG}.1`);
    assert(currentStats.size <= 1024);
    assert(rotatedStats.size <= 1024);

    for (const filePath of [SERVER_CRASH_LOG, `${SERVER_CRASH_LOG}.1`]) {
      const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
      assert(lines.length > 0);
      for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    delete process.env.CODEX_LOG_ROOT;
    delete process.env.CODEX_CRASH_LOG_MAX_BYTES;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
