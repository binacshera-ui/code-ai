import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG, type CodexProfileConfig } from './config.js';
import {
  buildBrowserModeRuntimeLaunch,
  getSessionBrowserModeRecord,
  prepareCodexBrowserModeForRun,
  type BrowserModeRuntimeLaunch,
  type CodexSessionBrowserModeRecord,
} from './codexBrowserMode.js';

const VIEWER_IDLE_TTL_MS = 15 * 60 * 1000;
const RPC_TIMEOUT_MS = 45_000;
const VIEWER_READY_DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser viewer ready</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        font-family: Inter, Rubik, system-ui, sans-serif;
        color: #1e293b;
      }
      main {
        width: min(92vw, 34rem);
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 24px;
        padding: 28px 24px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 28px 60px -36px rgba(15, 23, 42, 0.35);
      }
      h1 { margin: 0 0 12px; font-size: 1.2rem; }
      p { margin: 0; line-height: 1.7; color: #475569; }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser viewer ready</h1>
      <p>The browser session is open. Use the viewer controls to navigate, click, type, and inspect this page.</p>
    </main>
  </body>
</html>`)}`;

interface BrowserTabSummary {
  isCurrent: boolean;
  tabId: number;
  title: string | null;
  url: string | null;
}

interface BrowserTabsContextResponse {
  currentTabId?: number | null;
  tabs?: BrowserTabSummary[];
}

interface BrowserScreenshotResponse {
  currentUrl?: string | null;
  imageId: string;
  outputPath: string;
  tabId: number;
}

interface BrowserNavigateResponse {
  finalUrl?: string | null;
  tabId?: number | null;
  title?: string | null;
}

interface BrowserTabsCreateResponse {
  currentUrl?: string | null;
  tabId: number;
  title?: string | null;
}

interface BrowserFrameSummary {
  capturedAt: string;
  imageId: string;
  imageUrl: string;
  tabId: number;
}

export interface SessionBrowserViewerState {
  currentTabId: number | null;
  currentTitle: string | null;
  currentUrl: string | null;
  frame: BrowserFrameSummary | null;
  headless: boolean;
  profileDir: string;
  sessionKey: string;
  tabs: BrowserTabSummary[];
}

type BrowserViewerAction =
  | { type: 'back'; tabId?: number | null }
  | { type: 'click'; tabId?: number | null; x: number; y: number; button?: 'left' | 'right'; clickCount?: 1 | 2 | 3 }
  | { type: 'drag'; tabId?: number | null; startX: number; startY: number; endX: number; endY: number }
  | { type: 'forward'; tabId?: number | null }
  | { type: 'key'; tabId?: number | null; key: string }
  | { type: 'navigate'; tabId?: number | null; url: string }
  | { type: 'newTab'; url?: string | null }
  | { type: 'refresh'; tabId?: number | null }
  | { type: 'scroll'; amount?: number | null; direction: 'up' | 'down' | 'top' | 'bottom'; tabId?: number | null }
  | { type: 'switchTab'; tabId: number }
  | { type: 'type'; tabId?: number | null; text: string };

interface PendingRpcCall {
  reject: (error: Error) => void;
  resolve: (value: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

function buildViewerKey(profileId: string, sessionKey: string) {
  return `${profileId}:${sessionKey}`;
}

function isPathInside(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asTitle(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function asUrl(value: string | null | undefined) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function isBlankViewerUrl(value: string | null | undefined) {
  const normalized = asUrl(value);
  return !normalized || normalized === 'about:blank' || normalized.startsWith('chrome://newtab');
}

function normalizeViewerUrl(value: string | null | undefined) {
  const normalized = asUrl(value);
  if (!normalized) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith('//')) {
    return `https:${normalized}`;
  }

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/.test(normalized)) {
    return `http://${normalized}`;
  }

  return `https://${normalized}`;
}

class BrowserViewerBridge {
  private readonly bridgeInfoPath: string;
  private readonly capturePaths = new Map<string, string>();
  private httpBridgeUrl: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private operationTail: Promise<unknown> = Promise.resolve();
  private pendingCalls = new Map<number, PendingRpcCall>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private rpcCounter = 1;
  private stderrTail = '';
  private stdoutTail = '';

  constructor(
    private readonly profileId: string,
    private readonly sessionKey: string,
    private readonly mode: CodexSessionBrowserModeRecord,
    private readonly launch: BrowserModeRuntimeLaunch,
  ) {
    this.bridgeInfoPath = path.join(mode.sessionDir, 'browser-http-bridge.json');
  }

  getCapturePath(imageId: string) {
    return this.capturePaths.get(imageId) || null;
  }

  async close() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const child = this.process;
    this.process = null;
    this.readyPromise = null;
    this.httpBridgeUrl = null;

    if (!child || child.killed) {
      return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timeoutId);
        resolve();
      });
    });
  }

  async open(initialUrl?: string | null): Promise<SessionBrowserViewerState> {
    return this.enqueue(async () => {
      await this.ensureReady();
      let context = await this.getTabsContext();
      if (!context.tabs.length) {
        const created = await this.callTool<BrowserTabsCreateResponse>('tabs_create', {});
        context = {
          currentTabId: created.tabId,
          tabs: [{
            isCurrent: true,
            tabId: created.tabId,
            title: asTitle(created.title),
            url: asUrl(created.currentUrl),
          }],
        };
      }

      const targetTabId = context.currentTabId || context.tabs[0]?.tabId || null;
      const normalizedInitialUrl = normalizeViewerUrl(initialUrl);
      if (normalizedInitialUrl && targetTabId) {
        await this.callTool<BrowserNavigateResponse>('navigate', {
          tabId: targetTabId,
          url: normalizedInitialUrl,
          waitUntil: 'domcontentloaded',
        });
      }

      return this.captureState(targetTabId);
    });
  }

  async perform(action: BrowserViewerAction): Promise<SessionBrowserViewerState> {
    return this.enqueue(async () => {
      await this.ensureReady();

      switch (action.type) {
        case 'back':
          await this.callTool('navigate', { tabId: action.tabId || undefined, direction: 'back' });
          return this.captureState(action.tabId || null);
        case 'click': {
          const computerAction = action.button === 'right'
            ? 'right_click'
            : action.clickCount === 3
              ? 'triple_click'
              : action.clickCount === 2
                ? 'double_click'
                : 'left_click';
          await this.callTool('computer', {
            action: computerAction,
            coordinate: [action.x, action.y],
            tabId: action.tabId || undefined,
          });
          return this.captureState(action.tabId || null);
        }
        case 'drag':
          await this.callTool('computer', {
            action: 'left_click_drag',
            coordinate: [action.endX, action.endY],
            start_coordinate: [action.startX, action.startY],
            tabId: action.tabId || undefined,
          });
          return this.captureState(action.tabId || null);
        case 'forward':
          await this.callTool('navigate', { tabId: action.tabId || undefined, direction: 'forward' });
          return this.captureState(action.tabId || null);
        case 'key':
          await this.callTool('press_key', { key: action.key, tabId: action.tabId || undefined });
          return this.captureState(action.tabId || null);
        case 'navigate':
          if (!normalizeViewerUrl(action.url)) {
            throw new Error('A valid URL is required for navigation');
          }
          await this.callTool('navigate', {
            tabId: action.tabId || undefined,
            url: normalizeViewerUrl(action.url),
            waitUntil: 'domcontentloaded',
          });
          return this.captureState(action.tabId || null);
        case 'newTab': {
          const created = await this.callTool<BrowserTabsCreateResponse>('tabs_create', {});
          const normalizedUrl = normalizeViewerUrl(action.url);
          if (normalizedUrl) {
            await this.callTool('navigate', {
              tabId: created.tabId,
              url: normalizedUrl,
              waitUntil: 'domcontentloaded',
            });
          }
          return this.captureState(created.tabId);
        }
        case 'refresh':
          await this.callTool('navigate', { tabId: action.tabId || undefined, direction: 'reload' });
          return this.captureState(action.tabId || null);
        case 'scroll':
          await this.callTool('scroll', {
            amount: action.amount || 900,
            direction: action.direction,
            tabId: action.tabId || undefined,
          });
          return this.captureState(action.tabId || null);
        case 'switchTab':
          return this.captureState(action.tabId);
        case 'type':
          await this.callTool('computer', {
            action: 'type',
            tabId: action.tabId || undefined,
            text: action.text,
          });
          return this.captureState(action.tabId || null);
        default:
          throw new Error('Unsupported browser viewer action');
      }
    });
  }

  private async captureState(preferredTabId?: number | null): Promise<SessionBrowserViewerState> {
    let context = await this.getTabsContext();
    if (!context.tabs.length) {
      const created = await this.callTool<BrowserTabsCreateResponse>('tabs_create', {});
      context = {
        currentTabId: created.tabId,
        tabs: [{
          isCurrent: true,
          tabId: created.tabId,
          title: asTitle(created.title),
          url: asUrl(created.currentUrl),
        }],
      };
    }

    const tabId = preferredTabId || context.currentTabId || context.tabs[0]?.tabId || null;
    let frame: BrowserFrameSummary | null = null;

    if (tabId) {
      const targetTab = context.tabs.find((candidate) => candidate.tabId === tabId) || null;
      if (isBlankViewerUrl(targetTab?.url)) {
        await this.callTool('navigate', {
          tabId,
          url: VIEWER_READY_DATA_URL,
          waitUntil: 'domcontentloaded',
        });
        context = await this.getTabsContext();
      }
      try {
        const screenshot = await this.callTool<BrowserScreenshotResponse>('screenshot', {
          format: 'png',
          full_page: false,
          tabId,
          timeout_ms: 20_000,
        });
        this.capturePaths.set(screenshot.imageId, screenshot.outputPath);
        frame = {
          capturedAt: new Date().toISOString(),
          imageId: screenshot.imageId,
          imageUrl: `/api/codex/session-browser-viewer/frame?profileId=${encodeURIComponent(this.profileId)}&sessionKey=${encodeURIComponent(this.sessionKey)}&imageId=${encodeURIComponent(screenshot.imageId)}`,
          tabId: screenshot.tabId,
        };
      } catch (error: any) {
        const message = String(error?.message || error || '');
        if (!message.includes('captureScreenshot')) {
          throw error;
        }
      }
      context = await this.getTabsContext();
    }

    const currentTabId = (
      preferredTabId && context.tabs.some((candidate) => candidate.tabId === preferredTabId)
        ? preferredTabId
        : context.currentTabId || tabId || null
    );
    const currentTab = currentTabId
      ? context.tabs.find((candidate) => candidate.tabId === currentTabId) || null
      : null;

    return {
      currentTabId,
      currentTitle: asTitle(currentTab?.title),
      currentUrl: asUrl(currentTab?.url),
      frame,
      headless: this.mode.headless,
      profileDir: this.mode.profileDir,
      sessionKey: this.sessionKey,
      tabs: context.tabs,
    };
  }

  private async getTabsContext(): Promise<{ currentTabId: number | null; tabs: BrowserTabSummary[] }> {
    const context = await this.callTool<BrowserTabsContextResponse>('tabs_context', {});
    return {
      currentTabId: typeof context.currentTabId === 'number' ? context.currentTabId : null,
      tabs: Array.isArray(context.tabs)
        ? context.tabs.map((tab) => ({
          isCurrent: tab.isCurrent === true,
          tabId: Number(tab.tabId),
          title: asTitle(tab.title),
          url: asUrl(tab.url),
        }))
        : [],
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail
      .catch(() => undefined)
      .then(async () => {
        this.resetIdleTimer();
        return operation();
      });
    this.operationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async ensureReady() {
    if (this.httpBridgeUrl) {
      return;
    }

    if (this.process && this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      const liveBridgeUrl = await this.resolveLiveBridgeUrl();
      if (liveBridgeUrl) {
        this.httpBridgeUrl = liveBridgeUrl;
        return;
      }

      this.stderrTail = '';
      this.stdoutTail = '';

      const child = spawn(this.launch.command, this.launch.args, {
        cwd: CODEX_APP_CONFIG.appRoot,
        env: {
          ...process.env,
          ...this.launch.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.process = child;

      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');

      child.stdout.on('data', (chunk: string) => {
        this.stdoutTail += chunk;
        let boundary = this.stdoutTail.indexOf('\n');
        while (boundary >= 0) {
          const line = this.stdoutTail.slice(0, boundary).trim();
          this.stdoutTail = this.stdoutTail.slice(boundary + 1);
          if (line) {
            this.handleRpcLine(line);
          }
          boundary = this.stdoutTail.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk: string) => {
        const nextTail = `${this.stderrTail}${chunk}`;
        this.stderrTail = nextTail.slice(-4000);
      });

      child.once('exit', (_code, signal) => {
        const exitError = new Error(`Browser viewer runtime exited${signal ? ` (${signal})` : ''}${this.stderrTail ? `: ${this.stderrTail}` : ''}`);
        const pending = [...this.pendingCalls.values()];
        this.pendingCalls.clear();
        for (const call of pending) {
          clearTimeout(call.timeoutId);
          call.reject(exitError);
        }
        this.process = null;
        this.readyPromise = null;
      });

      await this.sendRpc('initialize', {
        capabilities: {},
        clientInfo: {
          name: 'code-ai-browser-viewer',
          version: '0.1.0',
        },
        protocolVersion: '2025-11-25',
      });
    })();

    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      this.process = null;
      throw error;
    }
  }

  private async callTool<T>(name: string, argumentsValue: Record<string, unknown>): Promise<T> {
    if (this.httpBridgeUrl) {
      const response = await fetch(`${this.httpBridgeUrl}/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          arguments: argumentsValue,
          name,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        const message = payload?.error?.message || `Browser tool "${name}" failed`;
        throw new Error(message);
      }
      return payload.result as T;
    }

    const response = await this.sendRpc('tools/call', {
      arguments: argumentsValue,
      name,
    });
    const payload = response?.structuredContent ?? null;
    if (response?.isError) {
      const message = payload?.message || `Browser tool "${name}" failed`;
      throw new Error(message);
    }
    return payload as T;
  }

  private handleRpcLine(line: string) {
    let message: any = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const requestId = typeof message?.id === 'number' ? message.id : null;
    if (requestId === null) {
      return;
    }

    const pending = this.pendingCalls.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingCalls.delete(requestId);

    if (message.error) {
      pending.reject(new Error(message.error.message || 'Browser viewer RPC failed'));
      return;
    }

    pending.resolve(message.result);
  }

  private sendRpc(method: string, params: Record<string, unknown>) {
    const child = this.process;
    if (!child || child.killed) {
      throw new Error('Browser viewer runtime is not running');
    }

    const requestId = this.rpcCounter++;
    const payload = {
      id: requestId,
      jsonrpc: '2.0',
      method,
      params,
    };

    return new Promise<any>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        reject(new Error(`Browser viewer RPC timeout for ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pendingCalls.set(requestId, {
        reject,
        resolve,
        timeoutId,
      });

      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf-8', (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeoutId);
        this.pendingCalls.delete(requestId);
        reject(error);
      });
    });
  }

  private resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, VIEWER_IDLE_TTL_MS);
  }

  private async resolveLiveBridgeUrl(): Promise<string | null> {
    const infoRaw = await fs.readFile(this.bridgeInfoPath, 'utf-8').catch(() => '');
    if (!infoRaw.trim()) {
      return null;
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(infoRaw);
    } catch {
      return null;
    }

    const candidateUrl = typeof parsed?.url === 'string' && parsed.url.trim()
      ? parsed.url.trim()
      : null;
    if (!candidateUrl) {
      return null;
    }

    const response = await fetch(`${candidateUrl}/health`).catch(() => null);
    if (!response?.ok) {
      return null;
    }

    const payload = await response.json().catch(() => null);
    if (payload?.ok !== true) {
      return null;
    }

    return candidateUrl;
  }
}

const viewerByKey = new Map<string, BrowserViewerBridge>();

async function resolveViewerBridge(profile: CodexProfileConfig, sessionKey: string) {
  const record = await getSessionBrowserModeRecord(profile.id, sessionKey);
  if (!record || record.enabled !== true) {
    throw new Error('Browser mode is not enabled for this session');
  }

  const prepared = await prepareCodexBrowserModeForRun(profile, profile.id, sessionKey, record);
  if (!prepared) {
    throw new Error('Browser mode could not be prepared for this session');
  }

  const key = buildViewerKey(profile.id, sessionKey);
  const existing = viewerByKey.get(key);
  if (existing) {
    return existing;
  }

  const launch = await buildBrowserModeRuntimeLaunch(prepared.mode);
  const bridge = new BrowserViewerBridge(profile.id, sessionKey, prepared.mode, launch);
  viewerByKey.set(key, bridge);
  return bridge;
}

export async function openSessionBrowserViewer(
  profile: CodexProfileConfig,
  sessionKey: string,
  initialUrl?: string | null,
) {
  const bridge = await resolveViewerBridge(profile, sessionKey);
  return bridge.open(initialUrl);
}

export async function performSessionBrowserViewerAction(
  profile: CodexProfileConfig,
  sessionKey: string,
  action: BrowserViewerAction,
) {
  const bridge = await resolveViewerBridge(profile, sessionKey);
  return bridge.perform(action);
}

export async function closeSessionBrowserViewer(profileId: string, sessionKey: string) {
  const key = buildViewerKey(profileId, sessionKey);
  const bridge = viewerByKey.get(key);
  viewerByKey.delete(key);
  await bridge?.close();
}

export async function resolveSessionBrowserViewerFramePath(
  profile: CodexProfileConfig,
  sessionKey: string,
  imageId: string,
) {
  const key = buildViewerKey(profile.id, sessionKey);
  const liveBridge = viewerByKey.get(key);
  const livePath = liveBridge?.getCapturePath(imageId) || null;
  if (livePath && isPathInside((await getSessionBrowserModeRecord(profile.id, sessionKey))?.screenshotsDir || '', livePath)) {
    return livePath;
  }

  const record = await getSessionBrowserModeRecord(profile.id, sessionKey);
  if (!record) {
    return null;
  }

  const files = await fs.readdir(record.screenshotsDir).catch(() => []);
  const match = files.find((fileName) => path.parse(fileName).name === imageId);
  if (!match) {
    return null;
  }

  const resolvedPath = path.join(record.screenshotsDir, match);
  if (!isPathInside(record.screenshotsDir, resolvedPath)) {
    return null;
  }

  return resolvedPath;
}
