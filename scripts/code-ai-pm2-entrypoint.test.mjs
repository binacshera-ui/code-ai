import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

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
