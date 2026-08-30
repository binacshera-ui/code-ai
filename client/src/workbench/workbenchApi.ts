import type { BrowserInspectedElement, BrowserViewerState } from './types';

interface ApiErrorPayload {
  error?: string;
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & ApiErrorPayload) | null;
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed with status ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export async function enableWorkbenchBrowser(profileId: string, sessionKey: string) {
  const query = new URLSearchParams({ profileId, sessionKey });
  const currentResponse = await fetch(`/api/codex/session-browser-mode?${query.toString()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const current = await readApiResponse<{
    browserMode: {
      enabled: boolean;
      headless: boolean;
      profileSeed: 'seeded' | 'empty' | 'custom';
      customProfileDir?: string | null;
    };
  }>(currentResponse);
  if (current.browserMode.enabled) {
    return current;
  }

  const response = await fetch('/api/codex/session-browser-mode', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileId,
      sessionKey,
      browserMode: {
        ...current.browserMode,
        enabled: true,
      },
    }),
  });
  return readApiResponse<{ browserMode: { enabled: boolean } }>(response);
}

export async function openWorkbenchBrowser(
  profileId: string,
  sessionKey: string,
  initialUrl?: string | null,
) {
  const query = new URLSearchParams({ profileId, sessionKey });
  if (initialUrl?.trim()) query.set('url', initialUrl.trim());
  const response = await fetch(`/api/codex/session-browser-viewer?${query.toString()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload = await readApiResponse<{ viewer: BrowserViewerState }>(response);
  return payload.viewer;
}

export async function connectWorkbenchBinaSession(profileId: string, sessionKey: string) {
  const response = await fetch('/api/codex/session-browser-viewer/bina-sso', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, sessionKey }),
  });
  return readApiResponse<{
    connected: boolean;
    legacyConnected?: boolean;
    runtimeConnected?: boolean;
    source?: 'bina-runtime-sso';
  }>(response);
}

export async function runWorkbenchBrowserAction(
  profileId: string,
  sessionKey: string,
  action: Record<string, unknown>,
) {
  const response = await fetch('/api/codex/session-browser-viewer/action', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, sessionKey, ...action }),
  });
  const payload = await readApiResponse<{ viewer: BrowserViewerState }>(response);
  return payload.viewer;
}

export async function sendWorkbenchBrowserInput(
  profileId: string,
  sessionKey: string,
  input: Record<string, unknown>,
) {
  const response = await fetch('/api/codex/session-browser-viewer/input', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, sessionKey, ...input }),
  });
  await readApiResponse<{ queued: true }>(response);
}

export async function inspectWorkbenchPoint(
  profileId: string,
  sessionKey: string,
  x: number,
  y: number,
  tabId?: number | null,
) {
  const response = await fetch('/api/codex/session-browser-viewer/inspect', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId, sessionKey, x, y, tabId }),
  });
  const payload = await readApiResponse<{
    inspection: {
      currentUrl: string | null;
      element: BrowserInspectedElement | null;
      inspectedAt: string | null;
      tabId: number;
      title: string | null;
    };
  }>(response);
  return payload.inspection;
}

export async function closeWorkbenchBrowser(profileId: string, sessionKey: string) {
  const query = new URLSearchParams({ profileId, sessionKey });
  const response = await fetch(`/api/codex/session-browser-viewer?${query.toString()}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  if (response.status === 204) return;
  await readApiResponse<Record<string, never>>(response);
}
