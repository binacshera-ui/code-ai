import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  buildBrowserModeMcpProxyLaunch,
  deleteSessionBrowserMode,
  getSessionBrowserModeRecord,
  rebindSessionBrowserMode,
  setSessionBrowserMode,
} from '../server/codexBrowserMode.js';
import {
  closeSessionBrowserViewer,
  inspectSessionBrowserViewerPoint,
  openSessionBrowserViewer,
  performSessionBrowserViewerAction,
  queueSessionBrowserViewerInput,
  readSessionBrowserViewerLiveFrame,
  syncSessionBrowserViewerBinaAuth,
} from '../server/codexBrowserViewer.js';
import { CODEX_APP_CONFIG } from '../server/config.js';

const profile = CODEX_APP_CONFIG.profiles.find((candidate) => (
  candidate.provider === 'codex' && candidate.mode !== 'support' && candidate.mode !== 'agent'
));

if (!profile) {
  throw new Error('A standard Codex profile is required for the Workbench runtime smoke test');
}

const token = randomUUID();
const draftKey = `draft:workbench-smoke-${token}`;
const sessionKey = `ses_workbench-smoke-${token}`;
let sessionDir: string | null = null;
let proxyProcess: ChildProcessWithoutNullStreams | null = null;

async function countDirectRuntimeProcesses(profileDir: string) {
  const entries = await fs.readdir('/proc', { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const commandLine = await fs.readFile(`/proc/${entry.name}/cmdline`).catch(() => null);
    if (!commandLine) continue;
    const args = commandLine.toString('utf-8').split('\0');
    const profileIndex = args.indexOf('--profile-dir');
    if (
      profileIndex >= 0
      && args[profileIndex + 1] === profileDir
      && args.some((argument) => argument.endsWith('/browser_mode_mcp_server.py'))
    ) {
      count += 1;
    }
  }
  return count;
}

async function openMcpProxy(record: NonNullable<Awaited<ReturnType<typeof getSessionBrowserModeRecord>>>) {
  const launch = await buildBrowserModeMcpProxyLaunch(record);
  const child = spawn(launch.command, launch.args, {
    cwd: CODEX_APP_CONFIG.appRoot,
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proxyProcess = child;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; result?: any; error?: { message?: string } };
      if (typeof message.id !== 'number') continue;
      const call = pending.get(message.id);
      if (!call) continue;
      clearTimeout(call.timeoutId);
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message || 'MCP proxy request failed'));
      else call.resolve(message.result);
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`MCP proxy exited (${code ?? signal ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`);
    for (const call of pending.values()) {
      clearTimeout(call.timeoutId);
      call.reject(error);
    }
    pending.clear();
  });

  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP proxy timeout for ${method}`));
    }, 20_000);
    pending.set(id, { resolve, reject, timeoutId });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  await request('initialize', {
    capabilities: {},
    clientInfo: { name: 'workbench-shared-runtime-smoke', version: '1.0.0' },
    protocolVersion: '2025-11-25',
  });
  return {
    async callTool(name: string, argumentsValue: Record<string, unknown>) {
      const response = await request('tools/call', { name, arguments: argumentsValue });
      assert.equal(response.isError, false, `MCP proxy tool ${name} should succeed`);
      return response.structuredContent as Record<string, any>;
    },
    close() {
      child.stdin.end();
      proxyProcess = null;
    },
  };
}

try {
  await setSessionBrowserMode(profile.id, draftKey, {
    enabled: true,
    headless: true,
    profileSeed: 'empty',
    customProfileDir: null,
  });

  const sourceHtml = `<!doctype html><html><head><style>
    body { min-height: 3000px; }
    #workbench-name:hover { width: 340px !important; }
  </style></head><body>
    <input
      id="workbench-name"
      aria-label="Workbench name"
      data-code-ai-source="src/WorkbenchForm.tsx:18:5"
      data-component="WorkbenchName"
      style="position:fixed;left:40px;top:40px;width:260px;height:40px"
    />
    <output id="live-frame-clock" style="position:fixed;left:360px;top:40px">0</output>
    <script>
      let liveFrameTick = 0;
      setInterval(() => { document.querySelector('#live-frame-clock').textContent = String(++liveFrameTick); }, 80);
    </script>
  </body></html>`;
  const initialUrl = `data:text/html;charset=utf-8,${encodeURIComponent(sourceHtml)}`;
  const concurrentlyOpened = await Promise.all(Array.from({ length: 8 }, () => (
    openSessionBrowserViewer(profile, draftKey, initialUrl)
  )));
  const initial = concurrentlyOpened[0];
  assert.ok(initial.currentTabId, 'the draft viewer should have an active tab');
  assert.ok(initial.frame?.imageUrl, 'the draft viewer should produce a frame');
  assert.ok(initial.frame?.streamUrl, 'the draft viewer should expose a live Chromium stream');
  assert.ok(
    concurrentlyOpened.every((viewer) => viewer.currentTabId === initial.currentTabId && viewer.profileDir === initial.profileDir),
    'parallel viewer opens should resolve to one browser owner',
  );
  assert.equal(
    await countDirectRuntimeProcesses(initial.profileDir),
    1,
    'parallel viewer opens must launch exactly one direct Chromium runtime',
  );
  const firstLiveFrame = await readSessionBrowserViewerLiveFrame(
    profile,
    draftKey,
    initial.currentTabId,
    0,
    3_000,
  );
  assert.ok(firstLiveFrame, 'the Chromium bridge should produce a live frame');
  assert.ok(firstLiveFrame.data.length > 1_000, 'the live frame should contain a real JPEG payload');
  assert.equal(firstLiveFrame.width, 1440, 'the live frame should preserve the browser viewport width');
  const nextLiveFrame = await readSessionBrowserViewerLiveFrame(
    profile,
    draftKey,
    initial.currentTabId,
    firstLiveFrame.sequence,
    3_000,
  );
  assert.ok(nextLiveFrame, 'the Chromium bridge should continue producing live frames');
  assert.ok(nextLiveFrame.sequence > firstLiveFrame.sequence, 'live frame sequences should advance');
  const secondTabUrl = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Second persisted tab</title><p>second</p>')}`;
  const withSecondTab = await performSessionBrowserViewerAction(profile, draftKey, {
    type: 'newTab',
    url: secondTabUrl,
  });
  assert.equal(withSecondTab.tabs.length, 2, 'the session should expose both Chromium tabs');
  await performSessionBrowserViewerAction(profile, draftKey, {
    type: 'switchTab',
    tabId: initial.currentTabId,
  });
  await performSessionBrowserViewerAction(profile, draftKey, {
    type: 'click',
    tabId: initial.currentTabId,
    x: 100,
    y: 60,
  });
  await performSessionBrowserViewerAction(profile, draftKey, {
    type: 'type',
    tabId: initial.currentTabId,
    text: 'state-survives-draft-rebind',
  });

  const beforeRecord = await getSessionBrowserModeRecord(profile.id, draftKey);
  assert.ok(beforeRecord, 'the draft browser-mode record should exist');
  sessionDir = beforeRecord.sessionDir;

  const bridgeInfoPath = `${beforeRecord.sessionDir}/browser-http-bridge.json`;
  const bridgeInfo = JSON.parse(await fs.readFile(bridgeInfoPath, 'utf-8')) as { token?: string; url?: string };
  assert.ok(bridgeInfo.url, 'the runtime should publish a loopback bridge URL');
  assert.ok(bridgeInfo.token && bridgeInfo.token.length >= 32, 'the loopback bridge should require an opaque token');
  const bridgeMode = (await fs.stat(bridgeInfoPath)).mode & 0o777;
  assert.equal(bridgeMode, 0o600, 'the bridge discovery file must be owner-only');
  const unauthorizedHealth = await fetch(`${bridgeInfo.url}/health`);
  assert.equal(unauthorizedHealth.status, 401, 'the loopback bridge must reject unauthenticated callers');
  const authorizedHealth = await fetch(`${bridgeInfo.url}/health`, {
    headers: { Authorization: `Bearer ${bridgeInfo.token}` },
  });
  assert.equal(authorizedHealth.status, 200, 'the loopback bridge should accept its runtime token');

  const connectedBinaSession = await syncSessionBrowserViewerBinaAuth(
    profile,
    draftKey,
    {
      forumSession: 's%3Aworkbench-smoke.fake-signature-value',
      runtimeSession: '13f56d50-b54f-4ca2-921f-07c18deaf437',
    },
  );
  assert.equal(connectedBinaSession.connected, true, 'the private viewer control should install a Bina session');
  assert.equal(connectedBinaSession.runtimeConnected, true, 'the private viewer control should install the BST runtime session');
  const clearedBinaSession = await syncSessionBrowserViewerBinaAuth(profile, draftKey, {
    forumSession: null,
    runtimeSession: null,
  });
  assert.equal(clearedBinaSession.connected, false, 'the private viewer control should clear a Bina session');

  await rebindSessionBrowserMode(profile.id, draftKey, sessionKey);
  const rebound = await openSessionBrowserViewer(profile, sessionKey, null);
  assert.equal(rebound.profileDir, initial.profileDir, 'the persisted Chromium profile must survive rebind');
  assert.equal(rebound.currentTabId, initial.currentTabId, 'the active browser tab must survive rebind');
  assert.equal(rebound.currentUrl, initial.currentUrl, 'the active page must survive rebind without reload');
  assert.equal(rebound.sessionKey, sessionKey, 'new frame URLs must use the real session key');

  const reboundRecord = await getSessionBrowserModeRecord(profile.id, sessionKey);
  assert.ok(reboundRecord, 'the rebound browser-mode record should exist');
  const mcpProxy = await openMcpProxy(reboundRecord);
  const proxyTabs = await mcpProxy.callTool('tabs_context', {});
  assert.equal(proxyTabs.currentTabId, rebound.currentTabId, 'the AI MCP must attach to the exact visible tab');
  assert.equal(
    proxyTabs.tabs.find((tab: { tabId: number }) => tab.tabId === rebound.currentTabId)?.url,
    rebound.currentUrl,
    'the AI MCP and the viewer must report the same active page',
  );
  const pageStateAfterRebind = await mcpProxy.callTool('run_js', {
    tabId: rebound.currentTabId,
    code: `return document.querySelector('#workbench-name').value;`,
  });
  assert.equal(
    pageStateAfterRebind.result,
    'state-survives-draft-rebind',
    'draft-to-session binding must not reload the visible page',
  );
  await mcpProxy.callTool('run_js', {
    tabId: rebound.currentTabId,
    code: `document.querySelector('#workbench-name').setAttribute('aria-label', 'Shared AI and viewer runtime'); return document.querySelector('#workbench-name').getAttribute('aria-label');`,
  });
  const sharedRuntimeInspection = await inspectSessionBrowserViewerPoint(
    profile,
    sessionKey,
    100,
    60,
    rebound.currentTabId,
  );
  assert.equal(
    sharedRuntimeInspection.element?.accessibleName,
    'Shared AI and viewer runtime',
    'a DOM change made through the AI MCP must be immediately visible through the viewer bridge',
  );
  mcpProxy.close();

  await queueSessionBrowserViewerInput(profile, sessionKey, {
    type: 'hover',
    tabId: rebound.currentTabId,
    x: 100,
    y: 60,
  });
  const hoveredInspection = await inspectSessionBrowserViewerPoint(profile, sessionKey, 100, 60, rebound.currentTabId);
  assert.ok(
    Number(hoveredInspection.element?.rect?.width) >= 330,
    'queued pointer movement should activate the real Chromium :hover state',
  );

  await queueSessionBrowserViewerInput(profile, sessionKey, {
    type: 'scroll',
    tabId: rebound.currentTabId,
    deltaX: 0,
    deltaY: 520,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const scrolledInspection = await inspectSessionBrowserViewerPoint(profile, sessionKey, 500, 500, rebound.currentTabId);
  assert.ok(
    Number(scrolledInspection.element?.viewport?.scrollY) > 0,
    'queued wheel input should scroll the page without a screenshot action',
  );

  const inspected = await performSessionBrowserViewerAction(profile, sessionKey, {
    type: 'inspect',
    tabId: rebound.currentTabId,
    x: 100,
    y: 60,
  });
  assert.equal(inspected.selection?.element?.tagName, 'input');
  assert.equal(inspected.selection?.element?.sourceHint?.file, 'src/WorkbenchForm.tsx');
  assert.ok(inspected.selection?.cropUrl, 'the selected element should have a crop artifact');

  const tabUrlsBeforeRuntimeRestart = rebound.tabs.map((tab) => tab.url);
  await closeSessionBrowserViewer(profile.id, sessionKey);
  const tabStateMode = (await fs.stat(`${reboundRecord.sessionDir}/browser-tab-state.json`)).mode & 0o777;
  assert.equal(tabStateMode, 0o600, 'the persisted tab state must be owner-only');
  const restarted = await openSessionBrowserViewer(profile, sessionKey, null);
  assert.equal(restarted.currentUrl, rebound.currentUrl, 'the active page must survive a browser runtime restart');
  assert.deepEqual(
    restarted.tabs.map((tab) => tab.url),
    tabUrlsBeforeRuntimeRestart,
    'the session tab set must survive a browser runtime restart',
  );

  console.log(JSON.stringify({
    ok: true,
    profileId: profile.id,
    rebindPreservedProfile: true,
    rebindPreservedTab: true,
    rebindPreservedUrl: true,
    rebindPreservedInMemoryPageState: true,
    elementInspection: true,
    cropArtifact: true,
    privateBinaSessionControl: true,
    bridgeAuthentication: true,
    bridgeFileOwnerOnly: true,
    concurrentViewerOpenSingleFlight: true,
    aiMcpSharesVisibleRuntime: true,
    aiMcpSharesVisibleTab: true,
    runtimeRestartPreservesActivePage: true,
    runtimeRestartPreservesTabs: true,
    runtimeRestartPreservesMultipleTabs: true,
    tabStateFileOwnerOnly: true,
    chromiumLiveFrame: true,
    chromiumLiveStreamUrl: true,
    chromiumHoverInput: true,
    chromiumWheelInput: true,
  }));
} finally {
  if (proxyProcess && !proxyProcess.killed) proxyProcess.kill('SIGTERM');
  await closeSessionBrowserViewer(profile.id, sessionKey).catch(() => undefined);
  await closeSessionBrowserViewer(profile.id, draftKey).catch(() => undefined);
  await deleteSessionBrowserMode(profile.id, sessionKey).catch(() => undefined);
  await deleteSessionBrowserMode(profile.id, draftKey).catch(() => undefined);
  if (sessionDir) await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
}
