import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  buildProviderRunQueueKey,
  getProviderProcessSpawnOptions,
  terminateProviderProcessTree,
} from './providerProcessLifecycle.js';

test('new provider runs use independent queue keys while resumes serialize by session', () => {
  assert.equal(
    buildProviderRunQueueKey('developer', undefined, 'run-a'),
    'developer:__new__:run-a'
  );
  assert.equal(
    buildProviderRunQueueKey('developer', undefined, 'run-b'),
    'developer:__new__:run-b'
  );
  assert.equal(
    buildProviderRunQueueKey('developer', 'session-1', 'ignored-run-id'),
    'developer:session-1'
  );
});

async function waitForPidLine(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for grandchild pid')), 3_000);
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      const firstLine = stdout.split('\n')[0]?.trim();
      if (!/^\d+$/.test(firstLine)) {
        return;
      }
      clearTimeout(timeout);
      resolve(Number(firstLine));
    });
    child.once('error', reject);
  });
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    const processState = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return processState !== 'Z';
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

test('provider cancellation terminates the wrapper and its descendant process', {
  skip: process.platform === 'win32',
}, async () => {
  const child = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    'console.log(descendant.pid);',
    'setInterval(() => {}, 1000);',
  ].join('\n')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    ...getProviderProcessSpawnOptions(),
  });

  const descendantPid = await waitForPidLine(child);
  assert.equal(terminateProviderProcessTree(child, 100), true);

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (
    await isProcessRunning(child.pid!) || await isProcessRunning(descendantPid)
  )) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(await isProcessRunning(child.pid!), false, 'wrapper process remained active');
  assert.equal(await isProcessRunning(descendantPid), false, 'descendant process remained active');
});
