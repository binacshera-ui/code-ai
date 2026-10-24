import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultUrlTransform } from 'react-markdown';
import {
  buildHtmlFilePreviewUrl,
  buildMarkdownImageContentUrl,
  filePreviewDirectory,
  isHtmlFilePreview,
  markdownFileUrlTransform,
  parseLocalFileHref,
  withFileSourceServer,
} from './markdownFiles';

test('recognizes the representative CRM screenshot and decodes Hebrew paths once', () => {
  const path = '/root/projects/business/projects/05/design-lab/dab-crm/screenshots/crm-exact-rtl.png';
  assert.deepEqual(parseLocalFileHref(path), { rawPath: path });
  assert.deepEqual(parseLocalFileHref('/root/design/%D7%AA%D7%9E%D7%95%D7%A0%D7%94%20%D7%90.png'), { rawPath: '/root/design/תמונה א.png' });
  assert.deepEqual(parseLocalFileHref('/root/design/100%.png'), { rawPath: '/root/design/100%.png' });
  assert.deepEqual(parseLocalFileHref('/root/design/100%25.png'), { rawPath: '/root/design/100%.png' });
});

test('resolves relatives against the message session, not the app process directory', () => {
  assert.deepEqual(parseLocalFileHref('screenshots/crm.png', '/root/projects/design'), { rawPath: '/root/projects/design/screenshots/crm.png' });
  assert.deepEqual(parseLocalFileHref('../screenshots/./crm.png', '/root/projects/design'), { rawPath: '/root/projects/screenshots/crm.png' });
  assert.deepEqual(parseLocalFileHref('../../crm.png', '/root'), { rawPath: '/crm.png' });
  assert.deepEqual(parseLocalFileHref('./screenshots/crm.png'), { rawPath: './screenshots/crm.png' });
  assert.deepEqual(parseLocalFileHref('~/crm.png', '/root/projects'), { rawPath: '~/crm.png' });
  assert.deepEqual(parseLocalFileHref('/other/crm.png', '/root/projects'), { rawPath: '/other/crm.png' });
  assert.deepEqual(parseLocalFileHref('app.ts:12', '/root/projects'), { rawPath: '/root/projects/app.ts:12' });
  assert.deepEqual(parseLocalFileHref('README.md:12:3'), { rawPath: 'README.md:12:3' });
});

test('supports local file URIs and Windows absolute and relative paths', () => {
  assert.deepEqual(parseLocalFileHref('file:///root/demo%20file.html#L8'), { rawPath: '/root/demo file.html#L8' });
  assert.deepEqual(parseLocalFileHref('file://localhost/root/crm.png'), { rawPath: '/root/crm.png' });
  assert.deepEqual(parseLocalFileHref('file:///C:/Users/Dev/crm.png'), { rawPath: 'C:/Users/Dev/crm.png' });
  assert.deepEqual(parseLocalFileHref('C:\\Users\\Dev\\crm.png'), { rawPath: 'C:\\Users\\Dev\\crm.png' });
  assert.deepEqual(parseLocalFileHref('../crm.png', 'D:\\work\\design'), { rawPath: 'D:\\work\\crm.png' });
  assert.deepEqual(parseLocalFileHref('file://fileserver/shared/crm.png'), { rawPath: '\\\\fileserver\\shared\\crm.png' });
});

test('does not classify web links, protocol-relative URLs, API paths or unsafe schemes as files', () => {
  for (const value of [
    '', '#L2', '/api/codex/files/content?path=x', 'https://example.com/image.png',
    'HTTP://example.com/image.png', '//cdn.example.com/image.png', 'mailto:user@example.com',
    'tel:+1234', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/png;base64,AAAA',
    'vbscript:bad', 'blob:https://example.com/image', 'custom-protocol:thing',
    'file://user:password@fileserver/path', '/root/a%00.png', 'java\nscript:alert(1)',
  ]) assert.equal(parseLocalFileHref(value), null, value);
});

test('retains local schemes only for owned image/link renderers and preserves the default URL safety policy', () => {
  assert.equal(markdownFileUrlTransform('file:///root/crm.png', 'src'), 'file:///root/crm.png');
  assert.equal(markdownFileUrlTransform('C:/Users/Dev/demo.html', 'href'), 'C:/Users/Dev/demo.html');
  assert.equal(markdownFileUrlTransform('file:///root/crm.png', 'other'), '');
  for (const value of ['https://example.com/image.png', '//cdn.example.com/a.png', '#L3', '/api/codex/files/content?path=x', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    assert.equal(markdownFileUrlTransform(value, 'src'), defaultUrlTransform(value), value);
  }
});

test('builds authorized image URLs with explicit source server and cache-busting manual retries', () => {
  const url = new URL(buildMarkdownImageContentUrl('/root/תמונה & 100%.png', 'BEAM', 2), 'https://code.example');
  assert.equal(url.pathname, '/api/codex/files/content');
  assert.equal(url.searchParams.get('path'), '/root/תמונה & 100%.png');
  assert.equal(url.searchParams.get('server'), 'beam');
  assert.equal(url.searchParams.get('retry'), '2');
  assert.equal(new URL(buildMarkdownImageContentUrl('/root/crm.png', ''), 'https://code.example').searchParams.get('server'), 'local');
});

test('source-scopes file routes without leaking context to external or unrelated URLs', () => {
  assert.equal(withFileSourceServer('/api/codex/files/content?path=%2Froot%2Fa.png&server=wrong#page=2', 'beam'), '/api/codex/files/content?path=%2Froot%2Fa.png&server=beam#page=2');
  assert.equal(withFileSourceServer('/api/codex/files/download?path=%2Froot%2Fa.png', 'local'), '/api/codex/files/download?path=%2Froot%2Fa.png&server=local');
  assert.equal(withFileSourceServer('https://example.com/image.png', 'beam'), 'https://example.com/image.png');
  assert.equal(withFileSourceServer('/api/other', 'beam'), '/api/other');
});

test('nested Markdown files use their own directory including filesystem roots', () => {
  assert.equal(filePreviewDirectory('/root/design/readme.md'), '/root/design');
  assert.equal(filePreviewDirectory('/readme.md'), '/');
  assert.equal(filePreviewDirectory('C:\\readme.md'), 'C:\\');
  assert.equal(filePreviewDirectory('D:\\work\\readme.md'), 'D:\\work');
  assert.equal(filePreviewDirectory('readme.md'), null);
});

test('recognizes HTML rather than showing it solely as a code block', () => {
  assert.equal(isHtmlFilePreview({ extension: '.html', mimeType: 'text/html; charset=utf-8' }), true);
  assert.equal(isHtmlFilePreview({ extension: '.HTM', mimeType: 'text/plain' }), true);
  assert.equal(isHtmlFilePreview({ extension: '.txt', mimeType: 'text/html' }), true);
  assert.equal(isHtmlFilePreview({ extension: '.js', mimeType: 'text/javascript' }), false);
});

test('HTML asset route tokens preserve canonical Unicode filenames and source context', () => {
  const path = '/root/design/דמו קובץ.html';
  const source = `/api/codex/files/content?path=${encodeURIComponent(path)}&server=beam`;
  const result = buildHtmlFilePreviewUrl(source, 'BEAM');
  assert.ok(result);
  const pieces = result.split('/');
  assert.equal(pieces[5], 'beam');
  assert.equal(Buffer.from(pieces[6], 'base64url').toString('utf8'), path);
  assert.equal(decodeURIComponent(pieces[7]), 'דמו קובץ.html');
  assert.equal(new URL('styles/main.css', `https://code.example${result}`).pathname, `${result.slice(0, result.lastIndexOf('/') + 1)}styles/main.css`);
  assert.equal(buildHtmlFilePreviewUrl('https://example.com/demo.html', 'beam'), null);
  assert.equal(buildHtmlFilePreviewUrl('/api/codex/files/content?path=relative.html', 'beam'), null);
});
