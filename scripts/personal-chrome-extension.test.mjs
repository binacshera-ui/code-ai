import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { mayReadSelection, sameSelectionSession, selectionPageChanged } from '../chrome-extension/selectionAccess.js';
import { openTabPanel } from '../chrome-extension/panelOpen.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(appRoot, 'chrome-extension');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('opening is requested during the original gesture, before the registration response', async () => {
  const calls = [];
  let configured = false;
  let gesture = true;
  const optionsResponse = deferred();
  const chromeApi = {
    sidePanel: {
      setOptions(options) {
        calls.push(['options', options]);
        configured = true; // Chromium's SetOptions runs before its async response.
        return optionsResponse.promise;
      },
      open(options) {
        assert.equal(configured, true, 'registration request must precede opening');
        assert.equal(gesture, true, 'a callback or await loses the actual click');
        calls.push(['open', options]);
        return Promise.resolve();
      },
    },
  };
  const opened = openTabPanel(chromeApi, { id: 12, windowId: 3 });
  gesture = false;
  assert.equal(calls.length, 2, 'both requests must be issued before returning to Chrome');
  let settled = false;
  void opened.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'registration failures must still be observed');
  optionsResponse.resolve();
  await opened;
  assert.deepEqual(calls, [
    ['options', { tabId: 12, path: 'panel.html', enabled: true }],
    ['open', { tabId: 12 }],
  ]);
});

test('registration and opening errors are returned, never hidden or retried globally', async () => {
  const opens = [];
  const api = {
    sidePanel: {
      setOptions() { return Promise.reject(new Error('Tab closed')); },
      open(options) { opens.push(options); return Promise.resolve(); },
    },
  };
  await assert.rejects(openTabPanel(api, { id: 12 }), /Tab closed/);
  assert.deepEqual(opens, [{ tabId: 12 }], 'only the requested tab is opened, never a window fallback');
  api.sidePanel.setOptions = () => Promise.resolve();
  api.sidePanel.open = () => Promise.reject(new Error('Gesture expired'));
  await assert.rejects(openTabPanel(api, { id: 12 }), /Gesture expired/);
  api.sidePanel.open = () => { throw new Error('Opening unavailable'); };
  await assert.rejects(openTabPanel(api, { id: 12 }), /Opening unavailable/);
  api.sidePanel.setOptions = () => { throw new Error('Registration unavailable'); };
  await assert.rejects(openTabPanel(api, { id: 12 }), /Registration unavailable/);
  for (const tab of [{}, { id: -1 }, { id: '12' }, { id: 1.5 }]) {
    await assert.rejects(openTabPanel(api, tab), /No Chrome tab/);
  }
});

async function panelHarness({ restoreResponse } = {}) {
  const source = await fs.readFile(path.join(extensionRoot, 'background.js'), 'utf8');
  const options = new Map();
  const calls = [];
  let stored = {};
  let gesture = false;
  let openedListener;
  let nextOpenError;
  const chromeApi = {
    storage: { session: {
      get: async () => restoreResponse ? restoreResponse.promise : stored,
      set: async (value) => { stored = { ...stored, ...value }; },
      remove: async (key) => { delete stored[key]; },
    } },
    tabs: { get: async (id) => ({ id, windowId: 7 }) },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    sidePanel: {
      setOptions(value) {
        const key = value.tabId ?? 'global';
        calls.push(['options', key, value.enabled]);
        options.set(key, { ...options.get(key), ...value });
        return Promise.resolve();
      },
      async setPanelBehavior(value) { calls.push(['behavior', value.openPanelOnActionClick]); },
      open(value) {
        assert.equal(gesture, true, 'worker must issue open before leaving the event');
        assert.equal(options.get(value.tabId)?.enabled, true);
        calls.push(['open', value.tabId]);
        if (nextOpenError) {
          const error = nextOpenError;
          nextOpenError = null;
          return Promise.reject(error);
        }
        return Promise.resolve();
      },
      onOpened: { addListener(fn) { openedListener = fn; } },
    },
  };
  const context = vm.createContext({
    chrome: chromeApi, openTabPanel, console,
    errorWithCode: (message) => new Error(message),
  });
  const functions = source.slice(source.indexOf('async function restorePanelAnchor()'), source.indexOf('async function panelAnchorTab()'));
  const onOpened = source.slice(source.indexOf('chrome.sidePanel.onOpened?.addListener'), source.indexOf('chrome.notifications.onClicked.addListener'));
  vm.runInContext(`
    let panelAnchor = null;
    let panelScopeRevision = 0;
    const PANEL_ANCHOR_STORAGE_KEY = 'anchor';
    ${functions}
    ${onOpened}
    globalThis.panelTest = {
      initializePanelScope,
      openPanelFromUserGesture,
      snapshot: () => ({ anchor: panelAnchor, revision: panelScopeRevision }),
    };
  `, context);
  return {
    options, calls,
    initialize: () => context.panelTest.initializePanelScope(),
    click(id) {
      gesture = true;
      try { return context.panelTest.openPanelFromUserGesture({ id, windowId: 7 }); }
      finally { gesture = false; }
    },
    emitOpened: (tabId) => openedListener({ tabId, windowId: 7 }),
    failNextOpen: (error) => { nextOpenError = error; },
    snapshot: () => JSON.parse(JSON.stringify(context.panelTest.snapshot())),
  };
}

test('repeated opening and A-B-A tab changes have no quota or global fallback', async () => {
  const panel = await panelHarness();
  await panel.initialize();
  for (let index = 0; index < 60; index += 1) {
    const id = index % 2 ? 12 : 15;
    await panel.click(id);
    assert.equal(panel.options.get(id).enabled, true);
    if (index) assert.equal(panel.options.get(id === 12 ? 15 : 12).enabled, false);
    assert.equal(panel.snapshot().anchor.tabId, id);
  }
  assert.equal(panel.calls.filter(([kind]) => kind === 'open').length, 60);
  assert.deepEqual(panel.calls.find(([kind]) => kind === 'behavior'), ['behavior', false], 'native toolbar toggle must not compete with the handler');
  assert.equal(panel.options.get('global').enabled, false);
});

test('switching tabs retires the previous entry before opening the replacement, never afterward', async () => {
  const panel = await panelHarness();
  await panel.initialize();
  await panel.click(12);
  panel.calls.length = 0;
  const opening = panel.click(15);
  assert.deepEqual(panel.calls, [
    ['options', 12, false],
    ['options', 15, true],
    ['open', 15],
  ], 'the context handoff must happen in the original gesture and in this order');
  await opening;
  assert.equal(panel.calls.at(-1)[0], 'open', 'no late disable may close the newly opened panel');
});

test('slow startup restoration and delayed open events do not overwrite the latest clicked tab', async () => {
  const restoreResponse = deferred();
  const panel = await panelHarness({ restoreResponse });
  const initialization = panel.initialize();
  await Promise.resolve();
  await Promise.resolve();
  await panel.click(15);
  restoreResponse.resolve({ anchor: { tabId: 12, windowId: 7 } });
  await initialization;
  assert.equal(panel.snapshot().anchor.tabId, 15);
  await panel.click(12);
  const afterClick = panel.snapshot();
  panel.emitOpened(15);
  await Promise.resolve();
  assert.deepEqual(panel.snapshot(), afterClick, 'late native events must not reassign ownership');
  assert.equal(panel.options.get(15).enabled, false);
  assert.equal(panel.options.get(12).enabled, true);
  assert.equal(panel.options.get(15).enabled, false);
});

test('a failed opening preserves the existing panel owner and the next click recovers', async () => {
  const panel = await panelHarness();
  await panel.initialize();
  await panel.click(12);
  panel.failNextOpen(new Error('Temporary open failure'));
  await assert.rejects(panel.click(15), /Temporary open failure/);
  assert.equal(panel.snapshot().anchor.tabId, 12);
  assert.equal(panel.options.get(12).enabled, true);
  await panel.click(15);
  assert.equal(panel.snapshot().anchor.tabId, 15);
  assert.equal(panel.options.get(12).enabled, false);
});

test('Chrome extension package is generic, complete, and load-unpacked compatible', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '1.5.2');
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.side_panel, undefined, 'no global fallback may open on unrelated tabs');
  for (const permission of ['clipboardWrite', 'debugger', 'declarativeNetRequest', 'scripting', 'sidePanel', 'tabGroups', 'tabs']) {
    assert.ok(manifest.permissions.includes(permission), `missing ${permission}`);
  }
  for (const file of ['background.js', 'bridgeTransport.js', 'profileIdentity.js', 'profileSync.js', 'panelPairing.js', 'selectionAccess.js', 'panelOpen.js', 'contentScript.js', 'panel.html', 'panel.css', 'panel.js', 'icon-128.png', 'README.md']) {
    const metadata = await fs.stat(path.join(extensionRoot, file));
    assert.ok(metadata.size > 0, `${file} is empty`);
  }
  const source = await Promise.all(['manifest.json', 'background.js', 'contentScript.js', 'panel.html', 'panel.js']
    .map((file) => fs.readFile(path.join(extensionRoot, file), 'utf8')));
  const combined = source.join('\n');
  const background = source[1];
  const panel = await fs.readFile(path.join(extensionRoot, 'panel.html'), 'utf8');
  assert.doesNotMatch(combined, /\/root\/projects\/|app-code-ai\./i);
  assert.match(combined, /browser_key/);
  assert.match(combined, /ENROLL_DEVICE/);
  assert.match(combined, /SYNC_ACTIVE_SESSION/);
  assert.match(combined, /CODE_AI_PICKER_PING/);
  assert.match(combined, /browser_selection_context/);
  assert.match(combined, /browser_workspace/);
  assert.match(combined, /workspaceState\(commandSession, \{ tabScope: 'workspace' \}\)/);
  assert.match(combined, /PANEL_WORKSPACE_ACTION/);
  assert.match(combined, /chrome\.tabGroups\.update/);
  assert.match(combined, /chrome\.action\.onClicked/);
  assert.match(background, /openPanelFromUserGesture/);
  assert.match(background, /openPanelOnActionClick: false/);
  assert.match(background, /catch\(reportPanelOpenError\)/);
  assert.match(background, /function initializePanelScope\(\)/);
  assert.match(background, /readOnlySelection: true/);
  assert.match(background, /function selectionForCommand\(selectionId, tabId, session\)/);
  assert.match(background, /SELECTION_PAGE_CHANGED/);
  const panelInitialization = background.slice(background.indexOf('async function initializePanelScope()'));
  assert.ok(
    panelInitialization.indexOf('chrome.sidePanel.setOptions({ enabled: false })')
      < panelInitialization.indexOf('await restorePanelAnchor()'),
    'the global panel must be disabled before restoring the tab-specific anchor',
  );
  const actionClickHandler = background.slice(
    background.indexOf('chrome.action.onClicked.addListener'),
    background.indexOf('chrome.notifications.onClicked.addListener'),
  );
  assert.match(actionClickHandler, /openPanelFromUserGesture\(tab\)/);
  assert.doesNotMatch(actionClickHandler, /\.then\([^)]*chrome\.sidePanel\.open/);
  assert.match(combined, /createBackgroundWorkspaceTab/);
  assert.match(combined, /active: false/);
  assert.doesNotMatch(combined, /chrome\.tabs\.update\(tab\.id, \{ url, active: true \}\)/);
  assert.match(combined, /PANEL_CLEAR_SELECTIONS/);
  assert.match(combined, /code-ai:extension-selections/);
  assert.match(combined, /matchedCssRules/);
  assert.match(combined, /framework-runtime/);
  assert.match(combined, /extension-panel/);
  assert.match(combined, /Control origin changed/);
  assert.match(combined, /settingsReady/);
  assert.match(combined, /LEGACY_FRAME_RULE_ID/);
  assert.match(combined, /code-ai:extension-ready/);
  assert.match(combined, /code-ai:extension-bootstrap/);
  assert.match(combined, /codeAiPersonalChromeInstallationId/);
  assert.match(combined, /frameReady/);
  assert.match(combined, /hasStoredPreference/);
  assert.match(combined, /current\.approvalPolicy === 'risky'/);
  assert.match(combined, /:\s*'never'/);
  assert.match(combined, /approvalPolicy === 'never' \|\| !hasStoredPreference/);
  assert.match(panel, /id="pairing-code"/);
  assert.doesNotMatch(panel, /type="password"/);
  assert.match(panel, /<iframe[^>]+id="code-ai-frame"[^>]+allow="clipboard-write"/i);
  assert.doesNotMatch(panel, /<script(?![^>]+src=)/i);
});

test('explicit focus IDs are readable across conversations but never gain a matching write session', () => {
  const owner = { serverId: 'local', profileId: 'developer', sessionKey: 'old', bindingId: 'old-binding' };
  const sameConversation = { ...owner };
  const nextConversation = { ...owner, sessionKey: 'new', bindingId: 'new-binding' };
  const anotherProfile = { ...nextConversation, profileId: 'another-user' };
  const anotherServer = { ...nextConversation, serverId: 'remote' };
  const focus = { selectionId: 'focus-123', session: owner };
  assert.equal(sameSelectionSession(owner, sameConversation), true);
  assert.equal(sameSelectionSession(owner, nextConversation), false);
  assert.equal(mayReadSelection(focus, nextConversation, null), false);
  assert.equal(mayReadSelection(focus, nextConversation, new Set(['focus-123'])), true);
  assert.equal(mayReadSelection(focus, nextConversation, new Set(['different-focus'])), false);
  assert.equal(mayReadSelection(focus, anotherProfile, new Set(['focus-123'])), false);
  assert.equal(mayReadSelection(focus, anotherServer, new Set(['focus-123'])), false);
});

test('a saved focus is still context, but must not crop a screenshot of a different page', () => {
  const captured = 'https://app.example.test/settings';
  assert.equal(selectionPageChanged(captured, captured), false);
  assert.equal(selectionPageChanged(captured, 'https://app.example.test/settings#connections'), true);
  assert.equal(selectionPageChanged(captured, 'https://app.example.test/space/skills'), true);
  assert.equal(selectionPageChanged(captured, 'https://other.example.test/settings'), true);
});
