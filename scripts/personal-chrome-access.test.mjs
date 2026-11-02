import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { assertAutomationPage, debuggerAttachFailure } from '../chrome-extension/pageAccess.js';
import { modeFailure } from '../server/codex-shared-modes/transport.mjs';

test('both Web Store hosts fail explicitly while ordinary and similar-looking sites remain supported', () => {
  for (const url of ['https://chrome.google.com/webstore/devconsole/example/edit', 'https://chrome.google.com/other-path',
    'https://chromewebstore.google.com/detail/example', 'https://CHROMEWEBSTORE.GOOGLE.COM./']) {
    assert.throws(() => assertAutomationPage({ id: 1, url }), { code: 'CHROME_STORE_RESTRICTED' });
  }
  for (const url of ['https://developer.chrome.com/docs/webstore', 'https://chrome.google.com.example.org/',
    'http://127.0.0.1:4000/', 'https://example.com/chromewebstore.google.com']) {
    assert.doesNotThrow(() => assertAutomationPage({ id: 1, url }));
  }
  assert.throws(() => assertAutomationPage({ id: 1, url: 'chrome://extensions' }), { code: 'UNSUPPORTED_PAGE' });
});

test('native Chrome errors distinguish Store restriction, actual debugger ownership, policy and unknown failure', () => {
  for (const [message, code] of [
    ['The extensions gallery cannot be scripted.', 'CHROME_STORE_RESTRICTED'],
    ['Another debugger is already attached to the tab with id: 12.', 'DEBUGGER_BUSY'],
    ['Debugger access is blocked by enterprise policy.', 'DEBUGGER_POLICY_BLOCKED'],
    ['Cannot attach to this target.', 'DEBUGGER_ATTACH_FAILED'],
  ]) assert.equal(debuggerAttachFailure(new Error(message)).code, code);
  const error = debuggerAttachFailure(new Error('secret synthetic-cookie-value https://example.com/?token=private'));
  assert.doesNotMatch(error.message, /synthetic-cookie-value|token=private/);
});

test('actual worker wiring uses access checks and does not report every attach failure as busy', async () => {
  const source = await readFile(new URL('../chrome-extension/background.js', import.meta.url), 'utf8');
  const access = source.slice(source.indexOf('function assertScriptable('), source.indexOf('\nasync function execute('));
  const command = source.slice(source.indexOf('async function debuggerCommand('), source.indexOf('\nfunction pushRing('));
  let attaches = 0;
  const context = vm.createContext({ assertAutomationPage, debuggerAttachFailure, attachedTabs: new Set(),
    chrome: { tabs: { async get(id) { return { id, url: 'https://example.com/' }; } },
      debugger: { async attach() { attaches++; throw Error('The extensions gallery cannot be scripted.'); } } } });
  vm.runInContext(`${access}\n${command}\nglobalThis.check=assertScriptable;globalThis.command=debuggerCommand;`, context);
  assert.throws(() => context.check({ id: 12, url: 'https://chrome.google.com/webstore/devconsole' }), { code: 'CHROME_STORE_RESTRICTED' });
  assert.equal(attaches, 0);
  await assert.rejects(context.command(12, 'Runtime.evaluate'), { code: 'CHROME_STORE_RESTRICTED' });
  assert.equal(attaches, 1);
});

test('native mode bridge explains known browser failures without publishing arbitrary error text', () => {
  for (const code of ['CHROME_STORE_RESTRICTED', 'DEBUGGER_BUSY', 'DEBUGGER_POLICY_BLOCKED', 'DEBUGGER_ATTACH_FAILED']) {
    const result = modeFailure(Object.assign(new Error('private credential value'), { code }));
    assert.equal(result.structuredContent.error_code, code);
    assert.ok(result.structuredContent.message.length > 20);
    assert.doesNotMatch(JSON.stringify(result), /private credential value/);
  }
  assert.equal(modeFailure(Object.assign(new Error('private'), { code: 'UNKNOWN_CODE' })).content[0].text, 'UNKNOWN_CODE');
});
