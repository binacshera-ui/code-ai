#!/usr/bin/env node
// Launch the existing Codex binary with a separate home. Never write live config.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './runtime-paths.mjs';

const runtimeRoot = await resolveRuntime();
const settings = JSON.parse(await readFile(path.join(runtimeRoot, 'settings.json'), 'utf8'));
const token = (await readFile(path.join(runtimeRoot, 'gateway-key'), 'utf8')).trim();
const endpoint = `http://127.0.0.1:${settings.port}`;
const args = process.argv.slice(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function health() {
  try {
    const response = await fetch(`${endpoint}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
    });
    const body = await response.json();
    return response.ok && body.data?.some(row => row.id === settings.model);
  } catch { return false; }
}

async function start() {
  if (await health()) return;
  const lockFile = path.join(runtimeRoot, 'gateway-start.lock');
  let lock;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await health()) return;
    try { lock = await open(lockFile, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lockFile)).mtimeMs > 120000) await unlink(lockFile);
        else await pause(500);
      } catch (lockError) { if (lockError.code !== 'ENOENT') throw lockError; }
    }
  }
  if (!lock) throw new Error('Another isolated gateway start is still in progress');
  try {
    if (await health()) return;
    const cliEnv = parseEnv(await readFile(settings.keyFile, 'utf8'));
    if (!cliEnv.GEMINI_API_KEY) throw new Error('Gemini CLI API key is missing');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(name)));
    Object.assign(env, {
      GEMINI_API_KEY: cliEnv.GEMINI_API_KEY, CODEX_GEMINI_GATEWAY_KEY: token,
      LITELLM_TELEMETRY: 'False', LITELLM_LOG: 'ERROR', LITELLM_LOCAL_MODEL_COST_MAP: 'True',
      DO_NOT_TRACK: '1', PYTHONPATH: path.dirname(fileURLToPath(import.meta.url)),
      CODE_AI_GEMINI_RUNTIME: runtimeRoot,
    });
    const logPath = path.join(runtimeRoot, 'gateway.log');
    const log = await open(logPath, 'a', 0o600);
    await chmod(logPath, 0o600);
    const gateway = spawn(path.join(runtimeRoot, 'venv/bin/litellm'), [
      '--config', path.join(runtimeRoot, 'gateway.yaml'), '--host', '127.0.0.1',
      '--port', String(settings.port), '--num_workers', '1',
    ], { cwd: runtimeRoot, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    let spawnError;
    gateway.on('error', error => { spawnError = error; });
    gateway.unref();
    await log.close();
    if (gateway.pid) await writeFile(path.join(runtimeRoot, 'gateway.pid'), String(gateway.pid) + '\n', { mode: 0o600 });
    const deadline = Date.now() + 55000;
    while (Date.now() < deadline) {
      if (await health()) return;
      if (spawnError || gateway.exitCode !== null) throw new Error(`Gemini gateway did not start; see ${logPath}`);
      await pause(500);
    }
    throw new Error(`Gemini gateway is not ready; see ${logPath}`);
  } finally { await lock.close(); await unlink(lockFile); }
}

if (args[0] === '--status') {
  const protectedFiles = await Promise.all(settings.protectedFiles.map(async record => {
    let digest = null;
    try { digest = createHash('sha256').update(await readFile(record.file)).digest('hex'); } catch {}
    return { file: record.file, unchanged: digest === record.sha256 };
  }));
  console.log(JSON.stringify({ ready: await health(), model: settings.model, home: settings.home, endpoint, protectedFiles }, null, 2));
} else if (args[0] === '--stop-gateway') {
  const pid = Number((await readFile(path.join(runtimeRoot, 'gateway.pid'), 'utf8')).trim());
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  if (!argv.includes(path.join(runtimeRoot, 'venv/bin/litellm')) || !argv.includes(path.join(runtimeRoot, 'gateway.yaml'))) {
    throw new Error('Refusing to stop a process that is not this isolated gateway');
  }
  process.kill(pid, 'SIGTERM');
  console.log('Stopped the isolated Gemini gateway');
} else if (args[0] === '--gateway-only') {
  await start();
  console.log(`Gemini gateway ready at ${endpoint}; model ${settings.model}`);
} else {
  await start();
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(OPENAI_|GEMINI_API_KEY$|GOOGLE_API_KEY$|CODEX_|CODE_AI_SESSION_|CODE_AI_PROFILE_)/.test(name)));
  Object.assign(env, { CODEX_HOME: settings.home, CODEX_GEMINI_GATEWAY_KEY: token });
  const child = spawn(settings.codexBin, args, { env, stdio: 'inherit' });
  process.on('SIGTERM', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
  process.on('SIGINT', () => { if (child.exitCode === null) child.kill('SIGINT'); });
  child.on('error', () => { console.error('Could not launch the isolated Codex binary'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}
