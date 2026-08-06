import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { CodexProfileConfig } from './config.js';
import {
  closeCodexTerminal,
  createCodexTerminalSession,
  getActiveCodexTerminalCount,
  readCodexTerminalOutput,
  resizeCodexTerminal,
  shutdownCodexTerminals,
  writeCodexTerminalInput,
} from './codexTerminal.js';

let temporaryRoot = '';
let profile: CodexProfileConfig;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'code-ai-terminal-test-'));
  const codexHome = path.join(temporaryRoot, '.codex');
  await mkdir(codexHome, { recursive: true });
  profile = {
    id: 'terminal-test',
    label: 'Terminal Test',
    provider: 'codex',
    codexHome,
    workspaceCwd: temporaryRoot,
    defaultProfile: true,
  };
});

after(async () => {
  shutdownCodexTerminals();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function waitForOutput(
  ownerId: string,
  terminalId: string,
  predicate: (value: string) => boolean,
  timeoutMs = 5_000
) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let collected = '';
  while (Date.now() < deadline) {
    const output = readCodexTerminalOutput(ownerId, terminalId, cursor);
    cursor = output.cursor;
    collected += output.data;
    if (predicate(collected)) {
      return { output, collected };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for terminal output: ${JSON.stringify(collected)}`);
}

test('runs an interactive PTY in the requested working directory', async () => {
  const previousRemoteToken = process.env.CODEX_REMOTE_AGENT_TOKEN;
  process.env.CODEX_REMOTE_AGENT_TOKEN = 'terminal-test-secret-must-not-leak';
  let terminal: ReturnType<typeof createCodexTerminalSession>;
  try {
    terminal = createCodexTerminalSession({
      ownerId: 'owner-a',
      profile,
      cwd: temporaryRoot,
      columns: 90,
      rows: 24,
    });
  } finally {
    if (previousRemoteToken === undefined) {
      delete process.env.CODEX_REMOTE_AGENT_TOKEN;
    } else {
      process.env.CODEX_REMOTE_AGENT_TOKEN = previousRemoteToken;
    }
  }

  assert.equal(terminal.cwd, temporaryRoot);
  assert.equal(terminal.exited, false);
  assert.equal(getActiveCodexTerminalCount(), 1);

  resizeCodexTerminal('owner-a', terminal.id, 120, 32);
  writeCodexTerminalInput(
    'owner-a',
    terminal.id,
    `printf 'CODE_AI_TERMINAL_OK:%s\\n' "$PWD"; `
      + `if [ -z "\${CODEX_REMOTE_AGENT_TOKEN+x}" ]; then `
      + `printf 'CODE_AI_TERMINAL_SECRET_FILTERED\\n'; fi; exit\r`
  );

  const result = await waitForOutput(
    'owner-a',
    terminal.id,
    (value) => value.includes(`CODE_AI_TERMINAL_OK:${temporaryRoot}`)
  );
  assert.match(result.collected, /CODE_AI_TERMINAL_OK:/);
  assert.match(result.collected, /CODE_AI_TERMINAL_SECRET_FILTERED/);
  await waitForOutput('owner-a', terminal.id, (_value) => {
    return readCodexTerminalOutput('owner-a', terminal.id, result.output.cursor).exited;
  });

  closeCodexTerminal('owner-a', terminal.id);
  assert.equal(getActiveCodexTerminalCount(), 0);
});

test('isolates terminals by owner and rejects oversized input', () => {
  const terminal = createCodexTerminalSession({
    ownerId: 'owner-b',
    profile,
    cwd: temporaryRoot,
  });

  assert.throws(
    () => readCodexTerminalOutput('owner-c', terminal.id, 0),
    /Terminal session was not found/
  );
  assert.throws(
    () => writeCodexTerminalInput('owner-b', terminal.id, 'x'.repeat(64 * 1024 + 1)),
    /Terminal input must contain/
  );

  closeCodexTerminal('owner-b', terminal.id);
});
