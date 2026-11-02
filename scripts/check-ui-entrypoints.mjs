import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');

/** Read-only release gate: never accept a healthy homepage with a broken panel. */
export async function checkUiEntrypoints(baseUrl, { fetchImpl = fetch } = {}) {
  const base = new URL(baseUrl);
  assert.ok(['http:', 'https:'].includes(base.protocol));
  assert.ok(!base.username && !base.password, 'Use an origin without credentials');
  const paths = ['/', '/index.html', '/chat', '/workbench', '/session/ui-release-check', '/extension-panel'];
  const pages = [];
  const assets = new Map();
  for (const pathname of paths) {
    const response = await fetchImpl(new URL(pathname, base), { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, `${pathname}: shell unavailable`);
    assert.match(response.headers.get('content-type') || '', /text\/html/i, `${pathname}: expected HTML`);
    assert.match(response.headers.get('cache-control') || '', /no-store/i, `${pathname}: shell must not be cached`);
    const html = await response.text();
    const references = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(js|css))["']/g)]
      .map(match => ({ path: match[1], kind: match[2] }));
    assert.ok(references.some(item => item.kind === 'js') && references.some(item => item.kind === 'css'), `${pathname}: missing entry assets`);
    if (pathname === '/extension-panel') {
      assert.equal(response.headers.get('x-frame-options'), null, 'Panel must allow the extension parent');
      assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors\s+'self'\s+chrome-extension:/i);
    } else {
      assert.match(response.headers.get('x-frame-options') || '', /SAMEORIGIN/i, `${pathname}: framing protection missing`);
    }
    for (const asset of references) assets.set(asset.path, asset.kind);
    pages.push({ path: pathname, sha256: digest(html), assets: references.map(item => item.path) });
  }
  assert.equal(new Set(pages.map(page => page.sha256)).size, 1, 'Entry points are serving different frontend releases');
  const checks = [];
  for (const [pathname, kind] of assets) {
    const response = await fetchImpl(new URL(pathname, base), { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, `${pathname}: asset unavailable`);
    const contentType = response.headers.get('content-type') || '';
    assert.match(contentType, kind === 'css' ? /text\/css/i : /(?:java|ecma)script/i, `${pathname}: invalid asset MIME type`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0, `${pathname}: empty asset`);
    checks.push({ path: pathname, contentType, bytes: bytes.length, sha256: digest(bytes) });
  }
  return { format: 'code-ai-ui-entrypoint-check', version: 1, passed: true, origin: base.origin, pages, assets: checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/check-ui-entrypoints.mjs ORIGIN');
    console.log(JSON.stringify(await checkUiEntrypoints(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
