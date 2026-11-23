import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexFileSourceServer, resolveCodexPreviewAsset } from './codexFileAssets.js';
import type { CodexFileResolution } from './codexFileResolver.js';

const base = '/allowed/demo/index.html';
const token = Buffer.from(base).toString('base64url');
const record = (resolvedPath: string) => ({ kind: 'file', file: { resolvedPath } }) as CodexFileResolution;

test('file media routing is narrow, valid and source-specific', () => {
  assert.equal(readCodexFileSourceServer('GET', '/files/content', 'pci'), 'pci');
  assert.equal(readCodexFileSourceServer('HEAD', '/files/download', 'bm'), 'bm');
  assert.equal(readCodexFileSourceServer('GET', `/files/asset/pci/${token}/index.html`, undefined), 'pci');
  for (const route of ['/sessions', '/files/logs', '/files/preview', '/device-unlock']) {
    assert.equal(readCodexFileSourceServer('GET', route, 'pci'), '');
  }
  assert.equal(readCodexFileSourceServer('POST', '/files/content', 'pci'), '');
  assert.equal(readCodexFileSourceServer('GET', '/files/content', '../pci'), '');
});

test('HTML namespace authorizes the base and each nested asset', async () => {
  const lookedUp: string[] = [];
  const file = await resolveCodexPreviewAsset(token, 'screenshots/picture.png', async target => {
    lookedUp.push(target);
    return record(target);
  });
  assert.equal(file.resolvedPath, '/allowed/demo/screenshots/picture.png');
  assert.deepEqual(lookedUp, [base, '/allowed/demo/screenshots/picture.png']);
  assert.equal((await resolveCodexPreviewAsset(token, 'index.html', async target => record(target))).resolvedPath, base);
});

test('sandboxed JavaScript assets have an executable MIME type without changing source views', async () => {
  const asset = await resolveCodexPreviewAsset(token, 'nested/control.js', async target => ({
    kind: 'file', file: { resolvedPath: target, mimeType: 'text/plain; charset=utf-8' },
  }) as CodexFileResolution);
  assert.equal(asset.mimeType, 'application/javascript; charset=utf-8');
});

test('preview namespace rejects traversal, unrelated files, invalid token and symlink escapes', async () => {
  for (const relative of ['../credentials', '/etc/passwd', 'nested/../../elsewhere', 'a\\b', 'a\0b']) {
    await assert.rejects(resolveCodexPreviewAsset(token, relative, async target => record(target)));
  }
  for (const invalid of ['!', Buffer.from('relative.html').toString('base64url'), Buffer.from('/allowed/data.json').toString('base64url')]) {
    await assert.rejects(resolveCodexPreviewAsset(invalid, 'index.html', async target => record(target)));
  }
  await assert.rejects(resolveCodexPreviewAsset(token, 'link.png', async target => record(target === base ? base : '/outside/picture.png')));
  await assert.rejects(resolveCodexPreviewAsset(token, 'picture.png', async () => { throw new Error('Not authorized'); }));
});
