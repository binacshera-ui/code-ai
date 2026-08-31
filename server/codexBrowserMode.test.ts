import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureOverlaySymlink,
  normalizePersistedBrowserModeRecord,
} from './codexBrowserMode.js';

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

test('persisted browser sessions are rebased after the Code AI repository moves', () => {
  const legacyAppRoot = '/root/projects/legacy-monorepo/web/code-ai';
  const sessionDir = path.join(
    legacyAppRoot,
    '.code-ai/local/browser-mode/sessions/developer/session-123',
  );
  const record = normalizePersistedBrowserModeRecord({
    enabled: true,
    headless: true,
    profileSeed: 'seeded',
    customProfileDir: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    pendingDisableNotice: false,
    sessionDir,
    profileDir: path.join(sessionDir, 'profile'),
    screenshotsDir: path.join(sessionDir, 'screenshots'),
    artifactsDir: path.join(sessionDir, 'artifacts'),
    overlayCodexHome: path.join(sessionDir, 'codex-home-overlay'),
    pythonDir: path.join(legacyAppRoot, 'server/browser-mode/python'),
    serverScriptPath: path.join(legacyAppRoot, 'server/browser-mode/python/browser_mode_mcp_server.py'),
    runtimeScriptPath: path.join(legacyAppRoot, 'server/browser-mode/python/browser_mode_runtime.py'),
    extractorScriptPath: path.join(legacyAppRoot, 'server/browser-mode/python/browser_mode_extractor.py'),
  });

  assert.ok(record);
  assert.equal(record.sessionDir, path.join(
    process.cwd(),
    '.code-ai/local/browser-mode/sessions/developer/session-123',
  ));
  assert.equal(record.profileDir, path.join(record.sessionDir, 'profile'));
  assert.equal(record.serverScriptPath, path.join(
    process.cwd(),
    'server/browser-mode/python/browser_mode_mcp_server.py',
  ));
  assert.equal(record.sessionDir.includes(legacyAppRoot), false);
  assert.equal(record.serverScriptPath.includes(legacyAppRoot), false);
});
