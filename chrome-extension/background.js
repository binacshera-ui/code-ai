const PROTOCOL_VERSION = 1;
const STORAGE_KEY = 'codeAiPersonalChromeSettings';
const AUTH_RULE_ID = 9001;
const FRAME_RULE_ID = 9002;
const consoleByTab = new Map();
const networkByTab = new Map();
const requestByTab = new Map();
const attachedTabs = new Set();
const selections = new Map();
const pendingPickers = new Map();
const sessionSyncs = new Map();
let settings = null;
let socket = null;
let connected = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
const pendingApprovals = [];

function errorWithCode(message, code = 'COMMAND_FAILED', details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function safeUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw errorWithCode('The URL is invalid.', 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw errorWithCode('Only http and https URLs are supported.', 'UNSUPPORTED_URL');
  return url.href;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settings = stored[STORAGE_KEY] || null;
  return settings;
}

async function storeSettings(next) {
  settings = next;
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  await installAuthRules(next);
}

async function installAuthRules(next) {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [AUTH_RULE_ID, FRAME_RULE_ID] });
  if (!next?.controlOrigin) return;
  const origin = new URL(next.controlOrigin);
  const requestDomains = [origin.hostname];
  const addRules = [
    {
      id: FRAME_RULE_ID, priority: 10,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { requestDomains, initiatorDomains: [chrome.runtime.id], resourceTypes: ['sub_frame'] },
    },
  ];
  if (next.deviceId && next.deviceToken) {
    addRules.unshift({
      id: AUTH_RULE_ID, priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'x-code-ai-extension-device', operation: 'set', value: next.deviceId },
          { header: 'x-code-ai-extension-token', operation: 'set', value: next.deviceToken },
        ],
      },
      condition: {
        requestDomains,
        initiatorDomains: [chrome.runtime.id, origin.hostname],
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'other'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules,
  });
}

function socketUrl() {
  const url = new URL(settings.controlOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/codex/browser-extension/socket';
  url.search = '';
  return url.href;
}

function broadcast(message) {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function statusSnapshot() {
  return {
    paired: Boolean(settings?.deviceId && settings?.deviceToken),
    connected,
    deviceId: settings?.deviceId || null,
    deviceName: settings?.deviceName || null,
    controlOrigin: settings?.controlOrigin || null,
  };
}

function broadcastStatus() {
  broadcast({ type: 'BRIDGE_STATUS', status: statusSnapshot() });
}

function currentApproval() {
  return pendingApprovals[0] || null;
}

function clearPendingApprovals() {
  pendingApprovals.splice(0, pendingApprovals.length);
  broadcast({ type: 'APPROVAL_REQUEST', approval: null });
}

function sendSocket(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw errorWithCode('Personal Chrome bridge is offline.', 'DEVICE_OFFLINE');
  socket.send(JSON.stringify(message));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!settings?.deviceToken) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(5, reconnectAttempt++));
  reconnectTimer = setTimeout(connectBridge, delay);
}

function connectBridge() {
  clearTimeout(reconnectTimer);
  if (!settings?.deviceToken || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  try { socket = new WebSocket(socketUrl()); } catch { scheduleReconnect(); return; }
  socket.addEventListener('open', () => {
    sendSocket({
      type: 'auth', version: PROTOCOL_VERSION, deviceId: settings.deviceId, token: settings.deviceToken,
      extensionId: chrome.runtime.id, userAgent: navigator.userAgent,
    });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'auth_ok') {
      connected = true; reconnectAttempt = 0; broadcastStatus();
      sendSocket({ type: 'event', version: PROTOCOL_VERSION, name: 'capabilities', payload: [
        'tabs', 'scripting', 'debugger', 'dom-selection', 'region-selection', 'screenshot', 'console', 'network', 'side-panel',
      ] });
      return;
    }
    if (message.type === 'ping') {
      sendSocket({ type: 'event', version: PROTOCOL_VERSION, name: 'heartbeat', payload: { at: new Date().toISOString() } });
      return;
    }
    if (message.type === 'approval_request') {
      if (!pendingApprovals.some((approval) => approval.approvalId === message.approvalId)) pendingApprovals.push(message);
      if (currentApproval()?.approvalId === message.approvalId) broadcast({ type: 'APPROVAL_REQUEST', approval: message });
      void chrome.notifications.create(`code-ai-approval-${message.approvalId}`, {
        type: 'basic', iconUrl: 'icon-128.png', title: 'CODE-AI מבקש אישור', message: message.description || 'פתח את Side Panel כדי לאשר.', priority: 1,
      }).catch(() => undefined);
      return;
    }
    if (message.type === 'command') void runCommand(message);
  });
  socket.addEventListener('close', () => {
    connected = false; socket = null; clearPendingApprovals(); broadcastStatus(); scheduleReconnect();
  });
  socket.addEventListener('error', () => socket?.close());
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw errorWithCode('No active Chrome tab was found.', 'TAB_NOT_BOUND');
  return tab;
}

async function resolveTab(args = {}) {
  const explicit = Number(args.tabId);
  if (Number.isInteger(explicit) && explicit >= 0) {
    const tab = await chrome.tabs.get(explicit).catch(() => null);
    if (!tab) throw errorWithCode(`Chrome tab ${explicit} no longer exists.`, 'TAB_NOT_BOUND');
    return tab;
  }
  return activeTab();
}

function assertScriptable(tab) {
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw errorWithCode('Chrome internal pages cannot be automated by extensions.', 'UNSUPPORTED_PAGE');
  }
}

async function execute(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (!results?.length) throw errorWithCode('The page did not return a script result.', 'UNSUPPORTED_PAGE');
  return results[0].result;
}

async function debuggerCommand(tabId, method, params = {}) {
  if (!attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedTabs.add(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 2_000_000 });
    } catch (error) {
      throw errorWithCode(`Could not attach Chrome DevTools to tab ${tabId}: ${error.message || error}`, 'DEBUGGER_BUSY');
    }
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function pushRing(map, tabId, value, max = 1000) {
  const ring = map.get(tabId) || [];
  ring.push(value);
  if (ring.length > max) ring.splice(0, ring.length - max);
  map.set(tabId, ring);
}

function remoteValue(value) {
  if (!value || typeof value !== 'object') return value;
  if ('value' in value) return value.value;
  if (value.unserializableValue) return value.unserializableValue;
  return value.description || value.type || null;
}

function redactHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = /authorization|cookie|token|secret|api[-_]?key/i.test(key) ? '[REDACTED]' : String(value).slice(0, 2000);
  }
  return result;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;
  if (method === 'Runtime.consoleAPICalled') {
    pushRing(consoleByTab, tabId, { at: new Date((params.timestamp || Date.now() / 1000) * 1000).toISOString(), level: params.type, text: (params.args || []).map(remoteValue).map(String).join(' ').slice(0, 10000), stack: params.stackTrace || null });
  } else if (method === 'Log.entryAdded') {
    pushRing(consoleByTab, tabId, { at: new Date(params.entry?.timestamp || Date.now()).toISOString(), level: params.entry?.level || 'log', text: String(params.entry?.text || '').slice(0, 10000), url: params.entry?.url || null, lineNumber: params.entry?.lineNumber || null });
  } else if (method === 'Network.requestWillBeSent') {
    const requestMap = requestByTab.get(tabId) || new Map();
    requestMap.set(params.requestId, {
      requestId: params.requestId, at: new Date((params.timestamp || Date.now() / 1000) * 1000).toISOString(),
      url: params.request?.url, method: params.request?.method, resourceType: params.type,
      requestHeaders: redactHeaders(params.request?.headers), status: null, mimeType: null, responseHeaders: null,
    });
    requestByTab.set(tabId, requestMap);
  } else if (method === 'Network.responseReceived') {
    const requestMap = requestByTab.get(tabId) || new Map();
    const entry = requestMap.get(params.requestId) || { requestId: params.requestId, at: new Date().toISOString(), url: params.response?.url };
    Object.assign(entry, { status: params.response?.status, statusText: params.response?.statusText, mimeType: params.response?.mimeType, protocol: params.response?.protocol, fromDiskCache: params.response?.fromDiskCache, responseHeaders: redactHeaders(params.response?.headers), resourceType: params.type });
    requestMap.set(params.requestId, entry); requestByTab.set(tabId, requestMap);
    pushRing(networkByTab, tabId, entry);
  }
});

chrome.debugger.onDetach.addListener((source) => { if (source.tabId) attachedTabs.delete(source.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attachedTabs.delete(tabId); consoleByTab.delete(tabId); networkByTab.delete(tabId); requestByTab.delete(tabId); for (const [id, selection] of selections) if (selection.tabId === tabId) selections.delete(id); });

function resolveTarget(selectionId, selector, tabId) {
  if (selectionId) {
    const selection = selections.get(selectionId);
    if (!selection || selection.tabId !== tabId) throw errorWithCode('The selected element is stale; inspect it again.', 'STALE_ELEMENT');
    return selection.payload.selector || null;
  }
  return selector || null;
}

async function inspectSelector(tab, selector) {
  assertScriptable(tab);
  return execute(tab.id, (css) => {
    const element = document.querySelector(css);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    return {
      kind: 'element', selector: css, role: element.getAttribute('role') || element.localName,
      name: element.getAttribute('aria-label') || element.getAttribute('title') || text.slice(0, 160), text,
      tagName: element.tagName.toLowerCase(), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, outerHTML: element.outerHTML.slice(0, 3000),
      url: location.href, title: document.title,
    };
  }, [selector]);
}

async function startPicker(tab, mode, prompt, timeoutMs = 60000) {
  assertScriptable(tab);
  await ensurePickerContentScript(tab.id);
  const requestId = crypto.randomUUID();
  const acknowledgement = await chrome.tabs.sendMessage(tab.id, {
    type: 'CODE_AI_PICKER_START', requestId, mode, prompt,
  }).catch((error) => {
    throw errorWithCode(
      `לא ניתן לפתוח את בורר הרכיבים בטאב הזה: ${error?.message || error}`,
      'CONTENT_SCRIPT_UNAVAILABLE',
    );
  });
  if (!acknowledgement?.ok) {
    throw errorWithCode('הדף לא אישר את פתיחת בורר הרכיבים.', 'CONTENT_SCRIPT_UNAVAILABLE');
  }
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingPickers.delete(requestId); reject(errorWithCode('Visual selection timed out.', 'TIMEOUT')); }, Math.min(120000, Math.max(5000, timeoutMs)));
    pendingPickers.set(requestId, { resolve, reject, timer, tabId: tab.id });
  });
  return promise;
}

async function ensurePickerContentScript(tabId) {
  const ping = async () => chrome.tabs.sendMessage(tabId, { type: 'CODE_AI_PICKER_PING' })
    .then((response) => response?.ready === true)
    .catch(() => false);
  if (await ping()) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  throw errorWithCode('הדף לא קיבל את רכיב הבחירה של CODE-AI. רענן את הטאב ונסה שוב.', 'CONTENT_SCRIPT_UNAVAILABLE');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CODE_AI_PICKER_RESULT') {
    const pending = pendingPickers.get(message.requestId);
    if (!pending || sender.tab?.id !== pending.tabId) return;
    clearTimeout(pending.timer); pendingPickers.delete(message.requestId);
    if (message.error || !message.payload) pending.reject(errorWithCode(message.error || 'Selection cancelled.', 'SELECTION_CANCELLED'));
    else {
      const selectionId = crypto.randomUUID();
      const selection = { selectionId, tabId: pending.tabId, createdAt: new Date().toISOString(), payload: message.payload };
      selections.set(selectionId, selection);
      pending.resolve({ ...message.payload, selectionId });
      broadcast({ type: 'SELECTION_COMPLETE', selection: { ...message.payload, selectionId } });
    }
    return;
  }
  if (message?.type === 'PANEL_GET_STATE') {
    sendResponse({ ...statusSnapshot(), settings, pendingApproval: currentApproval() });
    return;
  }
  if (message?.type === 'PANEL_CONFIGURE_ORIGIN') {
    void configureControlOrigin(message.controlOrigin)
      .then(() => sendResponse({ ok: true, ...statusSnapshot(), settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'ENROLL_DEVICE') {
    void enrollDevice(message)
      .then((value) => sendResponse({ ok: true, settings: value, ...statusSnapshot() }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'SYNC_ACTIVE_SESSION') {
    void syncActiveSession(message.context)
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error), code: error.code || 'SYNC_FAILED' }));
    return true;
  }
  if (message?.type === 'PAIR_DEVICE') {
    void pairDevice(message).then((value) => sendResponse({ ok: true, settings: value })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'UNPAIR_DEVICE') {
    void unpairDevice().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'APPROVAL_RESPONSE') {
    const approvalIndex = pendingApprovals.findIndex((approval) => approval.approvalId === message.approvalId);
    if (approvalIndex >= 0) pendingApprovals.splice(approvalIndex, 1);
    try { sendSocket({ type: 'approval_response', version: PROTOCOL_VERSION, approvalId: message.approvalId, approved: message.approved === true }); } catch {}
    const pendingApproval = currentApproval();
    broadcast({ type: 'APPROVAL_REQUEST', approval: pendingApproval });
    sendResponse({ ok: true, pendingApproval });
    return;
  }
  if (message?.type === 'PANEL_PICK') {
    void activeTab().then((tab) => startPicker(tab, message.mode, message.mode === 'region_picker' ? 'בחר אזור עבור CODE-AI' : 'בחר רכיב עבור CODE-AI')).then((selection) => sendResponse({ ok: true, selection })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function pairDevice(input) {
  const parsedControlOrigin = new URL(String(input.controlOrigin || ''));
  if (!['http:', 'https:'].includes(parsedControlOrigin.protocol)) throw new Error('כתובת CODE-AI חייבת להשתמש ב־http או https.');
  const controlOrigin = parsedControlOrigin.origin;
  const response = await fetch(`${controlOrigin}/api/codex/browser-extension/pairing/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: input.code, deviceName: String(input.deviceName || '').trim() || 'Chrome במחשב האישי',
      extensionId: chrome.runtime.id, platform: navigator.platform, browserVersion: navigator.userAgent,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Pairing failed (${response.status})`);
  const next = { controlOrigin, deviceName: payload.device?.name || input.deviceName, deviceId: payload.deviceId, deviceToken: payload.deviceToken };
  await storeSettings(next); connectBridge(); return next;
}

async function configureControlOrigin(rawOrigin) {
  const parsed = new URL(String(rawOrigin || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('כתובת CODE-AI חייבת להשתמש ב־http או https.');
  const controlOrigin = parsed.origin;
  if (settings?.controlOrigin === controlOrigin) {
    await installAuthRules(settings);
    return settings;
  }
  if (settings?.deviceToken) {
    throw new Error('כתובת CODE-AI של המכשיר המחובר אינה תואמת לחבילת התוסף. אפס את אישור המכשיר תחילה.');
  }
  const next = { controlOrigin, deviceName: settings?.deviceName || 'Chrome במחשב האישי' };
  await storeSettings(next);
  return next;
}

async function enrollDevice(input) {
  await configureControlOrigin(input.controlOrigin);
  const controlOrigin = settings.controlOrigin;
  const response = await fetch(`${controlOrigin}/api/codex/browser-extension/enrollment/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentToken: input.enrollmentToken,
      deviceName: String(input.deviceName || settings.deviceName || '').trim() || 'Chrome במחשב האישי',
      extensionId: chrome.runtime.id,
      platform: navigator.platform,
      browserVersion: navigator.userAgent,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Device enrollment failed (${response.status})`);
  const next = {
    controlOrigin,
    deviceName: payload.device?.name || input.deviceName || settings.deviceName,
    deviceId: payload.deviceId,
    deviceToken: payload.deviceToken,
  };
  await storeSettings(next);
  connectBridge();
  broadcastStatus();
  return next;
}

async function controlRequest(pathname, init = {}, serverId = 'local') {
  if (!settings?.deviceId || !settings?.deviceToken || !settings?.controlOrigin) {
    throw errorWithCode('יש לאשר את המכשיר פעם אחת לפני חיבור כלי הדפדפן.', 'DEVICE_NOT_ENROLLED');
  }
  const headers = new Headers(init.headers || {});
  headers.set('x-code-ai-extension-device', settings.deviceId);
  headers.set('x-code-ai-extension-token', settings.deviceToken);
  if (serverId && serverId !== 'local') headers.set('x-code-ai-server-id', serverId);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${settings.controlOrigin}${pathname}`, { ...init, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { error: await response.text().catch(() => '') };
  if (!response.ok) throw errorWithCode(payload.error || `CODE-AI request failed (${response.status})`, 'CONTROL_REQUEST_FAILED', { status: response.status });
  return payload;
}

async function syncActiveSession(context) {
  if (!context?.authenticated || !context?.deviceUnlocked || context.provider !== 'codex') {
    return { skipped: true, reason: 'inactive_context' };
  }
  const profileId = String(context.profileId || '').trim();
  const sessionKey = String(context.sessionKey || '').trim();
  const serverId = String(context.serverId || 'local').trim().toLowerCase() || 'local';
  if (!profileId || !sessionKey) return { skipped: true, reason: 'missing_session' };
  const syncKey = `${serverId}:${profileId}:${sessionKey}:${settings?.deviceId || ''}`;
  if (sessionSyncs.has(syncKey)) return sessionSyncs.get(syncKey);
  const operation = (async () => {
    const query = `?profileId=${encodeURIComponent(profileId)}&sessionKey=${encodeURIComponent(sessionKey)}`;
    const currentPayload = await controlRequest(`/api/codex/session-personal-chrome-mode${query}`, {}, serverId);
    const current = currentPayload.personalChromeMode || {};
    if (current.enabled === true && current.deviceId === settings.deviceId && current.bindingId) {
      return { skipped: false, reused: true, serverId, profileId, sessionKey, personalChromeMode: current };
    }

    const bindingPayload = await controlRequest('/api/codex/browser-extension/bindings', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: settings.deviceId,
        profileId,
        sessionKey,
        scopes: ['read', 'write', 'javascript', 'upload', 'ports'],
        approvalPolicy: 'risky',
      }),
    });
    const bindingId = bindingPayload.binding?.id;
    try {
      const savedPayload = await controlRequest('/api/codex/session-personal-chrome-mode', {
        method: 'POST',
        body: JSON.stringify({
          profileId,
          sessionKey,
          personalChromeMode: {
            enabled: true,
            deviceId: settings.deviceId,
            deviceName: settings.deviceName || 'Chrome במחשב האישי',
            tabId: null,
            approvalPolicy: 'risky',
            allowJavascript: true,
            allowUploads: true,
            allowPorts: true,
            bindingId,
            bindingToken: bindingPayload.bindingToken,
            controlUrl: bindingPayload.controlUrl || settings.controlOrigin,
          },
        }),
      }, serverId);
      if (current.bindingId && current.bindingId !== bindingId) {
        await controlRequest(`/api/codex/browser-extension/bindings/${encodeURIComponent(current.bindingId)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      return { skipped: false, reused: false, serverId, profileId, sessionKey, personalChromeMode: savedPayload.personalChromeMode };
    } catch (error) {
      if (bindingId) {
        await controlRequest(`/api/codex/browser-extension/bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' }).catch(() => undefined);
      }
      throw error;
    }
  })().finally(() => sessionSyncs.delete(syncKey));
  sessionSyncs.set(syncKey, operation);
  return operation;
}

async function unpairDevice() {
  if (settings?.deviceId && settings?.deviceToken) {
    await controlRequest(`/api/codex/browser-extension/devices/${encodeURIComponent(settings.deviceId)}`, { method: 'DELETE' })
      .catch(() => undefined);
  }
  clearTimeout(reconnectTimer); reconnectTimer = null; socket?.close(1000, 'Unpaired'); socket = null; connected = false;
  clearPendingApprovals();
  const next = settings?.controlOrigin ? { controlOrigin: settings.controlOrigin, deviceName: settings.deviceName || 'Chrome במחשב האישי' } : null;
  settings = next;
  if (next) await chrome.storage.local.set({ [STORAGE_KEY]: next });
  else await chrome.storage.local.remove(STORAGE_KEY);
  await installAuthRules(next);
  broadcastStatus();
}

async function runCommand(command) {
  let response;
  try {
    const result = await dispatchCommand(command.toolName, command.arguments || {});
    response = { type: 'result', version: PROTOCOL_VERSION, commandId: command.commandId, ok: true, result };
  } catch (error) {
    response = { type: 'result', version: PROTOCOL_VERSION, commandId: command.commandId, ok: false, error: { code: error.code || 'COMMAND_FAILED', message: error.message || String(error), retryable: ['DEVICE_OFFLINE', 'TIMEOUT', 'STALE_ELEMENT'].includes(error.code), details: error.details } };
  }
  try { sendSocket(response); } catch {}
}

async function dispatchCommand(name, args) {
  if (name === 'browser_status') {
    const tab = await activeTab().catch(() => null);
    return { online: connected, deviceId: settings?.deviceId, deviceName: settings?.deviceName, extensionId: chrome.runtime.id, activeTab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null, attachedTabIds: [...attachedTabs] };
  }
  if (name === 'browser_tabs') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter((tab) => args.includePinned !== false || !tab.pinned).map((tab) => ({ id: tab.id, windowId: tab.windowId, active: tab.active, pinned: tab.pinned, title: tab.title, url: tab.url, status: tab.status })) };
  }
  if (name === 'browser_tab_control') {
    if (args.action === 'new') { const tab = await chrome.tabs.create({ url: args.url ? safeUrl(args.url) : 'about:blank', active: true }); return { tab: { id: tab.id, title: tab.title, url: tab.url } }; }
    const tab = await resolveTab(args);
    if (args.action === 'activate') { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { activated: true, tabId: tab.id }; }
    if (args.action === 'reload') { await chrome.tabs.reload(tab.id); return { reloaded: true, tabId: tab.id }; }
    if (args.action === 'close') { await chrome.tabs.remove(tab.id); return { closed: true, tabId: tab.id }; }
    throw errorWithCode('Unsupported tab action.', 'INVALID_ARGUMENT');
  }
  if (name === 'browser_navigate') {
    const tab = await resolveTab(args); const url = safeUrl(args.url); await chrome.tabs.update(tab.id, { url, active: true });
    if (args.waitUntil !== 'none') await waitForTab(tab.id, args.waitUntil || 'domcontentloaded', Number(args.timeoutMs) || 30000);
    const updated = await chrome.tabs.get(tab.id); return { tabId: tab.id, url: updated.url, title: updated.title, status: updated.status };
  }
  if (name === 'browser_snapshot') {
    const tab = await resolveTab(args); assertScriptable(tab);
    return execute(tab.id, (maxChars, cursor) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')].slice(0, 600).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), name: el.getAttribute('aria-label') || el.getAttribute('title') || clean(el.innerText || el.value || el.textContent).slice(0, 180), href: el instanceof HTMLAnchorElement ? el.href : null, disabled: Boolean(el.disabled), selectorHint: el.id ? `#${CSS.escape(el.id)}` : null })).filter((item) => item.name || item.href);
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 200).map((el) => ({ level: Number(el.tagName.slice(1)), text: clean(el.textContent).slice(0, 500) }));
      const fullText = clean(document.body?.innerText || '').slice(cursor, cursor + maxChars);
      return { url: location.href, title: document.title, language: document.documentElement.lang || null, headings, controls, text: fullText, cursor, nextCursor: cursor + fullText.length < clean(document.body?.innerText || '').length ? cursor + fullText.length : null, totalTextChars: clean(document.body?.innerText || '').length };
    }, [Math.min(50000, Math.max(1000, Number(args.maxChars) || 18000)), Math.max(0, Number(args.cursor) || 0)]);
  }
  if (name === 'browser_inspect') {
    const tab = await resolveTab(args);
    let inspected;
    if (args.mode === 'element_picker' || args.mode === 'region_picker') inspected = await startPicker(tab, args.mode, args.prompt, Number(args.timeoutMs) || 60000);
    else { if (!args.selector) throw errorWithCode('selector is required in selector mode.', 'INVALID_ARGUMENT'); inspected = await inspectSelector(tab, args.selector); if (!inspected) throw errorWithCode('The selector did not match an element.', 'STALE_ELEMENT'); const selectionId = crypto.randomUUID(); selections.set(selectionId, { selectionId, tabId: tab.id, createdAt: new Date().toISOString(), payload: inspected }); inspected.selectionId = selectionId; }
    return inspected;
  }
  if (name === 'browser_screenshot') {
    const tab = await resolveTab(args); await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
    let imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: args.format === 'jpeg' ? 'jpeg' : 'png', quality: args.format === 'jpeg' ? Math.min(100, Math.max(20, Number(args.quality) || 85)) : undefined });
    const selection = args.selectionId ? selections.get(args.selectionId) : null;
    if (args.selectionId && (!selection || selection.tabId !== tab.id)) throw errorWithCode('The selected region is stale.', 'STALE_ELEMENT');
    if (selection?.payload?.bounds) imageDataUrl = await cropDataUrl(imageDataUrl, selection.payload.bounds, selection.payload.viewport?.devicePixelRatio || 1, args.format);
    imageDataUrl = await boundImageDataUrl(imageDataUrl, args.format, Number(args.quality) || 85);
    return { tabId: tab.id, url: tab.url, title: tab.title, capturedAt: new Date().toISOString(), bytes: estimateDataUrlBytes(imageDataUrl), imageDataUrl };
  }
  if (name === 'browser_click') {
    const tab = await resolveTab(args); assertScriptable(tab);
    const selector = resolveTarget(args.target?.selectionId, args.target?.selector, tab.id);
    if (selector) {
      const clicked = await execute(tab.id, (css) => { const el = document.querySelector(css); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center' }); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); el.click(); return true; }, [selector]);
      if (!clicked) throw errorWithCode('The target element is stale.', 'STALE_ELEMENT');
    } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
      await debuggerCommand(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Number(args.x), y: Number(args.y), button: args.button || 'left', clickCount: Number(args.clickCount) || 1 });
      await debuggerCommand(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Number(args.x), y: Number(args.y), button: args.button || 'left', clickCount: Number(args.clickCount) || 1 });
    } else throw errorWithCode('A selector, selectionId, or x/y coordinate is required.', 'INVALID_ARGUMENT');
    return { clicked: true, tabId: tab.id };
  }
  if (name === 'browser_type') {
    const tab = await resolveTab(args); assertScriptable(tab); const selector = resolveTarget(args.target?.selectionId, args.target?.selector, tab.id);
    const result = await execute(tab.id, (css, text, clearFirst, submit) => {
      const el = css ? document.querySelector(css) : document.activeElement;
      if (!el) return { ok: false };
      el.focus();
      if ('value' in el) { const next = clearFirst ? text : `${el.value || ''}${text}`; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; setter ? setter.call(el, next) : (el.value = next); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (el.isContentEditable) { if (clearFirst) el.textContent = ''; document.execCommand('insertText', false, text); el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
      else return { ok: false };
      if (submit) { const form = el.closest('form'); form ? form.requestSubmit() : el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); }
      return { ok: true, tagName: el.tagName.toLowerCase() };
    }, [selector, String(args.text), args.clearFirst === true, args.submit === true]);
    if (!result?.ok) throw errorWithCode('The typing target is stale or not editable.', 'STALE_ELEMENT');
    return { typed: true, tabId: tab.id, characters: String(args.text).length, submitted: args.submit === true };
  }
  if (name === 'browser_key') {
    const tab = await resolveTab(args); assertScriptable(tab);
    const key = String(args.key || '').trim();
    if (!key || key.length > 40) throw errorWithCode('A valid key is required.', 'INVALID_ARGUMENT');
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    const modifierMask = (modifiers.includes('Alt') ? 1 : 0)
      | (modifiers.includes('Control') ? 2 : 0)
      | (modifiers.includes('Meta') ? 4 : 0)
      | (modifiers.includes('Shift') ? 8 : 0);
    const keyInfo = keyboardKeyInfo(key);
    const repeat = Math.min(20, Math.max(1, Number(args.repeat) || 1));
    const text = modifierMask === 0 && keyInfo.key.length === 1 ? keyInfo.key : undefined;
    for (let index = 0; index < repeat; index += 1) {
      await debuggerCommand(tab.id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: keyInfo.key,
        code: keyInfo.code,
        windowsVirtualKeyCode: keyInfo.keyCode,
        nativeVirtualKeyCode: keyInfo.keyCode,
        modifiers: modifierMask,
        autoRepeat: index > 0,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
      await debuggerCommand(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: keyInfo.key, code: keyInfo.code, windowsVirtualKeyCode: keyInfo.keyCode, nativeVirtualKeyCode: keyInfo.keyCode, modifiers: modifierMask });
    }
    return { sent: true, tabId: tab.id, key: keyInfo.key, modifiers, repeat };
  }
  if (name === 'browser_fill_form') {
    const tab = await resolveTab(args); assertScriptable(tab);
    if (!Array.isArray(args.fields) || args.fields.length === 0 || args.fields.length > 50) throw errorWithCode('fields must contain between 1 and 50 entries.', 'INVALID_ARGUMENT');
    const fields = args.fields.map((field) => ({ selector: resolveTarget(field.selectionId, field.selector, tab.id), value: field.value }));
    if (fields.some((field) => !field.selector)) throw errorWithCode('Every form field requires a selector or a current selectionId.', 'INVALID_ARGUMENT');
    const result = await execute(tab.id, (entries, submitSelector) => {
      const filled = []; const missing = [];
      for (const entry of entries) {
        const el = document.querySelector(entry.selector); if (!el) { missing.push(entry.selector); continue; }
        el.focus();
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          setter ? setter.call(el, Boolean(entry.value)) : (el.checked = Boolean(entry.value));
        }
        else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          const nextValue = String(entry.value ?? '');
          setter ? setter.call(el, nextValue) : (el.value = nextValue);
        }
        else if (el.isContentEditable) el.textContent = String(entry.value ?? '');
        else { missing.push(entry.selector); continue; }
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); filled.push(entry.selector);
      }
      let submitted = false; if (submitSelector) { const submit = document.querySelector(submitSelector); if (submit) { submit.click(); submitted = true; } }
      return { filled, missing, submitted };
    }, [fields, args.submitSelector || null]);
    return { tabId: tab.id, ...result };
  }
  if (name === 'browser_upload') {
    const tab = await resolveTab(args); assertScriptable(tab); const selector = resolveTarget(args.target?.selectionId, args.target?.selector, tab.id);
    if (!selector) throw errorWithCode('A file input selector or selectionId is required.', 'INVALID_ARGUMENT');
    const ok = await execute(tab.id, (css, name, mimeType, base64) => {
      const input = document.querySelector(css); if (!(input instanceof HTMLInputElement) || input.type !== 'file') return false;
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)); const file = new File([bytes], name, { type: mimeType }); const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); return true;
    }, [selector, String(args.name), String(args.mimeType), String(args.base64)]);
    if (!ok) throw errorWithCode('The target is not a file input.', 'STALE_ELEMENT');
    return { uploaded: true, tabId: tab.id, name: args.name, bytes: Math.floor(String(args.base64).length * 0.75) };
  }
  if (name === 'browser_scroll') {
    const tab = await resolveTab(args); assertScriptable(tab); const selector = resolveTarget(args.target?.selectionId, args.target?.selector, tab.id);
    const parsedDeltaX = Number(args.deltaX);
    const parsedDeltaY = Number(args.deltaY);
    const deltaX = Number.isFinite(parsedDeltaX) ? parsedDeltaX : 0;
    const deltaY = Number.isFinite(parsedDeltaY) ? parsedDeltaY : 700;
    await execute(tab.id, (css, x, y, behavior) => { const target = css ? document.querySelector(css) : window; if (!target) return false; target.scrollBy({ left: x, top: y, behavior }); return true; }, [selector, deltaX, deltaY, args.behavior === 'smooth' ? 'smooth' : 'auto']);
    return { scrolled: true, tabId: tab.id };
  }
  if (name === 'browser_evaluate') {
    const tab = await resolveTab(args); const result = await debuggerCommand(tab.id, 'Runtime.evaluate', { expression: String(args.expression), awaitPromise: args.awaitPromise !== false, returnByValue: args.returnByValue !== false, userGesture: true });
    if (result.exceptionDetails) throw errorWithCode(result.exceptionDetails.text || 'JavaScript evaluation failed.', 'JAVASCRIPT_ERROR', result.exceptionDetails);
    return { tabId: tab.id, value: remoteValue(result.result), type: result.result?.type, description: result.result?.description };
  }
  if (name === 'browser_console') {
    const tab = await resolveTab(args); await debuggerCommand(tab.id, 'Runtime.enable'); let entries = [...(consoleByTab.get(tab.id) || [])];
    if (Array.isArray(args.levels) && args.levels.length) entries = entries.filter((entry) => args.levels.includes(entry.level)); if (args.contains) entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(String(args.contains).toLowerCase())); entries = entries.slice(-Math.min(500, Math.max(1, Number(args.limit) || 100))); if (args.clear) consoleByTab.set(tab.id, []); return { tabId: tab.id, entries, cleared: args.clear === true };
  }
  if (name === 'browser_network') {
    const tab = await resolveTab(args); await debuggerCommand(tab.id, 'Network.enable'); let entries = [...(networkByTab.get(tab.id) || [])];
    if (args.contains) entries = entries.filter((entry) => JSON.stringify(entry).toLowerCase().includes(String(args.contains).toLowerCase())); if (Array.isArray(args.resourceTypes) && args.resourceTypes.length) entries = entries.filter((entry) => args.resourceTypes.includes(entry.resourceType)); entries = entries.slice(-Math.min(500, Math.max(1, Number(args.limit) || 100)));
    if (args.includeBodies) for (const entry of entries.slice(-10)) { try { const body = await debuggerCommand(tab.id, 'Network.getResponseBody', { requestId: entry.requestId }); entry.body = body.base64Encoded ? '[base64 body omitted]' : String(body.body || '').slice(0, 50000); } catch { entry.body = '[unavailable]'; } }
    if (args.clear) { networkByTab.set(tab.id, []); requestByTab.set(tab.id, new Map()); }
    return { tabId: tab.id, entries, cleared: args.clear === true };
  }
  throw errorWithCode(`Unsupported command: ${name}`, 'UNKNOWN_TOOL');
}

async function waitForTab(tabId, readiness, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (readiness === 'complete' ? tab.status === 'complete' : tab.status !== 'loading') return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw errorWithCode(`Navigation timed out after ${timeoutMs}ms.`, 'TIMEOUT');
}

function keyboardKeyInfo(rawKey) {
  const aliases = {
    Esc: 'Escape', Space: ' ', Spacebar: ' ', Return: 'Enter', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown',
  };
  const key = aliases[rawKey] || rawKey;
  const known = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32],
  };
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return { key, code: key, keyCode: 111 + Number(key.slice(1)) };
  if (known[key]) return { key, code: known[key][0], keyCode: known[key][1] };
  const character = key.length === 1 ? key : key.slice(0, 1);
  return { key, code: /^[a-z]$/i.test(character) ? `Key${character.toUpperCase()}` : /^[0-9]$/.test(character) ? `Digit${character}` : key, keyCode: character.toUpperCase().charCodeAt(0) };
}

function estimateDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return comma < 0 ? dataUrl.length : Math.floor((dataUrl.length - comma - 1) * 0.75);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function boundImageDataUrl(dataUrl, format, quality, maximumBytes = 7_500_000) {
  if (estimateDataUrlBytes(dataUrl) <= maximumBytes) return dataUrl;
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  let scale = Math.min(0.9, Math.sqrt(maximumBytes / Math.max(1, sourceBlob.size)) * 0.9);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: Math.min(1, Math.max(0.2, quality / 100)) });
    const next = await blobToDataUrl(blob);
    if (estimateDataUrlBytes(next) <= maximumBytes) return next;
    scale *= 0.72;
  }
  throw errorWithCode('The screenshot is too large to send safely.', 'PAYLOAD_TOO_LARGE');
}

async function cropDataUrl(dataUrl, bounds, dpr, format) {
  const blob = await (await fetch(dataUrl)).blob(); const bitmap = await createImageBitmap(blob); const scale = Number(dpr) || 1;
  const x = Math.max(0, Math.round(bounds.x * scale)); const y = Math.max(0, Math.round(bounds.y * scale)); const width = Math.max(1, Math.min(bitmap.width - x, Math.round(bounds.width * scale))); const height = Math.max(1, Math.min(bitmap.height - y, Math.round(bounds.height * scale)));
  const canvas = new OffscreenCanvas(width, height); canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height); const cropped = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: 0.9 }); return blobToDataUrl(cropped);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void chrome.alarms.create('code-ai-bridge-heartbeat', { periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'code-ai-bridge-heartbeat') { if (!connected) connectBridge(); else try { sendSocket({ type: 'event', version: PROTOCOL_VERSION, name: 'heartbeat', payload: { at: new Date().toISOString() } }); } catch {} } });
chrome.notifications.onClicked.addListener(() => void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(() => undefined));

void loadSettings().then(async () => { await installAuthRules(settings); if (settings?.deviceToken) connectBridge(); });
