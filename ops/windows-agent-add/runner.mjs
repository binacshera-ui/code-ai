import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.dirname(fileURLToPath(import.meta.url));
const home = 'C:/Users/showp';
const pairingPath = path.join(home, '.code-ai/remote-agent/pairing.json');
if (process.platform !== 'win32' || os.hostname().toUpperCase() !== 'ME'
  || os.userInfo().username !== 'showp') throw new Error('WINDOWS_IDENTITY_MISMATCH');
const pairing = JSON.parse(await fs.readFile(pairingPath, 'utf8'));
if (pairing.id !== 'personal-windows-me' || !/^[a-f0-9]{64}$/.test(pairing.token)
  || !/^[a-f0-9]{64}$/.test(pairing.sessionSecret)) throw new Error('INVALID_AGENT_PAIRING');
const state = path.join(home, '.code-ai-remote', pairing.id);
const profiles = [{ id: 'windows-me-codex', label: 'Codex · המחשב החדש ME', provider: 'codex',
  codexHome: path.join(home, '.codex'), workspaceCwd: home, defaultProfile: true }];
const environment = { ...process.env, ...(pairing.notifications || {}),
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4010',
  CODEX_APP_ROOT: app, CODEX_STORAGE_ROOT: state,
  CODEX_QUEUE_ROOT: path.join(state, 'queue'), CODEX_UPLOAD_ROOT: path.join(state, 'uploads'),
  CODEX_LOG_ROOT: path.join(state, 'logs'), CODEX_OPEN_ACCESS: 'true', CODEX_ALLOW_ANY_PATHS: 'true',
  CODEX_REMOTE_AGENT_TOKEN: pairing.token, CODEX_SERVER_ID: pairing.id,
  CODEX_SERVER_LABEL: pairing.label, SESSION_SECRET: pairing.sessionSecret,
  CODEX_DEVICE_ADMIN_PASSWORD: pairing.devicePassword, CODEX_CLI_AUTO_UPDATE: 'false',
  CODEX_BIN: pairing.codexBin, CODEX_PROFILES_JSON_BASE64: Buffer.from(JSON.stringify(profiles)).toString('base64'),
};
let stopping = false;
let child;
const statusFile = path.join(home, '.code-ai/remote-agent/status.json');
async function status(value) { await fs.writeFile(statusFile, JSON.stringify({ at: new Date().toISOString(), ...value })); }
function start() {
  if (stopping) return;
  child = spawn(process.execPath, [path.join(app, 'dist/server.js')],
    { cwd: app, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Avoid printing server output or credentials; retain only exit metadata.
  child.stdout.resume(); child.stderr.resume();
  child.once('spawn', () => { void status({ state: 'running', pid: child.pid }); });
  child.once('error', () => { void status({ state: 'spawn-failed' }); });
  child.once('exit', (code, signal) => {
    void status({ state: 'exited', code, signal });
    if (!stopping) setTimeout(start, 5000);
  });
}
process.on('SIGINT', () => { stopping = true; child?.kill('SIGINT'); });
process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); });
start();
