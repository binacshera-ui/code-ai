import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { preserveRuntimeAuthentication, parseRuntimeEnvironment } from './runtime-auth.mjs';

async function fixture(t, suffix = '') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'code-ai-synthetic-auth-preservation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = 'const config = {deviceAdminPassword: process.env.CODEX_DEVICE_ADMIN_PASSWORD || "synthetic-device", sessionSecret: process.env.SESSION_SECRET || "synthetic-session"};' + suffix;
  const file = path.join(dir, 'predecessor.mjs');
  await writeFile(file, source, { mode: 0o600 });
  return { env: { CODE_AI_AUTH_BASELINE_MODULE: file,
    CODE_AI_AUTH_BASELINE_SHA256: createHash('sha256').update(source).digest('hex') } };
}
test('configured credentials remain byte-identical and need no fallback file', async () => {
  const env = { CODEX_DEVICE_ADMIN_PASSWORD: 'synthetic-explicit-device', SESSION_SECRET: 'synthetic-explicit-session' };
  const before = { ...env };
  assert.equal((await preserveRuntimeAuthentication(env)).preserved, true);
  assert.deepEqual(env, before);
});
test('both absent defaults are preserved privately from the exact predecessor', async t => {
  const f = await fixture(t); const result = await preserveRuntimeAuthentication(f.env);
  assert.equal(f.env.CODEX_DEVICE_ADMIN_PASSWORD, 'synthetic-device');
  assert.equal(f.env.SESSION_SECRET, 'synthetic-session');
  assert.equal(JSON.stringify(result).includes('synthetic-device'), false);
  assert.ok(result.fields.every(field => field.source === 'pinned_predecessor_default'));
});
test('an explicit signing secret survives filling only the absent device default', async t => {
  const f = await fixture(t); f.env.SESSION_SECRET = 'synthetic-current-signing';
  await preserveRuntimeAuthentication(f.env);
  assert.equal(f.env.SESSION_SECRET, 'synthetic-current-signing');
  assert.equal(f.env.CODEX_DEVICE_ADMIN_PASSWORD, 'synthetic-device');
});
test('missing baseline is refused without credentials in diagnostics', async () => {
  await assert.rejects(preserveRuntimeAuthentication({}), { reason: 'pinned_auth_baseline_required' });
});
test('changed predecessor is refused before any environment mutation', async t => {
  const f = await fixture(t); f.env.CODE_AI_AUTH_BASELINE_SHA256 = '0'.repeat(64);
  await assert.rejects(preserveRuntimeAuthentication(f.env), { reason: 'auth_baseline_changed' });
  assert.equal(f.env.CODEX_DEVICE_ADMIN_PASSWORD, undefined);
});
test('duplicate fallback fields are refused without committing even a valid earlier field', async t => {
  const f = await fixture(t, ' const duplicate = {sessionSecret: process.env.SESSION_SECRET || "synthetic-other"};');
  await assert.rejects(preserveRuntimeAuthentication(f.env), { reason: 'auth_default_shape_changed' });
  assert.equal(f.env.CODEX_DEVICE_ADMIN_PASSWORD, undefined);
});
test('private runtime parsing preserves values missing from nested PM2 metadata', () => {
  const stored = { HOME: '/synthetic/home', SESSION_SECRET: 'synthetic-old-metadata' };
  const actual = Buffer.from('HOME=/synthetic/home\0SESSION_SECRET=synthetic-live-signing\0DATABASE_URL=synthetic=value\0EMPTY=\0');
  const effective = { ...stored, ...parseRuntimeEnvironment(actual) };
  assert.equal(effective.SESSION_SECRET, 'synthetic-live-signing');
  assert.equal(effective.DATABASE_URL, 'synthetic=value');
  assert.equal(effective.EMPTY, '');
});
test('malformed runtime environment is refused without returning partial values', () => {
  assert.throws(() => parseRuntimeEnvironment(Buffer.from('SESSION_SECRET=synthetic\0bad-entry\0')),
    { reason: 'runtime_environment_shape_changed' });
});
test('old Node IPC descriptors are not propagated into a new PM2 CLI or child', () => {
  const actual = Buffer.from('SESSION_SECRET=synthetic-live\0NODE_CHANNEL_FD=3\0NODE_CHANNEL_SERIALIZATION_MODE=json\0NODE_UNIQUE_ID=synthetic-old-child\0');
  const parsed = parseRuntimeEnvironment(actual);
  assert.equal(parsed.SESSION_SECRET, 'synthetic-live');
  for (const key of ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'])
    assert.equal(Object.hasOwn(parsed, key), false);
});
