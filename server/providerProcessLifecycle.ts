import { spawnSync, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

const DEFAULT_FORCE_KILL_DELAY_MS = 3_000;

export type ProviderSessionStartedHandler = (
  sessionId: string
) => void | Promise<void>;

/**
 * Existing sessions must serialize by their stable session id. Brand-new
 * conversations are independent and must never share one global "new" lock.
 */
export function buildProviderRunQueueKey(
  profileId: string,
  sessionId?: string | null,
  runId?: string | null
): string {
  const normalizedProfileId = profileId.trim();
  const normalizedSessionId = sessionId?.trim() || '';
  if (normalizedSessionId) {
    return `${normalizedProfileId}:${normalizedSessionId}`;
  }

  const normalizedRunId = runId?.trim() || randomUUID();
  return `${normalizedProfileId}:__new__:${normalizedRunId}`;
}

export function notifyProviderSessionStarted(
  handler: ProviderSessionStartedHandler | undefined,
  sessionId: string,
  providerLabel: string
): void {
  const normalizedSessionId = sessionId.trim();
  if (!handler || !normalizedSessionId) {
    return;
  }

  Promise.resolve(handler(normalizedSessionId)).catch((error) => {
    console.error(
      `Failed to persist ${providerLabel} session ${normalizedSessionId} after startup:`,
      error
    );
  });
}

export function getProviderProcessSpawnOptions(): { detached: boolean } {
  return {
    // A dedicated process group lets code-ai terminate provider wrappers and
    // their native CLI children together during cancellation or shutdown.
    detached: process.platform !== 'win32',
  };
}

function signalPosixProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) {
    return false;
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code !== 'ESRCH') {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    }
    return false;
  }
}

function terminateWindowsProcessTree(child: ChildProcess): boolean {
  if (!child.pid) {
    return false;
  }

  const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function terminateProviderProcessTree(
  child: ChildProcess,
  forceKillDelayMs = DEFAULT_FORCE_KILL_DELAY_MS
): boolean {
  if (!child.pid) {
    return false;
  }

  if (process.platform === 'win32') {
    return terminateWindowsProcessTree(child);
  }

  const signalled = signalPosixProcessGroup(child, 'SIGTERM');
  const forceKillTimer = setTimeout(() => {
    signalPosixProcessGroup(child, 'SIGKILL');
  }, Math.max(0, forceKillDelayMs));
  forceKillTimer.unref();
  return signalled;
}
