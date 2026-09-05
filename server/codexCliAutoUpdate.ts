import { spawn, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const CODEX_PACKAGE_NAME = '@openai/codex';
const CODEX_LATEST_PACKAGE_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const DEFAULT_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

export type CodexCliAutoUpdateState = 'disabled' | 'checking' | 'current' | 'updating' | 'updated' | 'error';

export interface CodexCliAutoUpdateSnapshot {
  enabled: boolean;
  state: CodexCliAutoUpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  error: string | null;
}

let updateTimer: NodeJS.Timeout | null = null;
let updatePromise: Promise<CodexCliAutoUpdateSnapshot> | null = null;
let updateSnapshot: CodexCliAutoUpdateSnapshot = {
  enabled: false,
  state: 'disabled',
  currentVersion: null,
  latestVersion: null,
  lastCheckedAt: null,
  lastUpdatedAt: null,
  error: null,
};

function isAutoUpdateEnabled(): boolean {
  const configured = process.env.CODEX_CLI_AUTO_UPDATE?.trim().toLowerCase();
  if (configured) {
    return !['0', 'false', 'no', 'off'].includes(configured);
  }
  return process.env.NODE_ENV === 'production';
}

function readUpdateIntervalMs(): number {
  const configured = Number(process.env.CODEX_CLI_AUTO_UPDATE_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_UPDATE_INTERVAL_MS;
  }
  return Math.max(MIN_UPDATE_INTERVAL_MS, Math.floor(configured));
}

export function parseCodexCliVersion(value: string | null | undefined): string | null {
  const match = String(value || '').match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
  return match?.[1] || null;
}

function parseStableVersionParts(value: string): number[] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map((part) => Number(part)) : null;
}

export function compareStableVersions(left: string, right: string): number {
  const leftParts = parseStableVersionParts(left);
  const rightParts = parseStableVersionParts(right);
  if (!leftParts || !rightParts) {
    return left.localeCompare(right);
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function inferPosixNpmPrefixFromCodexPath(codexPath: string): string | null {
  const normalized = path.resolve(codexPath).replace(/\\/g, '/');
  const marker = '/lib/node_modules/@openai/codex/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return normalized.slice(0, markerIndex) || '/';
}

function resolveCodexCommand(): string {
  return process.env.CODEX_BIN?.trim() || 'codex';
}

async function resolveCodexExecutable(command: string): Promise<string | null> {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try {
      return await fs.realpath(path.resolve(command));
    } catch {
      return path.resolve(command);
    }
  }

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnSync(locator, [command], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 10_000,
  });
  const firstPath = String(located.stdout || '').split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  if (!firstPath) {
    return null;
  }
  try {
    return await fs.realpath(firstPath);
  } catch {
    return firstPath;
  }
}

function readInstalledVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseCodexCliVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
}

async function fetchLatestStableVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  timeout.unref?.();
  try {
    const response = await fetch(CODEX_LATEST_PACKAGE_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }
    const payload = await response.json() as { version?: unknown };
    const version = typeof payload.version === 'string' ? parseCodexCliVersion(payload.version) : null;
    if (!version || !parseStableVersionParts(version)) {
      throw new Error('npm registry did not return a stable Codex version');
    }
    return version;
  } finally {
    clearTimeout(timeout);
  }
}

function runUpdateCommand(latestVersion: string, npmPrefix: string | null): Promise<void> {
  const packageSpec = `${CODEX_PACKAGE_NAME}@${latestVersion}`;
  const npmArguments = [
    'install',
    '--global',
    ...(npmPrefix ? ['--prefix', npmPrefix] : []),
    packageSpec,
  ];

  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.NPM_BIN?.trim() || 'npm');
    const args = isWindows
      ? ['/d', '/s', '/c', ['npm', ...npmArguments].join(' ')]
      : npmArguments;
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const appendOutput = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    };
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Codex CLI update timed out'));
    }, UPDATE_TIMEOUT_MS);
    timeout.unref?.();

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.trim().split(/\r?\n/).slice(-4).join(' ');
      reject(new Error(`Codex CLI update failed with exit code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

export function getCodexCliAutoUpdateSnapshot(): CodexCliAutoUpdateSnapshot {
  return { ...updateSnapshot };
}

export async function checkForCodexCliUpdate(
  onUpdated?: () => void | Promise<void>,
): Promise<CodexCliAutoUpdateSnapshot> {
  if (updatePromise) {
    return updatePromise;
  }

  updatePromise = (async () => {
    const enabled = isAutoUpdateEnabled();
    if (!enabled) {
      updateSnapshot = { ...updateSnapshot, enabled: false, state: 'disabled', error: null };
      return getCodexCliAutoUpdateSnapshot();
    }

    updateSnapshot = { ...updateSnapshot, enabled: true, state: 'checking', error: null };
    const command = resolveCodexCommand();
    try {
      const currentVersion = readInstalledVersion(command);
      if (!currentVersion) {
        throw new Error(`Could not read Codex CLI version from ${command}`);
      }
      const latestVersion = await fetchLatestStableVersion();
      updateSnapshot = {
        ...updateSnapshot,
        currentVersion,
        latestVersion,
        lastCheckedAt: new Date().toISOString(),
      };

      if (compareStableVersions(currentVersion, latestVersion) >= 0) {
        updateSnapshot = { ...updateSnapshot, state: 'current', error: null };
        return getCodexCliAutoUpdateSnapshot();
      }

      updateSnapshot = { ...updateSnapshot, state: 'updating' };
      const executable = await resolveCodexExecutable(command);
      const npmPrefix = process.platform === 'win32' || !executable
        ? null
        : inferPosixNpmPrefixFromCodexPath(executable);
      await runUpdateCommand(latestVersion, npmPrefix);

      const installedVersion = readInstalledVersion(command);
      if (!installedVersion || compareStableVersions(installedVersion, latestVersion) < 0) {
        throw new Error(`Codex CLI stayed on ${installedVersion || currentVersion} after updating to ${latestVersion}`);
      }

      updateSnapshot = {
        ...updateSnapshot,
        state: 'updated',
        currentVersion: installedVersion,
        latestVersion,
        lastUpdatedAt: new Date().toISOString(),
        error: null,
      };
      await onUpdated?.();
      return getCodexCliAutoUpdateSnapshot();
    } catch (error: any) {
      updateSnapshot = {
        ...updateSnapshot,
        state: 'error',
        lastCheckedAt: new Date().toISOString(),
        error: error?.message || String(error),
      };
      return getCodexCliAutoUpdateSnapshot();
    }
  })().finally(() => {
    updatePromise = null;
  });

  return updatePromise;
}

export function startCodexCliAutoUpdateWorker(onUpdated?: () => void | Promise<void>): void {
  if (updateTimer) {
    return;
  }

  const runCheck = () => {
    void checkForCodexCliUpdate(onUpdated).then((snapshot) => {
      if (snapshot.state === 'updated') {
        console.log(`✅ Codex CLI updated automatically to ${snapshot.currentVersion}`);
      } else if (snapshot.state === 'error') {
        console.error(`❌ Codex CLI automatic update check failed: ${snapshot.error}`);
      }
    });
  };

  runCheck();
  if (!isAutoUpdateEnabled()) {
    return;
  }
  updateTimer = setInterval(runCheck, readUpdateIntervalMs());
  updateTimer.unref();
}

export function stopCodexCliAutoUpdateWorker(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}
