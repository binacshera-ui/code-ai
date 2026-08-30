import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureOverlaySymlink } from './codexBrowserMode.js';

async function readResolvedLink(targetPath: string) {
  const link = await fs.readlink(targetPath);
  return path.resolve(path.dirname(targetPath), link);
}

test('overlay symlink setup is idempotent under concurrent browser bootstraps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-browser-link-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'overlay', 'mcp-oauth-locks');
    await fs.mkdir(source, { recursive: true });
    await Promise.all(Array.from({ length: 32 }, () => ensureOverlaySymlink(target, source)));
    assert.equal(await readResolvedLink(target), source);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overlay symlink setup replaces an unexpected directory without touching the source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-browser-dir-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'overlay', 'mcp-oauth-locks');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'source-marker'), 'keep', 'utf8');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'stale-marker'), 'stale', 'utf8');
    await ensureOverlaySymlink(target, source);
    assert.equal(await readResolvedLink(target), source);
    assert.equal(await fs.readFile(path.join(source, 'source-marker'), 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('overlay symlink setup corrects a stale link target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-ai-browser-stale-'));
  try {
    const source = path.join(root, 'source');
    const staleSource = path.join(root, 'stale-source');
    const target = path.join(root, 'overlay', 'mcp-oauth-locks');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(staleSource, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(staleSource, target);
    await ensureOverlaySymlink(target, source);
    assert.equal(await readResolvedLink(target), source);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
