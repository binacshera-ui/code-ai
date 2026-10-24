import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, chmod, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexSharedSocket } from './codexSharedSocket.mjs';

async function fixture(t, symlinked = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-socket-'));
  await chmod(root, 0o700);
  const home = path.join(root, 'home');
  const canonicalParent = path.join(home, 'app-server-control');
  const targetParent = path.join(root, 'native');
  await mkdir(canonicalParent, { recursive: true, mode: 0o700 });
  await mkdir(targetParent, { mode: 0o700 });
  const canonical = path.join(canonicalParent, 'app-server-control.sock');
  const target = symlinked ? path.join(targetParent, 'owner.sock') : canonical;
  const server = createServer();
  server.listen(target);
  await once(server, 'listening');
  if (symlinked) await symlink(target, canonical);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, canonicalParent, targetParent, canonical, target };
}

test('accepts a private same-user direct native canonical socket', async t => {
  const f = await fixture(t);
  const endpoint = await resolveCodexSharedSocket(f.home, process.getuid());
  assert.equal(endpoint.socketPath, f.canonical);
  assert.equal(endpoint.resolvedSocketPath, f.target);
});

test('accepts the actual native private same-user symlink endpoint form', async t => {
  const f = await fixture(t, true);
  const endpoint = await resolveCodexSharedSocket(f.home, process.getuid());
  assert.equal(endpoint.socketPath, f.canonical);
  assert.equal(endpoint.resolvedSocketPath, f.target);
});

test('resolves an aliased CODEX_HOME without weakening endpoint checks', async t => {
  const f = await fixture(t, true);
  const alias = path.join(f.root, 'home-alias');
  await symlink(f.home, alias);
  assert.equal((await resolveCodexSharedSocket(alias, process.getuid())).codexHome, f.home);
});

for (const location of ['canonicalParent', 'targetParent']) {
  test(`rejects public ${location} even for a same-user native socket`, async t => {
    const f = await fixture(t, true);
    await chmod(f[location], 0o755);
    await assert.rejects(resolveCodexSharedSocket(f.home, process.getuid()), /canonical shared Codex owner is unavailable/);
  });
}

test('rejects a socket owned by a different runtime identity', async t => {
  const f = await fixture(t, true);
  await assert.rejects(resolveCodexSharedSocket(f.home, process.getuid() + 1), /no input was submitted/);
});

test('rejects missing endpoints with fixed non-sensitive diagnostics', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveCodexSharedSocket(path.join(root, 'not-present'), process.getuid()),
    error => error.message === 'The canonical shared Codex owner is unavailable; no input was submitted');
});

test('rejects dangling native symlinks without guessing or unlinking them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'app-server-control');
  await mkdir(parent, { mode: 0o700 });
  await symlink(path.join(root, 'not-present'), path.join(parent, 'app-server-control.sock'));
  await assert.rejects(resolveCodexSharedSocket(root, process.getuid()), /no input was submitted/);
});

test('rejects a regular file instead of a socket', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'app-server-control');
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path.join(parent, 'app-server-control.sock'), 'fixture');
  await assert.rejects(resolveCodexSharedSocket(root, process.getuid()), /no input was submitted/);
});

test('rejects an aliased endpoint parent, not just a public directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-ai-shared-socket-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetParent = path.join(root, 'native');
  await mkdir(targetParent, { mode: 0o700 });
  await symlink(targetParent, path.join(root, 'app-server-control'));
  const server = createServer();
  server.listen(path.join(targetParent, 'app-server-control.sock'));
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(resolveCodexSharedSocket(root, process.getuid()), /no input was submitted/);
});

for (const [home, uid] of [['relative/home', 0], ['/synthetic-home', -1], ['/synthetic-home', null]]) {
  test(`rejects malformed endpoint arguments (${String(uid)})`, async () => {
    await assert.rejects(resolveCodexSharedSocket(home, uid), /no input was submitted/);
  });
}

test('product owner is separate from and never replaces a native endpoint', async t => {
  const f = await fixture(t, true);
  const parent = path.join(f.home, 'code-ai-shared-owner');
  await mkdir(parent, {mode: 0o700});
  const product = path.join(parent, 'owner.sock');
  const server = createServer(); server.listen(product); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await resolveCodexSharedSocket(f.home, process.getuid(), true)).socketPath, product);
  assert.equal((await resolveCodexSharedSocket(f.home, process.getuid())).resolvedSocketPath, f.target);
  await chmod(parent, 0o755);
  await assert.rejects(resolveCodexSharedSocket(f.home, process.getuid(), true), /no input was submitted/);
});
