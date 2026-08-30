#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OLD_ROOT = '/root/projects/bina-cshera/web/code-ai';
const NEW_ROOT = '/root/projects/code-ai';
const APP_NAME = 'code-ai-app';
const PM2_BIN = '/root/.nvm/versions/node/v24.12.0/bin/pm2';
const OLD_ECOSYSTEM = path.join(OLD_ROOT, 'ecosystem.config.cjs');
const NEW_ECOSYSTEM = path.join(NEW_ROOT, 'ecosystem.config.cjs');
const QUEUE_FILE = path.join(OLD_ROOT, '.code-ai/queue/state.json');
const STATUS_FILE = path.join(NEW_ROOT, '.code-ai/ops/path-cutover.status.json');
const LOCK_FILE = '/run/lock/code-ai-path-cutover.lock';
const HEALTH_URL = 'http://127.0.0.1:4000/';
const POLL_MS = 5_000;
const STABLE_MS = 45_000;
const SCHEDULED_GUARD_MS = 60_000;
const HEALTH_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function updateStatus(state, details = {}) {
  writeJsonAtomic(STATUS_FILE, {
    state,
    sourceRoot: OLD_ROOT,
    targetRoot: NEW_ROOT,
    sourcePreserved: true,
    watcherPid: process.pid,
    updatedAt: new Date().toISOString(),
    ...details,
  });
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.closeSync(descriptor);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      try {
        if (Number.isInteger(existingPid) && existingPid > 0) {
          process.kill(existingPid, 0);
          throw new Error(`Cutover watcher already running with PID ${existingPid}`);
        }
      } catch (processError) {
        if (processError?.code !== 'ESRCH') throw processError;
      }
      fs.unlinkSync(LOCK_FILE);
    }
  }
  throw new Error('Could not acquire cutover watcher lock');
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`Lock cleanup warning: ${error.message}`);
  }
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PM2_HOME: process.env.PM2_HOME || '/root/.pm2' },
    ...options,
  });
}

async function listPm2() {
  const { stdout } = await run(PM2_BIN, ['jlist']);
  return JSON.parse(stdout);
}

async function readPm2App() {
  const processInfo = (await listPm2()).find((entry) => entry?.name === APP_NAME);
  if (!processInfo) return null;
  return {
    pid: Number(processInfo.pid) || 0,
    status: processInfo.pm2_env?.status || 'unknown',
    cwd: processInfo.pm2_env?.pm_cwd || '',
    execPath: processInfo.pm2_env?.pm_exec_path || '',
    appRoot: processInfo.pm2_env?.CODEX_APP_ROOT || '',
    storageRoot: processInfo.pm2_env?.CODEX_STORAGE_ROOT || '',
    workspaceRoot: processInfo.pm2_env?.CODEX_WORKSPACE_ROOT || '',
  };
}

function readChildPids(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return raw ? raw.split(/\s+/).map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function readCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function isAgentCommand(commandLine) {
  const executable = path.basename(commandLine[0] || '').toLowerCase();
  if (['codex', 'claude', 'gemini'].includes(executable)) return true;
  return commandLine.some((argument) => {
    const normalized = String(argument).toLowerCase();
    return normalized.includes('@anthropic-ai/claude-code')
      || normalized.includes('@google/gemini-cli')
      || /(?:^|\/)(?:codex|claude|gemini)(?:\.js)?$/.test(normalized);
  });
}

function findAgentDescendants(rootPid) {
  const agents = [];
  const pending = [...readChildPids(rootPid)];
  const visited = new Set();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (!Number.isInteger(pid) || visited.has(pid)) continue;
    visited.add(pid);
    const commandLine = readCommandLine(pid);
    if (isAgentCommand(commandLine)) agents.push(pid);
    pending.push(...readChildPids(pid));
  }
  return agents;
}

function readQueueSummary() {
  const state = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const items = Array.isArray(state?.items) ? state.items : [];
  const counts = {};
  const now = Date.now();
  let blockers = 0;
  for (const item of items) {
    const status = typeof item?.status === 'string' ? item.status : 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    if (['queued', 'running', 'cancelling'].includes(status)) {
      blockers += 1;
    } else if (status === 'scheduled') {
      const scheduledAt = new Date(item.scheduledAt).getTime();
      if (!Number.isFinite(scheduledAt) || scheduledAt <= now + SCHEDULED_GUARD_MS) blockers += 1;
    }
  }
  return { counts, blockers };
}

async function inspectIdle() {
  const app = await readPm2App();
  if (!app || app.status !== 'online' || app.pid <= 0) {
    throw new Error(`Expected live ${APP_NAME}; found ${app?.status || 'missing'}`);
  }
  const queue = readQueueSummary();
  const agentPids = findAgentDescendants(app.pid);
  return { idle: queue.blockers === 0 && agentPids.length === 0, queue, agentCount: agentPids.length, app };
}

function assertPreconditions() {
  for (const requiredPath of [OLD_ECOSYSTEM, NEW_ECOSYSTEM, QUEUE_FILE, path.join(NEW_ROOT, 'dist/server.js')]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Required path is missing: ${requiredPath}`);
  }
  if (fs.realpathSync(OLD_ROOT) === fs.realpathSync(NEW_ROOT)) {
    throw new Error('Source and target resolve to the same directory');
  }
}

async function syncApplicationSource() {
  await run('rsync', [
    '-aH',
    '--exclude=/.git/',
    '--exclude=/.code-ai/',
    '--exclude=/node_modules/',
    '--exclude=/dist/',
    '--exclude=/dist.before-*/',
    '--exclude=/.venv/',
    '--exclude=/.playwright-browsers/',
    '--exclude=/codex-mobile-legacy-from-web-app/',
    '--exclude=/.gitignore',
    '--exclude=/.env.paths',
    '--exclude=/.env.paths.example',
    '--exclude=/ecosystem.config.cjs',
    '--exclude=/server/config.ts',
    '--exclude=/server/incidentDecisionCenter.ts',
    '--exclude=/ops/',
    `${OLD_ROOT}/`,
    `${NEW_ROOT}/`,
  ]);
}

async function syncRuntimeState() {
  await run('rsync', [
    '-aH',
    '--exclude=/ops/restart-when-idle.mjs',
    '--exclude=/ops/path-cutover.status.json',
    '--exclude=/ops/path-cutover.log',
    '--exclude=/deploy-ntfy-after-drain.sh',
    `${OLD_ROOT}/.code-ai/`,
    `${NEW_ROOT}/.code-ai/`,
  ]);
}

async function waitForTargetHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'not checked';
  while (Date.now() < deadline) {
    try {
      const app = await readPm2App();
      if (!app || app.status !== 'online') throw new Error(`PM2 status is ${app?.status || 'missing'}`);
      if (app.cwd !== NEW_ROOT) throw new Error(`PM2 cwd is still ${app.cwd}`);
      if (app.execPath !== path.join(NEW_ROOT, 'scripts/code-ai-pm2-entrypoint.mjs')) {
        throw new Error(`PM2 entrypoint is still ${app.execPath}`);
      }
      if (app.appRoot !== NEW_ROOT || app.storageRoot !== path.join(NEW_ROOT, '.code-ai')) {
        throw new Error('PM2 target path environment is incomplete');
      }
      const rootResponse = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
      if (!rootResponse.ok) throw new Error(`Root returned ${rootResponse.status}`);
      const index = await rootResponse.text();
      const assetPath = index.match(/src="(\/assets\/[^"?]+\.js)"/)?.[1];
      if (!assetPath) throw new Error('Hashed application asset was not found in the index');
      const assetResponse = await fetch(new URL(assetPath, HEALTH_URL), { signal: AbortSignal.timeout(5_000) });
      if (!assetResponse.ok) throw new Error(`Hashed asset returned ${assetResponse.status}`);
      const unknownResponse = await fetch(new URL('/api/__path_cutover_probe__', HEALTH_URL), {
        signal: AbortSignal.timeout(5_000),
      });
      const contentType = unknownResponse.headers.get('content-type') || '';
      if (unknownResponse.status !== 404 || !contentType.includes('application/json')) {
        throw new Error(`Unknown API contract mismatch (${unknownResponse.status}, ${contentType})`);
      }
      return app;
    } catch (error) {
      lastError = error.message;
      await sleep(1_000);
    }
  }
  throw new Error(`Target did not become healthy: ${lastError}`);
}

async function startEcosystem(ecosystemFile) {
  await run(PM2_BIN, ['start', ecosystemFile, '--only', APP_NAME, '--update-env']);
}

async function removePm2Registration() {
  const app = await readPm2App();
  if (app) await run(PM2_BIN, ['delete', APP_NAME]);
}

async function rollbackToSource(reason) {
  log(`Target verification failed; restoring source runtime: ${reason}`);
  await removePm2Registration().catch(() => {});
  await startEcosystem(OLD_ECOSYSTEM);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const app = await readPm2App().catch(() => null);
    if (app?.status === 'online' && app.cwd === OLD_ROOT) {
      const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (response?.ok) return app;
    }
    await sleep(1_000);
  }
  throw new Error('Automatic rollback did not restore a healthy source runtime');
}

async function cutover() {
  acquireLock();
  let sourceStopped = false;
  const startedAt = Date.now();
  let idleSince = null;
  let previousSummary = '';
  try {
    assertPreconditions();
    const current = await readPm2App();
    if (current?.status === 'online' && current.cwd === NEW_ROOT) {
      updateStatus('complete', { note: 'Target was already active', currentPid: current.pid });
      return;
    }
    updateStatus('armed', { stableWindowMs: STABLE_MS, waitTimeoutMs: WAIT_TIMEOUT_MS });
    log('Armed; source remains live while waiting for a stable idle window');

    while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
      const inspection = await inspectIdle();
      const summary = JSON.stringify({ blockers: inspection.queue.blockers, agents: inspection.agentCount, counts: inspection.queue.counts });
      if (summary !== previousSummary) {
        log(`Runtime state: ${summary}`);
        previousSummary = summary;
      }
      if (!inspection.idle) {
        idleSince = null;
        updateStatus('waiting', { queueCounts: inspection.queue.counts, blockers: inspection.queue.blockers, agentCount: inspection.agentCount });
        await sleep(POLL_MS);
        continue;
      }
      if (idleSince === null) idleSince = Date.now();
      const quietForMs = Date.now() - idleSince;
      updateStatus('stabilizing', { quietForMs, requiredQuietMs: STABLE_MS });
      if (quietForMs < STABLE_MS) {
        await sleep(Math.min(POLL_MS, STABLE_MS - quietForMs));
        continue;
      }

      updateStatus('preparing-target');
      log('Stable idle reached; refreshing target source, build and runtime state');
      await syncApplicationSource();
      await run('npm', ['run', 'build'], { cwd: NEW_ROOT });
      await syncRuntimeState();
      await sleep(3_000);
      const finalInspection = await inspectIdle();
      if (!finalInspection.idle) {
        log('New work arrived during preparation; returning to drain mode');
        idleSince = null;
        continue;
      }

      updateStatus('stopping-source', { previousPid: finalInspection.app.pid });
      log(`Gracefully stopping source PID ${finalInspection.app.pid}`);
      await run(PM2_BIN, ['stop', APP_NAME]);
      sourceStopped = true;

      updateStatus('final-state-sync');
      await syncRuntimeState();
      await removePm2Registration();

      updateStatus('starting-target');
      await startEcosystem(NEW_ECOSYSTEM);
      updateStatus('verifying-target');
      const target = await waitForTargetHealth();
      await run(PM2_BIN, ['save']);
      updateStatus('complete', {
        previousPid: finalInspection.app.pid,
        currentPid: target.pid,
        completedAt: new Date().toISOString(),
      });
      log(`Cutover verified: ${OLD_ROOT} -> ${NEW_ROOT}; source directory preserved`);
      return;
    }
    throw new Error(`Timed out after ${WAIT_TIMEOUT_MS}ms while waiting for idle`);
  } catch (error) {
    if (sourceStopped) {
      try {
        const rollback = await rollbackToSource(error.message);
        updateStatus('failed-rolled-back', { error: error.stack || error.message, rollbackPid: rollback.pid });
      } catch (rollbackError) {
        updateStatus('failed-rollback-failed', {
          error: error.stack || error.message,
          rollbackError: rollbackError.stack || rollbackError.message,
        });
      }
    } else {
      updateStatus('failed-source-untouched', { error: error.stack || error.message });
    }
    throw error;
  } finally {
    releaseLock();
  }
}

if (process.argv.includes('--inspect')) {
  const inspection = await inspectIdle();
  process.stdout.write(`${JSON.stringify({
    idle: inspection.idle,
    queue: inspection.queue,
    agentCount: inspection.agentCount,
    pm2: { status: inspection.app.status, pid: inspection.app.pid, cwd: inspection.app.cwd },
  }, null, 2)}\n`);
} else {
  await cutover();
}
