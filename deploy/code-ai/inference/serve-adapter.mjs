#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const settings = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
const values = parseEnv(await readFile(settings.keyFile, 'utf8'));
if (!values.GEMINI_API_KEY) throw new Error('Gemini API key is unavailable');
const key = (await readFile(settings.gatewayKeyFile, 'utf8')).trim();
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].includes(name)));
Object.assign(env, {
  GEMINI_API_KEY: values.GEMINI_API_KEY, CODEX_GEMINI_GATEWAY_KEY: key,
  LITELLM_TELEMETRY: 'False', LITELLM_LOG: 'ERROR', LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  DO_NOT_TRACK: '1', PYTHONPATH: path.dirname(fileURLToPath(import.meta.url)), CODE_AI_GEMINI_RUNTIME: root,
});
const child = spawn(path.join(root, 'venv/bin/litellm'), ['--config', path.join(root, 'adapter.yaml'),
  '--host', '127.0.0.1', '--port', String(settings.adapterPort), '--num_workers', '1'], { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', () => { console.error('Could not start the Gemini adapter'); process.exitCode = 1; });
