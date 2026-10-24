// Native Windows qualification only. Starts an isolated, headless Chromium
// profile and a minimal extension, never the user's installed Chrome profile,
// CODE-AI authentication, bridge, server, queues, or device credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const [browserPath, candidatePath, qualificationRoot, oldHelperPath] = process.argv.slice(2);
if (process.platform !== 'win32' || !browserPath || !candidatePath || !qualificationRoot) {
  throw new Error('Usage on Windows: node personal-chrome-panel-open-native.mjs BROWSER CANDIDATE UNIQUE_SCRATCH [OLD_HELPER]');
}
await fs.mkdir(qualificationRoot); // Refuse to overwrite any existing profile.
const source = await fs.readFile(path.join(candidatePath, 'background.js'), 'utf8');
const helper = await fs.readFile(path.join(candidatePath, 'panelOpen.js'), 'utf8');
const cases = [{ name: 'candidate', helper, source }];
if (oldHelperPath) cases.unshift({
  name: 'predecessor', helper: await fs.readFile(oldHelperPath, 'utf8'),
  source: await fs.readFile(path.join(path.dirname(oldHelperPath), 'background.js'), 'utf8'),
});
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(event.data);
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(value.error.message));
      else pending.resolve(value.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Qualification browser connection closed.'));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Qualification timeout: ${method}`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// Debugging is available only through inherited pipes, never a public port.
// This is a separate profile, not a connection to the user's existing Chrome.
class PipeSocket extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    let buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const data = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (data) this.emit('message', { data });
      }
    });
    child.once('exit', () => this.emit('close'));
  }
  addEventListener(event, listener) { this.on(event, listener); }
  send(data) { this.child.stdio[3].write(`${data}\0`); }
  close() {
    // Windows may leave inherited pipe handles open after Browser.close.
    // Release only this qualification process's two debugging streams.
    this.child.stdio[3].destroy();
    this.child.stdio[4].destroy();
  }
}

async function until(read, predicate, label, seconds = 12) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(70);
  }
  throw new Error(`Qualification timeout: ${label}`);
}

for (const fixture of cases) {
  const functions = fixture.source.slice(fixture.source.indexOf('async function restorePanelAnchor()'), fixture.source.indexOf('async function panelAnchorTab()'));
  const action = fixture.source.slice(fixture.source.indexOf('chrome.action.onClicked.addListener'), fixture.source.indexOf('chrome.sidePanel.onOpened?.addListener'));
  const onOpened = fixture.source.slice(fixture.source.indexOf('chrome.sidePanel.onOpened?.addListener'), fixture.source.indexOf('chrome.notifications.onClicked.addListener'));
  assert.ok(functions.startsWith('async function restorePanelAnchor()'));
  assert.ok(action.startsWith('chrome.action.onClicked'));
  assert.ok(onOpened.startsWith('chrome.sidePanel.onOpened'));
  const caseRoot = path.join(qualificationRoot, fixture.name);
  const extensionRoot = path.join(caseRoot, 'extension');
  const profileRoot = path.join(caseRoot, 'isolated-profile');
  await fs.mkdir(extensionRoot, { recursive: true });
  await fs.writeFile(path.join(extensionRoot, 'panelOpen.js'), fixture.helper);
  await fs.writeFile(path.join(extensionRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: `CODE-AI panel qualification ${randomUUID()}`, version: '1.0.0',
    permissions: ['sidePanel', 'tabs', 'storage'], action: {},
    background: { service_worker: 'background.js', type: 'module' },
  }));
  await fs.writeFile(path.join(extensionRoot, 'panel.html'), '<!doctype html><title>Isolated panel test</title><p>Fixture only</p>');
  await fs.writeFile(path.join(extensionRoot, 'background.js'), `
    import { openTabPanel } from './panelOpen.js';
    let panelAnchor = null;
    let panelScopeRevision = 0;
    let openedEvents = 0;
    let closedEvents = 0;
    let actionEvents = 0;
    const PANEL_ANCHOR_STORAGE_KEY = 'qualification-anchor';
    function errorWithCode(message) { return new Error(message); }
    ${functions}
    ${action}
    ${onOpened}
    chrome.action.onClicked.addListener(() => { actionEvents += 1; });
    chrome.sidePanel.onOpened?.addListener(() => { openedEvents += 1; });
    chrome.sidePanel.onClosed?.addListener(() => { closedEvents += 1; });
    const ready = initializePanelScope();
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (message.op === 'open') {
        // Preserve the user gesture forwarded from a trusted button click.
        void openPanelFromUserGesture(sender.tab)
          .then(() => reply({ ok: true, tabId: panelAnchor?.tabId }))
          .catch(error => reply({ ok: false, error: String(error.message).slice(0, 200) }));
      } else if (message.op === 'close') {
        void chrome.sidePanel.close({ tabId: sender.tab.id })
          .then(() => reply({ ok: true }))
          .catch(error => reply({ ok: false, error: String(error.message).slice(0, 200) }));
      } else if (message.op === 'state') {
        void ready.then(async () => reply({
          ok: true, tabId: sender.tab.id, anchor: panelAnchor, openedEvents, closedEvents, actionEvents,
          panelError: (await chrome.storage.session.get('codeAiPanelOpenError')).codeAiPanelOpenError || null,
          options: await chrome.sidePanel.getOptions({ tabId: sender.tab.id }),
          global: await chrome.sidePanel.getOptions({}),
          behavior: await chrome.sidePanel.getPanelBehavior(),
        }));
      } else return false;
      return true;
    });
  `);
  await fs.writeFile(path.join(extensionRoot, 'test.html'), '<!doctype html><title>CODE-AI isolated qualification</title><button id="open" style="width:160px;height:60px">Open panel</button><script type="module" src="test.js"></script>');
  await fs.writeFile(path.join(extensionRoot, 'test.js'), `
    window.testResult = null;
    document.querySelector('#open').addEventListener('click', (event) => {
      window.testResult = null;
      window.trustedClick = event.isTrusted;
      chrome.runtime.sendMessage({ op: 'open' }, result => { window.testResult = result; });
    });
  `);
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileRoot}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let cdp;
  try {
    child.on('error', () => {});
    cdp = new Cdp(new PipeSocket(child));
    const version = await cdp.send('Browser.getVersion');
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: extensionRoot });
    const worker = await until(
      () => cdp.send('Target.getTargets'),
      value => value.targetInfos.some(target => target.type === 'service_worker' && target.url.endsWith('/background.js')),
      'isolated extension worker',
    );
    assert.ok(worker.targetInfos.some(target => target.url === `chrome-extension://${extensionId}/background.js`));
    const pages = [];
    for (let index = 0; index < 2; index += 1) {
      const pageUrl = `chrome-extension://${extensionId}/test.html?fixtureTab=${index}`;
      const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Target.activateTarget', { targetId });
      const evaluate = async (expression) => {
        const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error('Isolated test page evaluation failed.');
        return result.result.value;
      };
      await until(() => evaluate(`Boolean(document.querySelector('#open') && chrome.runtime)`), Boolean, 'fixture page');
      const state = await evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`);
      assert.equal(state.behavior.openPanelOnActionClick, fixture.name === 'predecessor');
      assert.equal(state.global.enabled, false);
      // The Extensions domain takes a tab target, not its page/frame target.
      const tabTargets = await until(
        () => cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] }),
        value => value.targetInfos.some(target => target.url === pageUrl),
        'fixture tab target',
      );
      const tabTargetId = tabTargets.targetInfos.find(target => target.url === pageUrl).targetId;
      pages.push({ targetId, tabTargetId, sessionId, evaluate, tabId: state.tabId });
    }
    let completed = 0;
    let firstFailure = null;
    for (let index = 0; index < 30; index += 1) {
      // Include same-tab close/reopen as well as switching ownership A-B-A.
      const page = pages[Math.floor(index / 3) % pages.length];
      await cdp.send('Target.activateTarget', { targetId: page.targetId });
      const before = await page.evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`);
      await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: page.tabTargetId });
      let state;
      try {
        state = await until(
          () => page.evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`),
          value => value.openedEvents > before.openedEvents && value.anchor?.tabId === page.tabId,
          'actual toolbar action opening',
        );
      } catch (error) {
        const diagnostic = await page.evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`);
        firstFailure = {
          iteration: index + 1, error: error.message, panelError: diagnostic.panelError,
          openedEvents: diagnostic.openedEvents, closedEvents: diagnostic.closedEvents,
          actionEvents: diagnostic.actionEvents,
        };
        break;
      }
      assert.equal(state.options.enabled, true);
      assert.equal(state.anchor.tabId, page.tabId);
      assert.equal(state.global.enabled, false);
      if (index >= 3) {
        const previous = await pages[(Math.floor(index / 3) + 1) % 2].evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`);
        assert.equal(previous.options.enabled, false);
      }
      assert.equal((await page.evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'close'}, resolve))`)).ok, true);
      // close() resolves when it has scheduled the close. Wait for actual UI
      // closure, otherwise the next opening can be a no-op during animation.
      await until(
        () => page.evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`),
        value => value.closedEvents > state.closedEvents,
        'actual panel closure',
      );
      completed += 1;
    }
    const eventState = await pages[0].evaluate(`new Promise(resolve => chrome.runtime.sendMessage({op:'state'}, resolve))`);
    results.push({
      case: fixture.name, browser: version.product, completed, firstFailure,
      openedEvents: eventState.openedEvents, closedEvents: eventState.closedEvents, actionEvents: eventState.actionEvents,
      helperSha256: createHash('sha256').update(fixture.helper).digest('hex'),
      backgroundSha256: createHash('sha256').update(fixture.source).digest('hex'),
      noAuthentication: true, isolatedProfile: true,
    });
    console.log(JSON.stringify(results.at(-1)));
    if (fixture.name === 'candidate') {
      assert.equal(firstFailure, null);
      assert.equal(completed, 30);
      assert.equal(eventState.actionEvents, 30, 'every toolbar click must reach our opening handler');
      assert.ok(eventState.openedEvents > 0, 'browser must emit actual panel-open events');
    }
    await fs.writeFile(path.join(qualificationRoot, 'result.json'), JSON.stringify({ results }, null, 2));
  } finally {
    // Browser.close addresses only the dedicated profile launched above.
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.socket.close();
    }
    if (child.exitCode === null) child.kill();
  }
}
await fs.writeFile(path.join(qualificationRoot, 'result.json'), JSON.stringify({ results }, null, 2));
