import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CodexProfileConfig } from './config.js';
import { getProfileSpawnIdentity } from './providerRuntimeOwnership.js';

const MAX_TERMINALS_PER_OWNER = 4;
const MAX_TERMINALS_TOTAL = 16;
const MAX_INPUT_CHARACTERS = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERMINAL_IDLE_TTL_MS = 30 * 60 * 1000;
const EXITED_TERMINAL_TTL_MS = 60 * 1000;
const MIN_COLUMNS = 20;
const MAX_COLUMNS = 320;
const MIN_ROWS = 5;
const MAX_ROWS = 120;
const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SSH_AUTH_SOCK',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'WSLENV',
  'WSL_DISTRO_NAME',
  'WSL_INTEROP',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
]);

interface TerminalOutputChunk {
  cursor: number;
  data: string;
  bytes: number;
}

interface TerminalRecord {
  id: string;
  ownerId: string;
  profileId: string;
  cwd: string;
  shell: string;
  process: IPty;
  createdAt: string;
  lastActivityAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: number | null;
  nextCursor: number;
  outputBytes: number;
  output: TerminalOutputChunk[];
}

export interface CodexTerminalSession {
  id: string;
  profileId: string;
  cwd: string;
  shell: string;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
}

export interface CodexTerminalOutput {
  cursor: number;
  data: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
}

export interface CreateCodexTerminalOptions {
  ownerId: string;
  profile: CodexProfileConfig;
  cwd: string;
  columns?: number;
  rows?: number;
}

const terminals = new Map<string, TerminalRecord>();

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(Number(value))));
}

function readSystemIdentity(uid: number | undefined): {
  username?: string;
  home?: string;
  shell?: string;
} {
  if (process.platform === 'win32' || uid === undefined) {
    return {};
  }

  try {
    const row = readFileSync('/etc/passwd', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split(':'))
      .find((parts) => Number(parts[2]) === uid);
    if (!row) {
      return {};
    }
    return {
      username: row[0] || undefined,
      home: row[5] || undefined,
      shell: row[6] || undefined,
    };
  } catch {
    return {};
  }
}

function resolveTerminalShell(identity: ReturnType<typeof readSystemIdentity>): {
  executable: string;
  args: string[];
} {
  const resolveArgs = (executable: string): string[] => {
    if (process.platform !== 'win32') {
      return ['-l'];
    }

    const executableName = path.basename(executable).toLowerCase();
    if (executableName === 'cmd' || executableName === 'cmd.exe') {
      return [];
    }
    if (
      executableName === 'powershell'
      || executableName === 'powershell.exe'
      || executableName === 'pwsh'
      || executableName === 'pwsh.exe'
    ) {
      return ['-NoLogo'];
    }
    return [];
  };

  const configuredShell = process.env.CODEX_TERMINAL_SHELL?.trim();
  if (configuredShell) {
    return {
      executable: configuredShell,
      args: resolveArgs(configuredShell),
    };
  }

  if (process.platform === 'win32') {
    const executable = process.env.COMSPEC?.trim() || 'powershell.exe';
    return {
      executable,
      args: resolveArgs(executable),
    };
  }

  return {
    executable: identity.shell || process.env.SHELL?.trim() || '/bin/bash',
    args: ['-l'],
  };
}

function buildTerminalEnvironment(
  profile: CodexProfileConfig,
  identity: ReturnType<typeof readSystemIdentity>,
  cwd: string,
  shellExecutable: string
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => {
        if (typeof entry[1] !== 'string') {
          return false;
        }
        const normalizedKey = entry[0].toUpperCase();
        return (
          PASSTHROUGH_ENVIRONMENT_KEYS.has(normalizedKey)
          || normalizedKey.startsWith('LC_')
        );
      })
  );

  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.PWD = cwd;
  environment.CODEX_HOME = profile.codexHome;
  environment.SHELL = shellExecutable;

  if (identity.home) {
    environment.HOME = identity.home;
  } else if (process.platform !== 'win32') {
    environment.HOME = path.dirname(profile.codexHome);
  }

  if (identity.username) {
    environment.USER = identity.username;
    environment.LOGNAME = identity.username;
  }

  return environment;
}

function summarizeTerminal(record: TerminalRecord): CodexTerminalSession {
  return {
    id: record.id,
    profileId: record.profileId,
    cwd: record.cwd,
    shell: path.basename(record.shell),
    createdAt: record.createdAt,
    exited: record.exitedAt !== null,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
  };
}

function appendOutput(record: TerminalRecord, data: string): void {
  if (!data) {
    return;
  }

  const chunk: TerminalOutputChunk = {
    cursor: record.nextCursor + 1,
    data,
    bytes: Buffer.byteLength(data, 'utf8'),
  };
  record.nextCursor = chunk.cursor;
  record.output.push(chunk);
  record.outputBytes += chunk.bytes;
  record.lastActivityAt = Date.now();

  while (record.output.length > 1 && record.outputBytes > MAX_OUTPUT_BYTES) {
    const removed = record.output.shift();
    if (removed) {
      record.outputBytes -= removed.bytes;
    }
  }
}

function requireTerminal(ownerId: string, terminalId: string): TerminalRecord {
  const record = terminals.get(terminalId);
  if (!record || record.ownerId !== ownerId) {
    throw new Error('Terminal session was not found');
  }
  return record;
}

function terminateRecord(record: TerminalRecord): void {
  if (record.exitedAt !== null) {
    return;
  }
  try {
    record.process.kill();
  } catch {
    // The PTY may already have exited between the state check and kill.
  }
}

function removeExpiredTerminals(now = Date.now()): void {
  for (const [terminalId, record] of terminals) {
    const ttl = record.exitedAt === null ? TERMINAL_IDLE_TTL_MS : EXITED_TERMINAL_TTL_MS;
    const age = now - (record.exitedAt || record.lastActivityAt);
    if (age < ttl) {
      continue;
    }
    terminateRecord(record);
    terminals.delete(terminalId);
  }
}

const cleanupTimer = setInterval(removeExpiredTerminals, 60 * 1000);
cleanupTimer.unref();

export function createCodexTerminalSession(
  options: CreateCodexTerminalOptions
): CodexTerminalSession {
  removeExpiredTerminals();

  const ownerTerminals = [...terminals.values()]
    .filter((record) => record.ownerId === options.ownerId && record.exitedAt === null);
  if (ownerTerminals.length >= MAX_TERMINALS_PER_OWNER) {
    throw new Error(`A maximum of ${MAX_TERMINALS_PER_OWNER} active terminals is allowed`);
  }
  if ([...terminals.values()].filter((record) => record.exitedAt === null).length >= MAX_TERMINALS_TOTAL) {
    throw new Error('The terminal capacity of this server has been reached');
  }

  const spawnIdentity = getProfileSpawnIdentity(options.profile);
  const systemIdentity = readSystemIdentity(spawnIdentity.uid);
  const shell = resolveTerminalShell(systemIdentity);
  const columns = clampInteger(options.columns, 100, MIN_COLUMNS, MAX_COLUMNS);
  const rows = clampInteger(options.rows, 30, MIN_ROWS, MAX_ROWS);
  const terminalProcess = pty.spawn(shell.executable, shell.args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: options.cwd,
    env: buildTerminalEnvironment(
      options.profile,
      systemIdentity,
      options.cwd,
      shell.executable
    ),
    ...(process.platform === 'win32' ? { useConpty: true } : spawnIdentity),
  });

  const record: TerminalRecord = {
    id: randomUUID(),
    ownerId: options.ownerId,
    profileId: options.profile.id,
    cwd: options.cwd,
    shell: shell.executable,
    process: terminalProcess,
    createdAt: new Date().toISOString(),
    lastActivityAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    nextCursor: 0,
    outputBytes: 0,
    output: [],
  };
  terminals.set(record.id, record);

  terminalProcess.onData((data) => appendOutput(record, data));
  terminalProcess.onExit(({ exitCode, signal }) => {
    record.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    record.exitSignal = Number.isInteger(signal) ? Number(signal) : null;
    record.exitedAt = Date.now();
    record.lastActivityAt = record.exitedAt;
  });

  return summarizeTerminal(record);
}

export function readCodexTerminalOutput(
  ownerId: string,
  terminalId: string,
  cursor = 0
): CodexTerminalOutput {
  const record = requireTerminal(ownerId, terminalId);
  const normalizedCursor = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const firstCursor = record.output[0]?.cursor || record.nextCursor + 1;
  const truncated = normalizedCursor > 0 && normalizedCursor < firstCursor - 1;
  const chunks = record.output.filter((chunk) => chunk.cursor > normalizedCursor);
  record.lastActivityAt = Date.now();

  return {
    cursor: chunks.at(-1)?.cursor || Math.max(normalizedCursor, record.nextCursor),
    data: chunks.map((chunk) => chunk.data).join(''),
    truncated,
    exited: record.exitedAt !== null,
    exitCode: record.exitCode,
    exitSignal: record.exitSignal,
  };
}

export function writeCodexTerminalInput(
  ownerId: string,
  terminalId: string,
  data: string
): void {
  const record = requireTerminal(ownerId, terminalId);
  if (record.exitedAt !== null) {
    throw new Error('Terminal process has already exited');
  }
  if (!data || data.length > MAX_INPUT_CHARACTERS) {
    throw new Error(`Terminal input must contain between 1 and ${MAX_INPUT_CHARACTERS} characters`);
  }
  record.process.write(data);
  record.lastActivityAt = Date.now();
}

export function resizeCodexTerminal(
  ownerId: string,
  terminalId: string,
  columns?: number,
  rows?: number
): void {
  const record = requireTerminal(ownerId, terminalId);
  if (record.exitedAt !== null) {
    return;
  }
  record.process.resize(
    clampInteger(columns, record.process.cols, MIN_COLUMNS, MAX_COLUMNS),
    clampInteger(rows, record.process.rows, MIN_ROWS, MAX_ROWS)
  );
  record.lastActivityAt = Date.now();
}

export function closeCodexTerminal(ownerId: string, terminalId: string): void {
  const record = requireTerminal(ownerId, terminalId);
  terminateRecord(record);
  terminals.delete(terminalId);
}

export function shutdownCodexTerminals(): void {
  clearInterval(cleanupTimer);
  for (const record of terminals.values()) {
    terminateRecord(record);
  }
  terminals.clear();
}

export function getActiveCodexTerminalCount(): number {
  return [...terminals.values()].filter((record) => record.exitedAt === null).length;
}
