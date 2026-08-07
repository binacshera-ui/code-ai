import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(appRoot, 'chrome-extension');

test('Chrome extension package is generic, complete, and load-unpacked compatible', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.side_panel.default_path, 'panel.html');
  for (const permission of ['debugger', 'declarativeNetRequest', 'scripting', 'sidePanel', 'tabs']) {
    assert.ok(manifest.permissions.includes(permission), `missing ${permission}`);
  }
  for (const file of ['background.js', 'contentScript.js', 'panel.html', 'panel.css', 'panel.js', 'icon-128.png', 'README.md']) {
    const metadata = await fs.stat(path.join(extensionRoot, file));
    assert.ok(metadata.size > 0, `${file} is empty`);
  }
  const source = await Promise.all(['manifest.json', 'background.js', 'contentScript.js', 'panel.html', 'panel.js']
    .map((file) => fs.readFile(path.join(extensionRoot, file), 'utf8')));
  const combined = source.join('\n');
  const panel = await fs.readFile(path.join(extensionRoot, 'panel.html'), 'utf8');
  assert.doesNotMatch(combined, /\/root\/projects\/|app-code-ai\./i);
  assert.match(combined, /browser_key/);
  assert.match(combined, /ENROLL_DEVICE/);
  assert.match(combined, /SYNC_ACTIVE_SESSION/);
  assert.match(combined, /CODE_AI_PICKER_PING/);
  assert.match(combined, /extension-panel/);
  assert.match(combined, /Control origin changed/);
  assert.match(combined, /settingsReady/);
  assert.match(combined, /code-ai:extension-ready/);
  assert.match(combined, /frameReady/);
  assert.doesNotMatch(panel, /pairing-code|pair-button|קוד חד/);
  assert.doesNotMatch(panel, /<script(?![^>]+src=)/i);
});
