import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const userHome = '/home/refael';
const serviceHome = userHome + '/.code-ai/remote-agent/ubuntu-gpu-lab';
if (process.platform !== 'linux' || os.hostname() !== 'gpu-lab' || os.userInfo().username !== 'refael') {
  throw new Error('UBUNTU_IDENTITY_MISMATCH');
}
const pairing = JSON.parse(await fs.readFile(serviceHome + '/pairing.json', 'utf8'));
if (pairing.id !== 'ubuntu-gpu-lab' || !['token', 'sessionSecret', 'devicePassword'].every(k => /^[a-f0-9]{64}$/.test(pairing[k]))) {
  throw new Error('INVALID_PRIVATE_PAIRING');
}
const storage = userHome + '/.code-ai-remote/ubuntu-gpu-lab';
const profiles = [{id: 'ubuntu-refael', label: 'Codex · Ubuntu gpu-lab', provider: 'codex',
  codexHome: userHome + '/.codex', workspaceCwd: userHome, defaultProfile: true}];
Object.assign(process.env, pairing.notifications || {}, {
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4010',
  PATH: userHome + '/.local/bin:' + userHome + '/.local/npm/bin:/usr/local/bin:/usr/bin:/bin',
  CODEX_APP_ROOT: root, CODEX_STORAGE_ROOT: storage, CODEX_QUEUE_ROOT: storage + '/queue',
  CODEX_UPLOAD_ROOT: storage + '/uploads', CODEX_LOG_ROOT: storage + '/logs',
  CODEX_OPEN_ACCESS: 'true', CODEX_ALLOW_ANY_PATHS: 'true', CODEX_REMOTE_AGENT_TOKEN: pairing.token,
  CODEX_SERVER_ID: pairing.id, CODEX_SERVER_LABEL: pairing.label,
  CODEX_DEVICE_ADMIN_PASSWORD: pairing.devicePassword, SESSION_SECRET: pairing.sessionSecret,
  CODEX_CLI_AUTO_UPDATE: 'false', CODEX_BIN: userHome + '/.local/npm/bin/codex',
  CODEX_PROFILES_JSON_BASE64: Buffer.from(JSON.stringify(profiles)).toString('base64'),
});
await import('./dist/server.js');
