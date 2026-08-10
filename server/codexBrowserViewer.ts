import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
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
  liveStreamAvailable?: boolean;
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
  streamUrl: string | null;
  tabId: number;
}

export interface BrowserViewerLiveFrame {
  capturedAt: string | null;
  data: Buffer;
  height: number | null;
  sequence: number;
  tabId: number;
  width: number | null;
}

export interface BrowserElementInspectionResponse {
  currentUrl?: string | null;
  element?: Record<string, any> | null;
  inspectedAt?: string | null;
  tabId: number;
  title?: string | null;
}

export interface SessionBrowserElementSelection {
  selectionId: string;
  tabId: number;
  url: string | null;
  title: string | null;
  capturedAt: string;
  screenshotImageId: string | null;
  screenshotUrl: string | null;
  cropImageId: string | null;
  cropUrl: string | null;
  element: Record<string, any>;
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
  selection?: SessionBrowserElementSelection | null;
}

type BrowserViewerAction =
  | { type: 'back'; tabId?: number | null }
  | { type: 'capture'; tabId?: number | null }
  | { type: 'click'; tabId?: number | null; x: number; y: number; button?: 'left' | 'right'; clickCount?: 1 | 2 | 3 }
  | { type: 'drag'; tabId?: number | null; startX: number; startY: number; endX: number; endY: number }
  | { type: 'forward'; tabId?: number | null }
  | { type: 'inspect'; tabId?: number | null; x: number; y: number }
  | { type: 'key'; tabId?: number | null; key: string }
  | { type: 'navigate'; tabId?: number | null; url: string }
  | { type: 'newTab'; url?: string | null }
  | { type: 'refresh'; tabId?: number | null }
  | { type: 'resize'; tabId?: number | null; width: number; height: number }
  | { type: 'scroll'; amount?: number | null; direction: 'up' | 'down' | 'top' | 'bottom'; tabId?: number | null }
  | { type: 'switchTab'; tabId: number }
  | { type: 'sync'; tabId?: number | null }
  | { type: 'type'; tabId?: number | null; text: string };

export type BrowserViewerInput =
  | { type: 'hover'; tabId?: number | null; x: number; y: number }
  | { type: 'scroll'; tabId?: number | null; deltaX: number; deltaY: number };

interface PendingRpcCall {
  reject: (error: Error) => void;
  resolve: (value: any) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface BrowserHttpBridgeEndpoint {
  token: string | null;
  url: string;
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
  private readonly captureOrder: string[] = [];
  private readonly latestFrameByTab = new Map<number, BrowserFrameSummary>();
  private readonly retainedCaptureIds = new Set<string>();
  private readonly streamVersionByTab = new Map<number, number>();
  private readonly streamViewportByTab = new Map<number, { height: number; width: number }>();
  private inputDrainActive = false;
  private inputDrainPreferScroll = false;
  private pendingHoverInput: Extract<BrowserViewerInput, { type: 'hover' }> | null = null;
  private pendingScrollInput: Extract<BrowserViewerInput, { type: 'scroll' }> | null = null;
  private httpBridgeUrl: string | null = null;
  private httpBridgeToken: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private operationTail: Promise<unknown> = Promise.resolve();
  private pendingCalls = new Map<number, PendingRpcCall>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private rpcCounter = 1;
  private runtimeLeaseCount = 0;
  private stderrTail = '';
  private stdoutTail = '';

  constructor(
    private readonly profileId: string,
    private sessionKey: string,
    private readonly mode: CodexSessionBrowserModeRecord,
    private readonly launch: BrowserModeRuntimeLaunch,
  ) {
    this.bridgeInfoPath = path.join(mode.sessionDir, 'browser-http-bridge.json');
  }

  getCapturePath(imageId: string) {
    return this.capturePaths.get(imageId) || null;
  }

  matchesSessionDirectory(profileId: string, sessionDir: string) {
    return this.profileId === profileId && this.mode.sessionDir === sessionDir;
  }

  rebindSessionKey(sessionKey: string) {
    this.sessionKey = sessionKey;
  }

  private trackCapture(imageId: string, outputPath: string, retain = false) {
    this.capturePaths.set(imageId, outputPath);
    this.captureOrder.push(imageId);
    if (retain) this.retainedCaptureIds.add(imageId);
    while (this.captureOrder.length > 120) {
      const expiredImageId = this.captureOrder.shift();
      if (!expiredImageId) break;
      if (this.retainedCaptureIds.has(expiredImageId)) continue;
      const expiredPath = this.capturePaths.get(expiredImageId);
      this.capturePaths.delete(expiredImageId);
      if (expiredPath) void fs.unlink(expiredPath).catch(() => {});
    }
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
    this.httpBridgeToken = null;
    this.runtimeLeaseCount = 0;

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

  async acquireRuntimeLease() {
    await this.enqueue(async () => {
      await this.ensureReady();
      this.runtimeLeaseCount += 1;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    });
  }

  releaseRuntimeLease() {
    this.runtimeLeaseCount = Math.max(0, this.runtimeLeaseCount - 1);
    if (this.runtimeLeaseCount === 0) {
      this.resetIdleTimer();
    }
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
          return this.captureAfterLiveAction(action.tabId || null);
        case 'capture':
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
          return this.captureAfterLiveAction(action.tabId || null);
        }
        case 'drag':
          await this.callTool('computer', {
            action: 'left_click_drag',
            coordinate: [action.endX, action.endY],
            start_coordinate: [action.startX, action.startY],
            tabId: action.tabId || undefined,
          });
          return this.captureAfterLiveAction(action.tabId || null);
        case 'forward':
          await this.callTool('navigate', { tabId: action.tabId || undefined, direction: 'forward' });
          return this.captureAfterLiveAction(action.tabId || null);
        case 'inspect': {
          const inspected = await this.callTool<BrowserElementInspectionResponse>('inspect_at_point', {
            tabId: action.tabId || undefined,
            x: action.x,
            y: action.y,
          });
          const state = await this.captureState(inspected.tabId || action.tabId || null);
          const element = inspected.element || null;
          if (!element) {
            throw new Error('No element was found at the selected point');
          }

          let cropImageId: string | null = null;
          let cropUrl: string | null = null;
          const rect = element.rect && typeof element.rect === 'object' ? element.rect : null;
          const viewport = element.viewport && typeof element.viewport === 'object' ? element.viewport : null;
          if (rect && Number(rect.width) > 0 && Number(rect.height) > 0) {
            const padding = 12;
            const viewportWidth = Number(viewport?.width) || 1440;
            const viewportHeight = Number(viewport?.height) || 1200;
            const x0 = Math.max(0, Number(rect.x) - padding);
            const y0 = Math.max(0, Number(rect.y) - padding);
            const x1 = Math.min(viewportWidth, Number(rect.x) + Number(rect.width) + padding);
            const y1 = Math.min(viewportHeight, Number(rect.y) + Number(rect.height) + padding);
            try {
              const crop = await this.callTool<BrowserScreenshotResponse>('screenshot', {
                format: 'png',
                region: [x0, y0, x1, y1],
                tabId: inspected.tabId,
                timeout_ms: 20_000,
              });
              this.trackCapture(crop.imageId, crop.outputPath, true);
              cropImageId = crop.imageId;
              cropUrl = this.buildFrameUrl(crop.imageId);
            } catch {
              // The full frame is still a valid selection artifact if a tiny or transient node cannot be cropped.
            }
          }

          state.selection = {
            selectionId: randomUUID(),
            tabId: inspected.tabId,
            url: asUrl(inspected.currentUrl) || state.currentUrl,
            title: asTitle(inspected.title) || state.currentTitle,
            capturedAt: inspected.inspectedAt || new Date().toISOString(),
            screenshotImageId: state.frame?.imageId || null,
            screenshotUrl: state.frame?.imageUrl || null,
            cropImageId,
            cropUrl,
            element,
          };
          return state;
        }
        case 'key':
          await this.callTool('press_key', { key: action.key, tabId: action.tabId || undefined });
          return this.captureAfterLiveAction(action.tabId || null);
        case 'navigate':
          if (!normalizeViewerUrl(action.url)) {
            throw new Error('A valid URL is required for navigation');
          }
          await this.callTool('navigate', {
            tabId: action.tabId || undefined,
            url: normalizeViewerUrl(action.url),
            waitUntil: 'domcontentloaded',
          });
          return this.captureAfterLiveAction(action.tabId || null);
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
          return this.captureAfterLiveAction(action.tabId || null);
        case 'resize': {
          const resized = await this.callTool<{ tabId: number }>('resize_window', {
            tabId: action.tabId || undefined,
            width: action.width,
            height: action.height,
          });
          this.streamViewportByTab.set(resized.tabId, { height: action.height, width: action.width });
          this.streamVersionByTab.set(resized.tabId, (this.streamVersionByTab.get(resized.tabId) || 0) + 1);
          return this.captureState(resized.tabId);
        }
        case 'scroll':
          await this.callTool('scroll', {
            amount: action.amount || 900,
            direction: action.direction,
            tabId: action.tabId || undefined,
          });
          return this.captureAfterLiveAction(action.tabId || null);
        case 'switchTab':
          // A live-stream-only state sync does not touch Playwright's current
          // tab. Capture once so both the viewer and the AI MCP inherit the
          // exact tab the user selected.
          return this.captureState(action.tabId, true);
        case 'sync':
          return this.captureState(action.tabId || null, false);
        case 'type':
          await this.callTool('computer', {
            action: 'type',
            tabId: action.tabId || undefined,
            text: action.text,
          });
          return this.captureAfterLiveAction(action.tabId || null);
        default:
          throw new Error('Unsupported browser viewer action');
      }
    });
  }

  queueInput(input: BrowserViewerInput) {
    if (input.type === 'hover') {
      this.pendingHoverInput = input;
    } else if (this.pendingScrollInput && this.pendingScrollInput.tabId === input.tabId) {
      this.pendingScrollInput.deltaX = Math.max(-2_400, Math.min(2_400, this.pendingScrollInput.deltaX + input.deltaX));
      this.pendingScrollInput.deltaY = Math.max(-2_400, Math.min(2_400, this.pendingScrollInput.deltaY + input.deltaY));
    } else {
      this.pendingScrollInput = input;
    }

    if (!this.inputDrainActive) void this.drainQueuedInput();
  }

  private async drainQueuedInput() {
    if (this.inputDrainActive) return;
    this.inputDrainActive = true;
    try {
      while (this.pendingHoverInput || this.pendingScrollInput) {
        let input: BrowserViewerInput | null = null;
        if (this.inputDrainPreferScroll && this.pendingScrollInput) {
          input = this.pendingScrollInput;
          this.pendingScrollInput = null;
          this.inputDrainPreferScroll = false;
        } else if (this.pendingHoverInput) {
          input = this.pendingHoverInput;
          this.pendingHoverInput = null;
          this.inputDrainPreferScroll = true;
        } else if (this.pendingScrollInput) {
          input = this.pendingScrollInput;
          this.pendingScrollInput = null;
          this.inputDrainPreferScroll = false;
        }
        if (!input) continue;
        const queuedInput = input;

        await this.enqueue(async () => {
          await this.ensureReady();
          if (queuedInput.type === 'hover') {
            await this.callTool('computer', {
              action: 'hover',
              coordinate: [queuedInput.x, queuedInput.y],
              tabId: queuedInput.tabId || undefined,
            });
            return;
          }
          await this.callTool('computer', {
            action: 'wheel',
            delta_x: queuedInput.deltaX,
            delta_y: queuedInput.deltaY,
            tabId: queuedInput.tabId || undefined,
          });
        });
      }
    } catch (error: any) {
      console.warn('[browser-viewer-input] Browser input was skipped', {
        message: error?.message || 'unknown error',
      });
    } finally {
      this.inputDrainActive = false;
      if (this.pendingHoverInput || this.pendingScrollInput) void this.drainQueuedInput();
    }
  }

  async inspectAtPoint(x: number, y: number, tabId?: number | null): Promise<BrowserElementInspectionResponse> {
    return this.enqueue(async () => {
      await this.ensureReady();
      return this.callTool<BrowserElementInspectionResponse>('inspect_at_point', {
        tabId: tabId || undefined,
        x,
        y,
      });
    });
  }


  async readLiveFrame(
    tabId: number,
    afterSequence = 0,
    waitMs = 1_000,
  ): Promise<BrowserViewerLiveFrame | null> {
    this.resetIdleTimer();
    await this.ensureReady();
    let bridgeUrl = this.httpBridgeUrl;
    let bridgeToken = this.httpBridgeToken;
    if (!bridgeUrl) {
      const liveBridge = await this.resolveLiveBridge();
      if (!liveBridge) return null;
      bridgeUrl = liveBridge.url;
      bridgeToken = liveBridge.token;
      this.httpBridgeUrl = bridgeUrl;
      this.httpBridgeToken = bridgeToken;
    }

    const query = new URLSearchParams({
      after: String(Math.max(0, Math.round(afterSequence))),
      tabId: String(tabId),
      waitMs: String(Math.max(0, Math.min(5_000, Math.round(waitMs)))),
    });
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), Math.max(3_000, waitMs + 2_000));
    try {
      const response = await fetch(`${bridgeUrl}/viewer/frame?${query}`, {
        headers: bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {},
        signal: abortController.signal,
      });
      if (response.status === 204 || response.status === 404) return null;
      if (!response.ok) throw new Error(`Browser live frame bridge returned HTTP ${response.status}`);
      const sequenceHeader = response.headers.get('x-frame-sequence');
      const sequence = sequenceHeader ? Number(sequenceHeader) : Number.NaN;
      if (!Number.isFinite(sequence)) return null;
      const widthHeader = response.headers.get('x-frame-width');
      const heightHeader = response.headers.get('x-frame-height');
      const width = widthHeader ? Number(widthHeader) : Number.NaN;
      const height = heightHeader ? Number(heightHeader) : Number.NaN;
      return {
        capturedAt: response.headers.get('x-frame-captured-at'),
        data: Buffer.from(await response.arrayBuffer()),
        height: Number.isFinite(height) ? height : null,
        sequence,
        tabId,
        width: Number.isFinite(width) ? width : null,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async captureState(preferredTabId?: number | null, captureFrame = true): Promise<SessionBrowserViewerState> {
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
    let frame: BrowserFrameSummary | null = tabId ? this.latestFrameByTab.get(tabId) || null : null;

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
        if (captureFrame) {
          const screenshot = await this.callTool<BrowserScreenshotResponse>('screenshot', {
            format: 'jpeg',
            quality: 90,
            full_page: false,
            tabId,
            timeout_ms: 20_000,
          });
          this.trackCapture(screenshot.imageId, screenshot.outputPath);
          frame = {
            capturedAt: new Date().toISOString(),
            imageId: screenshot.imageId,
            imageUrl: this.buildFrameUrl(screenshot.imageId),
            streamUrl: screenshot.liveStreamAvailable === true ? this.buildStreamUrl(screenshot.tabId) : null,
            tabId: screenshot.tabId,
          };
          this.latestFrameByTab.set(screenshot.tabId, frame);
        }
      } catch (error: any) {
        const message = String(error?.message || error || '');
        if (!message.includes('captureScreenshot')) {
          throw error;
        }
      }
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

  private captureAfterLiveAction(tabId?: number | null) {
    const hasLiveFrame = typeof tabId === 'number'
      ? Boolean(this.latestFrameByTab.get(tabId)?.streamUrl)
      : [...this.latestFrameByTab.values()].some((frame) => Boolean(frame.streamUrl));
    return this.captureState(tabId || null, !hasLiveFrame);
  }

  private buildFrameUrl(imageId: string) {
    return `/api/codex/session-browser-viewer/frame?profileId=${encodeURIComponent(this.profileId)}&sessionKey=${encodeURIComponent(this.sessionKey)}&imageId=${encodeURIComponent(imageId)}`;
  }

  private buildStreamUrl(tabId: number) {
    const query = new URLSearchParams({
      profileId: this.profileId,
      sessionKey: this.sessionKey,
      tabId: String(tabId),
      version: String(this.streamVersionByTab.get(tabId) || 0),
    });
    const viewport = this.streamViewportByTab.get(tabId);
    if (viewport) {
      query.set('height', String(viewport.height));
      query.set('width', String(viewport.width));
    }
    return `/api/codex/session-browser-viewer/stream?${query}`;
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
      const liveBridge = await this.resolveLiveBridge();
      if (liveBridge) {
        this.httpBridgeUrl = liveBridge.url;
        this.httpBridgeToken = liveBridge.token;
        return;
      }
      this.httpBridgeUrl = null;
      this.httpBridgeToken = null;
    }

    if (this.process && this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      const liveBridge = await this.resolveLiveBridge();
      if (liveBridge) {
        this.httpBridgeUrl = liveBridge.url;
        this.httpBridgeToken = liveBridge.token;
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
        windowsHide: true,
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
      const spawnedBridge = await this.resolveLiveBridge();
      if (spawnedBridge) {
        this.httpBridgeUrl = spawnedBridge.url;
        this.httpBridgeToken = spawnedBridge.token;
      }
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
          ...(this.httpBridgeToken ? { Authorization: `Bearer ${this.httpBridgeToken}` } : {}),
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
      this.idleTimer = null;
    }
    if (this.runtimeLeaseCount > 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, VIEWER_IDLE_TTL_MS);
  }

  private async resolveLiveBridge(): Promise<BrowserHttpBridgeEndpoint | null> {
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

    const token = typeof parsed?.token === 'string' && parsed.token.trim()
      ? parsed.token.trim()
      : null;

    const response = await fetch(`${candidateUrl}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => null);
    if (!response?.ok) {
      return null;
    }

    const payload = await response.json().catch(() => null);
    if (payload?.ok !== true) {
      return null;
    }

    return { token, url: candidateUrl };
  }
}

const viewerByKey = new Map<string, BrowserViewerBridge>();
const viewerCreationBySessionDirectory = new Map<string, Promise<BrowserViewerBridge>>();

async function resolveViewerBridge(
  profile: CodexProfileConfig,
  sessionKey: string,
  stateProfileId = profile.id,
) {
  const record = await getSessionBrowserModeRecord(stateProfileId, sessionKey);
  if (!record || record.enabled !== true) {
    throw new Error('Browser mode is not enabled for this session');
  }

  const prepared = await prepareCodexBrowserModeForRun(profile, stateProfileId, sessionKey, record);
  if (!prepared) {
    throw new Error('Browser mode could not be prepared for this session');
  }

  const key = buildViewerKey(stateProfileId, sessionKey);
  const existing = viewerByKey.get(key);
  if (existing) {
    return existing;
  }

  // Draft Code-AI conversations are rebound to the real provider session after
  // their first turn. The browser-mode record intentionally keeps the same
  // persisted profile directory. Reuse the live bridge as well so logins,
  // tabs, page state, and the current selection survive that transition.
  const reboundEntry = [...viewerByKey.entries()].find(([, candidate]) => (
    candidate.matchesSessionDirectory(stateProfileId, prepared.mode.sessionDir)
  ));
  if (reboundEntry) {
    const [previousKey, reboundBridge] = reboundEntry;
    viewerByKey.delete(previousKey);
    reboundBridge.rebindSessionKey(sessionKey);
    viewerByKey.set(key, reboundBridge);
    return reboundBridge;
  }

  const sessionDirectoryKey = `${stateProfileId}:${prepared.mode.sessionDir}`;
  let creation = viewerCreationBySessionDirectory.get(sessionDirectoryKey);
  if (!creation) {
    creation = (async () => {
      const existingAfterLock = viewerByKey.get(key);
      if (existingAfterLock) return existingAfterLock;
      const reboundAfterLock = [...viewerByKey.values()].find((candidate) => (
        candidate.matchesSessionDirectory(stateProfileId, prepared.mode.sessionDir)
      ));
      if (reboundAfterLock) return reboundAfterLock;
      const launch = await buildBrowserModeRuntimeLaunch(prepared.mode);
      return new BrowserViewerBridge(stateProfileId, sessionKey, prepared.mode, launch);
    })();
    viewerCreationBySessionDirectory.set(sessionDirectoryKey, creation);
  }

  try {
    const bridge = await creation;
    for (const [candidateKey, candidate] of viewerByKey.entries()) {
      if (candidate === bridge && candidateKey !== key) viewerByKey.delete(candidateKey);
    }
    bridge.rebindSessionKey(sessionKey);
    viewerByKey.set(key, bridge);
    return bridge;
  } finally {
    if (viewerCreationBySessionDirectory.get(sessionDirectoryKey) === creation) {
      viewerCreationBySessionDirectory.delete(sessionDirectoryKey);
    }
  }
}

export async function acquireSessionBrowserRuntime(
  profile: CodexProfileConfig,
  stateProfileId: string,
  sessionKey: string,
): Promise<() => void> {
  const bridge = await resolveViewerBridge(profile, sessionKey, stateProfileId);
  await bridge.acquireRuntimeLease();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bridge.releaseRuntimeLease();
  };
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

export async function queueSessionBrowserViewerInput(
  profile: CodexProfileConfig,
  sessionKey: string,
  input: BrowserViewerInput,
) {
  const bridge = viewerByKey.get(buildViewerKey(profile.id, sessionKey))
    || await resolveViewerBridge(profile, sessionKey);
  bridge.queueInput(input);
}

export async function inspectSessionBrowserViewerPoint(
  profile: CodexProfileConfig,
  sessionKey: string,
  x: number,
  y: number,
  tabId?: number | null,
) {
  const bridge = await resolveViewerBridge(profile, sessionKey);
  return bridge.inspectAtPoint(x, y, tabId);
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

export async function readSessionBrowserViewerLiveFrame(
  profile: CodexProfileConfig,
  sessionKey: string,
  tabId: number,
  afterSequence = 0,
  waitMs = 1_000,
) {
  const bridge = await resolveViewerBridge(profile, sessionKey);
  return bridge.readLiveFrame(tabId, afterSequence, waitMs);
}

export async function openSessionBrowserViewerLiveFrameReader(
  profile: CodexProfileConfig,
  sessionKey: string,
) {
  const bridge = await resolveViewerBridge(profile, sessionKey);
  return {
    read(tabId: number, afterSequence = 0, waitMs = 1_000) {
      return bridge.readLiveFrame(tabId, afterSequence, waitMs);
    },
  };
}
