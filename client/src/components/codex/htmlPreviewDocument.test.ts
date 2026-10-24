import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHtmlPreviewContext,
  cssPreviewUrlReferences,
  escapeHtmlPreviewRawText,
  hasHtmlPreviewModuleImports,
  HtmlPreviewLimitError,
  htmlPreviewNamespace,
  htmlPreviewAssetKind,
  htmlPreviewSrcsetCandidates,
  inlineHtmlPreviewCss,
  resolveHtmlPreviewDependency,
} from './htmlPreviewDocument';

const origin = 'https://code.example';
const namespace = '/api/codex/files/asset/beam/dG9rZW4/';
const entry = `${namespace}demo.html`;

function contextFor(files: Record<string, string | Uint8Array>, limits = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  const context = createHtmlPreviewContext({
    assetUrl: entry, origin, signal: controller.signal, limits,
    fetchFile: async (url, init) => {
      requests.push({ url, init });
      const value = files[url];
      const type = /\.css$/.test(url) ? 'text/css' : /\.html?$/.test(url) ? 'text/html'
        : /\.woff2?$/.test(url) ? 'font/woff2' : /\.png$/.test(url) ? 'image/png' : 'text/javascript';
      return value === undefined ? new Response('Not found', { status: 404 }) : new Response(value, { headers: { 'content-type': type } });
    },
  });
  return { context, requests, controller };
}

test('authenticated namespace must be the selected server and canonical directory token', () => {
  assert.equal(htmlPreviewNamespace(entry, origin), namespace);
  assert.equal(htmlPreviewNamespace('https://external.example' + entry, origin), null);
  assert.equal(htmlPreviewNamespace('/api/codex/files/content?path=x', origin), null);
  assert.equal(htmlPreviewNamespace('/api/codex/files/asset/beam/bad%2Ftoken/a.css', origin), null);
});

test('relative nested assets resolve only within their authorized HTML directory', () => {
  assert.deepEqual(resolveHtmlPreviewDependency('../images/crm.png', `${namespace}css/main.css`, namespace, origin), { kind: 'local', url: `${namespace}images/crm.png` });
  assert.deepEqual(resolveHtmlPreviewDependency('/images/crm.png', entry, namespace, origin), { kind: 'local', url: `${namespace}images/crm.png` });
  assert.deepEqual(resolveHtmlPreviewDependency('./icons.svg?v=1&server=wrong#crm', entry, namespace, origin), { kind: 'local', url: `${namespace}icons.svg#crm` });
  for (const value of ['../secret.png', '%2e%2e/secret.png', '/api/codex/auth/status', '/api/codex/files/content?path=/etc/passwd', 'javascript:alert(1)', 'file:///etc/passwd', 'nested%2fsecret.png', 'nested%5csecret.png', 'http://external.example/x.png']) {
    assert.equal(resolveHtmlPreviewDependency(value, entry, namespace, origin).kind, 'blocked', value);
  }
});

test('safe HTTPS resources are preserved for the sandbox, never fetched by the authenticated parent', async () => {
  const { context, requests } = contextFor({});
  assert.deepEqual(context.dependency('https://cdn.example/app.js', entry, 'script'), { kind: 'external', url: 'https://cdn.example/app.js' });
  assert.equal(context.dependency('//cdn.example/style.css', entry, 'style').kind, 'external');
  assert.equal(context.dependency('data:image/png;base64,AAAA', entry).kind, 'embedded');
  assert.equal(context.dependency('#icon', entry).kind, 'embedded');
  await assert.rejects(context.fetchAsset('https://cdn.example/app.js'), /directory-scoped/);
  await assert.rejects(context.fetchAsset('/api/codex/sessions'), /directory-scoped/);
  assert.equal(requests.length, 0);
  assert.match(context.csp(), /script-src 'unsafe-inline' data: blob: https:\/\/cdn.example/);
  assert.match(context.csp(), /connect-src 'none'/);
  assert.match(context.csp(), /base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(context.csp(), /code.example|unsafe-eval|allow-same-origin/);
});

test('parent file fetch carries cancellation, same-origin credentials, no redirect and caches repeated dependencies', async () => {
  const { context, requests, controller } = contextFor({ [entry]: '<html>hello</html>' });
  const first = await context.fetchAsset(entry);
  const second = await context.fetchAsset(`${entry}#fragment`);
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.redirect, 'error');
});

test('binary images become bounded data URLs instead of unauthorized opaque iframe requests', async () => {
  const image = `${namespace}crm.png`;
  const { context, requests } = contextFor({ [image]: new Uint8Array([137, 80, 78, 71]) });
  assert.equal(await context.inlineAsset(image), 'data:image/png;base64,iVBORw==');
  assert.equal(await context.inlineAsset(`${image}#icon`), 'data:image/png;base64,iVBORw==#icon');
  assert.equal(requests.length, 1);
});

test('secret/plaintext siblings and wrong resource kinds are rejected before authenticated fetch', async () => {
  const { context, requests } = contextFor({ [`${namespace}.env`]: 'secret', [`${namespace}config.json`]: '{"secret":true}' });
  for (const name of ['.env', 'config.json', 'password.txt', 'secret.pem']) {
    assert.equal(htmlPreviewAssetKind(`${namespace}${name}`), null);
    await assert.rejects(context.fetchAsset(`${namespace}${name}`), /file type/);
    assert.equal(await context.optional(() => context.inlineAsset(`${namespace}${name}`), ''), '');
  }
  await assert.rejects(context.fetchAsset(`${namespace}app.js`, 'embedded'), /file type/);
  await assert.rejects(context.fetchAsset(`${namespace}style.css`, 'script'), /file type/);
  assert.equal(requests.length, 0);
});

test('renamed plaintext dependencies fail MIME validation before their bytes can enter srcDoc', async () => {
  const context = createHtmlPreviewContext({ assetUrl: entry, origin, signal: new AbortController().signal,
    fetchFile: async () => new Response('secret plaintext', { headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(context.fetchAsset(`${namespace}image.png`, 'embedded'), /MIME/);
  await assert.rejects(context.fetchAsset(`${namespace}style.css`, 'style'), /MIME/);
  await assert.rejects(context.fetchAsset(`${namespace}app.js`, 'script'), /MIME/);
});

test('PostCSS inlines imports/media rules and resolves CSS images and font URLs from each stylesheet directory', async () => {
  const main = `${namespace}styles/main.css`;
  const theme = `${namespace}styles/theme/base.css`;
  const image = `${namespace}images/crm.png`;
  const font = `${namespace}fonts/hebrew.woff2`;
  const { context, requests } = contextFor({
    [theme]: '@font-face {font-family:hebrew;src:url("../../fonts/hebrew.woff2")} .title{color:purple}',
    [image]: new Uint8Array([1, 2, 3]),
    [font]: new Uint8Array([4, 5, 6]),
  });
  const result = await inlineHtmlPreviewCss('@import "theme/base.css" screen; .hero{background:url(../images/crm.png)}', main, context);
  assert.match(result, /@media screen/);
  assert.match(result, /font-family:hebrew/);
  assert.match(result, /data:font\/woff2;base64,BAUG/);
  assert.match(result, /data:image\/png;base64,AQID/);
  assert.doesNotMatch(result, /\/api\/codex|@import/);
  assert.deepEqual(new Set(requests.map((request) => request.url)), new Set([theme, font, image]));
});

test('CSS import cycles stop, and unsupported layer imports report partial output truthfully', async () => {
  const a = `${namespace}a.css`;
  const b = `${namespace}b.css`;
  const { context, requests } = contextFor({ [a]: '@import "b.css"; .a{color:red}', [b]: '@import "a.css"; .b{color:blue}' });
  const result = await inlineHtmlPreviewCss('@import "b.css"; .a{color:red}', a, context);
  assert.match(result, /\.a/);
  assert.match(result, /\.b/);
  assert.ok([...context.warnings].some((warning) => warning.includes('מעגלי')));
  assert.equal(requests.length, 2);
  await inlineHtmlPreviewCss('@import "b.css" layer(theme);', a, context);
  assert.ok([...context.warnings].some((warning) => warning.includes('layer/supports')));
});

test('CSS lexical URL rewriting ignores comments and ordinary strings, handles escapes and inline declarations', async () => {
  const value = '/* url(fake.png) */ content:"url(fake.png)"; background:URL("image\\20 name.png");mask:url(#icon)';
  assert.deepEqual(cssPreviewUrlReferences(value).map((reference) => reference.value), ['image name.png', '#icon']);
  const { context } = contextFor({});
  assert.equal(await inlineHtmlPreviewCss('color:red;direction:rtl', entry, context), 'color:red;direction:rtl');
  assert.match(await inlineHtmlPreviewCss('color:red;background:url(../secret.png)', entry, context), /url\(""\)/);
});

test('local missing dependencies report partial preview but memory and asset limits are fatal', async () => {
  const { context } = contextFor({});
  assert.equal(await context.optional(() => context.fetchAsset(`${namespace}missing.css`), null), null);
  assert.equal(context.warnings.size, 1);
  const tooLarge = contextFor({ [entry]: '12345' }, { maxAssetBytes: 4 }).context;
  await assert.rejects(tooLarge.fetchAsset(entry), HtmlPreviewLimitError);
  const tooMany = contextFor({ [entry]: '1' }, { maxAssets: 1 }).context;
  await tooMany.fetchAsset(entry);
  await assert.rejects(tooMany.fetchAsset(`${namespace}other.css`), HtmlPreviewLimitError);
  const tooMuch = contextFor({ [entry]: '123', [`${namespace}b.css`]: '456' }, { maxTotalBytes: 5 }).context;
  await tooMuch.fetchAsset(entry);
  await assert.rejects(tooMuch.fetchAsset(`${namespace}b.css`), HtmlPreviewLimitError);
  const output = contextFor({}, { maxInlineBytes: 3 }).context;
  assert.throws(() => output.reserveInline('1234'), HtmlPreviewLimitError);
});

test('aborted source loads do not fetch or turn cancellation into a partial preview success', async () => {
  const { context, controller, requests } = contextFor({ [entry]: '<html />' });
  controller.abort();
  await assert.rejects(context.fetchAsset(entry), { name: 'AbortError' });
  await assert.rejects(context.optional(() => context.fetchAsset(entry), null), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('fetched raw-text delimiters are escaped while preserving JavaScript string contents and tag casing', () => {
  assert.equal(escapeHtmlPreviewRawText('const s = "</SCRIPT><img src=x>";', 'script'), 'const s = "<\\/SCRIPT><img src=x>";');
  assert.equal(escapeHtmlPreviewRawText('x{content:"</style>"}', 'style'), 'x{content:"<\\/style>"}');
});

test('local module dependency graphs and dynamic imports are explicit unsupported cases', () => {
  for (const source of ["import './helper.js'", "import { render } from './helper.js'", "import render from './helper.js'", "export { render } from './helper.js'", "import('./helper.js')"]) assert.equal(hasHtmlPreviewModuleImports(source), true, source);
  assert.equal(hasHtmlPreviewModuleImports("document.querySelector('button').onclick = () => {};"), false);
  assert.equal(hasHtmlPreviewModuleImports('export const answer = 42;'), false);
});

test('srcset parsing preserves embedded data commas and density descriptors', () => {
  assert.deepEqual(htmlPreviewSrcsetCandidates('crm.png 1x, crm-large.png 2x'), [{ url: 'crm.png', descriptor: '1x' }, { url: 'crm-large.png', descriptor: '2x' }]);
  assert.deepEqual(htmlPreviewSrcsetCandidates('data:image/png;base64,AAAA 1x, crm.png 2x'), [{ url: 'data:image/png;base64,AAAA', descriptor: '1x' }, { url: 'crm.png', descriptor: '2x' }]);
});
