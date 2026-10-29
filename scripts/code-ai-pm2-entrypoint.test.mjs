import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';

function waitForOutput(readOutput, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const inspect = () => {
      if (pattern.test(readOutput())) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for output matching ${pattern}`));
        return;
      }
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

test('waits for an occupied production port before importing the server', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'code-ai-pm2-entrypoint-'));
  const targetModule = path.join(temporaryRoot, 'target.mjs');
  await writeFile(targetModule, 'console.log("test-target-imported");\n', 'utf8');

  const occupiedServer = net.createServer();
  await new Promise((resolve, reject) => {
    occupiedServer.once('error', reject);
    occupiedServer.listen(0, '127.0.0.1', resolve);
  });
  const address = occupiedServer.address();
  assert(address && typeof address === 'object');

  const child = spawn(process.execPath, ['scripts/code-ai-pm2-entrypoint.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(address.port),
      CODE_AI_PM2_PORT_WAIT_MS: '25',
      CODE_AI_PM2_TARGET_MODULE: targetModule,
      CODE_AI_PM2_ACTIVATION_FILE: path.join(temporaryRoot, 'absent-activation.json'),
      CODEX_STORAGE_ROOT: temporaryRoot,
      CODEX_QUEUE_ROOT: path.join(temporaryRoot, 'queue'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await waitForOutput(() => output, /waiting without starting a duplicate/u);
    assert.doesNotMatch(output, /test-target-imported/u);
    await new Promise((resolve) => occupiedServer.close(resolve));
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 0, output);
    assert.match(output, /is available; starting code-ai/u);
    assert.match(output, /test-target-imported/u);
  } finally {
    occupiedServer.close();
    child.kill('SIGKILL');
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function startupFixture(t, activationChanges, prepare, additionalEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'code-ai-pm2-activation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fallback = path.join(directory, 'fallback.mjs');
  const successor = path.join(directory, 'successor.mjs');
  const companion = path.join(directory, 'companion.mjs');
  const activationFile = path.join(directory, 'activation.json');
  const payload = 'console.log("verified-successor-imported");\n';
  const companionPayload = 'export const value = 1;\n';
  const sha = content => createHash('sha256').update(content).digest('hex');
  await writeFile(fallback, 'console.log("fallback-imported");\n', { mode: 0o644 });
  await writeFile(successor, payload, { mode: 0o644 });
  await writeFile(companion, companionPayload, { mode: 0o644 });
  const activation = { format: 'code-ai-pm2-runtime-activation', version: 1,
    targetModule: successor, targetSha256: sha(payload),
    integrity: [{ file: companion, sha256: sha(companionPayload) }], ...activationChanges };
  await writeFile(activationFile, JSON.stringify(activation), { mode: 0o600 });
  if (prepare) await prepare({ directory, activationFile });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['scripts/code-ai-pm2-entrypoint.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HOST: '127.0.0.1',
      PORT: String(port), CODE_AI_PM2_TARGET_MODULE: fallback,
      CODE_AI_PM2_ACTIVATION_FILE: activationFile, CODEX_STORAGE_ROOT: directory,
      CODEX_QUEUE_ROOT: path.join(directory, 'queue'), CODE_AI_PM2_REQUIRE_ACTIVATION: '0',
      ...additionalEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = await new Promise(resolve => child.once('exit', resolve));
  return { exit, output };
}

test('private hash-pinned activation selects the successor without changing default target', async t => {
  const result = await startupFixture(t);
  assert.equal(result.exit, 0, result.output);
  assert.match(result.output, /verified-successor-imported/);
  assert.doesNotMatch(result.output, /fallback-imported/);
});

test('hash mismatch fails closed rather than reopening stale queue state', async t => {
  const result = await startupFixture(t, { targetSha256: '0'.repeat(64) });
  assert.equal(result.exit, 1, result.output);
  assert.match(result.output, /integrity check failed/);
  assert.doesNotMatch(result.output, /fallback-imported|verified-successor-imported/);
});

test('invalid activation shape fails closed before either target imports', async t => {
  const result = await startupFixture(t, { targetModule: 'relative.mjs' });
  assert.equal(result.exit, 1, result.output);
  assert.match(result.output, /activation pointer is invalid/);
  assert.doesNotMatch(result.output, /fallback-imported|verified-successor-imported/);
});

test('the integrity closure cannot silently omit hashes for declared companions', async t => {
  const result = await startupFixture(t, { integrity: [{ file: '/tmp/untrusted-worker.mjs' }] });
  assert.equal(result.exit, 1, result.output);
  assert.match(result.output, /integrity closure is invalid/);
  assert.doesNotMatch(result.output, /fallback-imported|verified-successor-imported/);
});

test('missing activation pointer cannot reopen a stale runtime after SQLite migration', async t => {
  const result = await startupFixture(t, undefined, async ({ directory, activationFile }) => {
    await unlink(activationFile);
    await mkdir(path.join(directory, 'queue'));
    await writeFile(path.join(directory, 'queue', 'queue.sqlite'), 'synthetic-presence-marker');
  }, { CODE_AI_PM2_REQUIRE_ACTIVATION: '1' });
  assert.equal(result.exit, 1, result.output);
  assert.match(result.output, /SQLite queue requires its private runtime activation pointer/);
  assert.doesNotMatch(result.output, /fallback-imported|verified-successor-imported/);
});

test('portable SQLite installations can restart the configured bundle without a private activation pointer', async t => {
  const result = await startupFixture(t, undefined, async ({ directory, activationFile }) => {
    await unlink(activationFile);
    await mkdir(path.join(directory, 'queue'));
    await writeFile(path.join(directory, 'queue', 'queue.sqlite'), 'synthetic-presence-marker');
  });
  assert.equal(result.exit, 0, result.output);
  assert.match(result.output, /fallback-imported/);
});
