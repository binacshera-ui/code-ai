import test from 'node:test';
import assert from 'node:assert/strict';
import { withStaticExtensionPanel } from '../deploy/code-ai/static-ui-locations.mjs';
import { checkUiEntrypoints } from './check-ui-entrypoints.mjs';

const locations = `location ^~ /assets/ { root /srv/release/public; try_files $uri =404; }
location = /index.html { root /srv/release/public; try_files /index.html =404; }
location = /api/example { proxy_pass http://127.0.0.1:4002; }`;
test('panel follows the exact static release and leaves API and normal framing intact', () => {
  const result = withStaticExtensionPanel(locations);
  assert.ok(result.startsWith(locations));
  const panel = result.slice(result.indexOf('location = /extension-panel {'));
  assert.match(panel, /root \/srv\/release\/public;/);
  assert.match(panel, /try_files \/index.html =404;/);
  assert.match(panel, /frame-ancestors 'self' chrome-extension:/);
  assert.doesNotMatch(panel, /proxy_pass|add_header X-Frame-Options/);
  assert.match(panel, /Cache-Control "no-store/);
  assert.throws(() => withStaticExtensionPanel(result));
});
test('reject a split release, unsafe root or duplicate panel', () => {
  assert.throws(() => withStaticExtensionPanel(locations.replace('/srv/release/public', '/srv/other/public')));
  assert.throws(() => withStaticExtensionPanel(locations.replaceAll('/srv/release/public', '$root')));
  assert.throws(() => withStaticExtensionPanel(locations + '\nlocation = /extension-panel { proxy_pass http://old; }'));
});
function fixture({ splitPanel = false, assetStatus = 200, mime = 'text/css', frame = false } = {}) {
  return async url => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.css')) return new Response('body{}', { status: assetStatus, headers: { 'content-type': mime } });
    if (pathname.endsWith('.js')) return new Response('console.log(1)', { status: assetStatus, headers: { 'content-type': 'application/javascript' } });
    const panel = pathname === '/extension-panel';
    return new Response(`<script src="/assets/index-${splitPanel && panel ? 'old' : 'new'}.js"></script><link href="/assets/index-new.css">`, { headers: {
      'content-type': 'text/html', 'cache-control': 'no-store',
      ...(!panel || frame ? { 'x-frame-options': 'SAMEORIGIN' } : { 'content-security-policy': "frame-ancestors 'self' chrome-extension:" }),
    } });
  };
}
test('all supported entry points share the same HTML and correctly typed assets', async () => {
  const result = await checkUiEntrypoints('https://fixture.invalid', { fetchImpl: fixture() });
  assert.equal(result.passed, true); assert.equal(result.pages.length, 6); assert.equal(result.assets.length, 2);
});
test('gate catches the reported old panel shell even when the homepage works', async () => {
  await assert.rejects(checkUiEntrypoints('https://fixture.invalid', { fetchImpl: fixture({ splitPanel: true }) }), /different frontend releases/);
});
test('gate catches HTML stylesheet, missing bundle, and blocked frame', async () => {
  await assert.rejects(checkUiEntrypoints('https://fixture.invalid', { fetchImpl: fixture({ mime: 'text/html' }) }), /MIME/);
  await assert.rejects(checkUiEntrypoints('https://fixture.invalid', { fetchImpl: fixture({ assetStatus: 404 }) }), /asset unavailable/);
  await assert.rejects(checkUiEntrypoints('https://fixture.invalid', { fetchImpl: fixture({ frame: true }) }), /extension parent/);
});
